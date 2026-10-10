import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort, forgetGateReadings, READ_ONLY } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { createFindTool } from '../sdk/src/platform/tools/find/executor.ts';
import { createAnalyzeTool } from '../sdk/src/platform/tools/analyze/index.ts';
import { capturedInputTool, assertCapturedToolInvocationCurrent } from '../sdk/src/platform/tools/shared/captured-input-tools.ts';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.ts';
import { createContractInputAuthority } from '../sdk/src/platform/contract/input-authority.ts';
import type { Contract } from '../sdk/src/platform/contract/types.ts';

const roots: string[] = [];
afterEach(() => { forgetGateReadings(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
function latch() { return Promise.withResolvers<void>(); }

for (const name of ['find', 'analyze'] as const) for (const captured of [false, true]) for (const revoked of [false, true]) {
  test(`real admitted ${name} ${captured ? 'captured wrapper' : 'ordinary executor'} ${revoked ? 'stops after owner revocation during directory reading' : 'retains a valid invocation'}`, async () => {
    forgetGateReadings();
    const root = mkdtempSync(join(tmpdir(), 'gv-walk-admission-')); roots.push(root);
    mkdirSync(join(root, 'src/nested'), { recursive: true });
    writeFileSync(join(root, 'src/nested/owned-marker.txt'), 'owned needle');
    let view = root;
    let directory = root;
    const config = {
      getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory }),
      getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
      getWorkingDirectory: () => directory, isAutoApproveEnabled: () => false,
    } as PermissionConfigReader;
    const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
    const registry = new ToolRegistry(manager);
    const started = latch(); const release = latch();
    const gate = gateReadingsPort([['', READ_ONLY]]);
    const autonomous = fakePort((_key, question) => choiceAnswer(question, 'act', 0.99));
    const directories = fakePort((key, _question, state) => {
      const candidate = (state as { directories: { id: string; name: string }[] }).directories.find(value => value.id === key)!;
      return noulAnswer(candidate.name.startsWith('.') ? 0.99 : 0.01);
    });
    const port: JudgmentPort = { ...gate.port, async ask(request) {
      request.beforeAttempt?.();
      if (request.context?.battery === 'engine.walk.skip-directory') {
        started.resolve(); await release.promise; return directories.port.ask(request);
      }
      return 'disposition' in request.questions ? autonomous.port.ask(request) : gate.port.ask(request);
    } };
    const log = new SqliteDecisionLog(':memory:');
    const previous = installJudgmentPort(withDecisionLog(port, log));
    let pending: ReturnType<typeof executeToolCalls> | undefined;
    try {
      let authority: Awaited<ReturnType<typeof createContractInputAuthority>> | undefined;
      if (captured) {
        git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Michael Davis'); git(root, 'config', 'user.email', 'mgd34msu@gmail.com');
        writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
        git(root, 'add', '.'); git(root, 'commit', '-qm', 'directory admission fixture');
        const snapshot = await captureContractInput(root); view = contractInputPath(snapshot);
        git(root, 'worktree', 'add', '--no-checkout', '-b', 'directory-admission-view', view, snapshot.inputCommit);
        await materializeContractInput(snapshot, view);
        authority = await createContractInputAuthority({ inputSnapshot: snapshot, projectRoot: root } as Contract, view);
      }
      const raw = name === 'find' ? createFindTool(view) : createAnalyzeTool({ chat: async () => '{}' }, undefined, view);
      const reads: string[] = [];
      const tool = authority ? capturedInputTool(raw, authority, view, async path => { reads.push(path); return true; }, undefined) : raw;
      registry.register(tool);
      const deps: ToolExecutionDeps = {
        autonomousSource: () => ({ goal: 'Read the owned fixture tree', criteria: ['Keep current directory selection and authority'] }),
        permissionManager: manager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null,
        sessionId: 'directory-admission', emitterContext: () => ({ sessionId: 'directory-admission', traceId: 'synthetic', source: 'orchestrator' }),
      };
      const args = name === 'find' ? { queries: [{ id: 'q', mode: 'content', pattern: 'needle' }] } : { mode: 'dependencies' };
      pending = executeToolCalls(deps, 'walk-admission-turn', [{ id: 'walk-admission-call', name, arguments: args }]);
      await Promise.race([started.promise, pending.then(result => { throw new Error(`No directory reading: ${JSON.stringify(result)}`); })]);
      if (revoked) directory = join(root, 'changed-owner-root');
      release.resolve();
      const result = await pending;
      expect(result[0]?.success).toBe(!revoked);
      if (revoked) {
        expect(directories.requests).toHaveLength(1);
        expect(result[0]?.output).toBeUndefined();
        expect(reads.some(path => path.endsWith('owned-marker.txt'))).toBe(false);
      } else {
        expect(result[0]?.output).toContain('owned-marker.txt');
        expect(directories.requests.length).toBeGreaterThan(1);
      }
    } finally {
      release.resolve(); await pending?.catch(() => {});
      installJudgmentPort(previous); log[Symbol.dispose]();
    }
  });
}


for (const revoked of [false, true]) {
  test(`cheap captured checkpoint uses original admitted invocation ${revoked ? 'after revocation' : 'while current'}`, async () => {
    forgetGateReadings();
    const root = mkdtempSync(join(tmpdir(), 'gv-walk-cheap-admission-')); roots.push(root);
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Michael Davis'); git(root, 'config', 'user.email', 'mgd34msu@gmail.com');
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n'); writeFileSync(join(root, 'owned.txt'), 'owned');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'cheap checkpoint fixture');
    const snapshot = await captureContractInput(root); const view = contractInputPath(snapshot);
    git(root, 'worktree', 'add', '--no-checkout', '-b', 'cheap-admission-view', view, snapshot.inputCommit);
    await materializeContractInput(snapshot, view);
    const authority = await createContractInputAuthority({ inputSnapshot: snapshot, projectRoot: root } as Contract, view);
    let directory = root;
    const config = {
      getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory }),
      getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
      getWorkingDirectory: () => directory, isAutoApproveEnabled: () => false,
    } as PermissionConfigReader;
    const manager = new PermissionManager(undefined, config, new PolicyRuntimeState());
    const registry = new ToolRegistry(manager);
    const gate = gateReadingsPort([['', READ_ONLY]]);
    const autonomous = fakePort((_key, question) => choiceAnswer(question, 'act', 0.99));
    const log = new SqliteDecisionLog(':memory:');
    const previous = installJudgmentPort(withDecisionLog({ ...gate.port, ask(request) {
      return 'disposition' in request.questions ? autonomous.port.ask(request) : gate.port.ask(request);
    } }, log));
    let reached = false; let held = false;
    try {
      registry.register(capturedInputTool({ definition: createFindTool(view).definition, async execute() {
        reached = true; assertCapturedToolInvocationCurrent();
        if (revoked) directory = join(root, 'changed-owner-root');
        try { assertCapturedToolInvocationCurrent(); } catch { held = true; }
        return { success: true, output: 'current checkpoint result' };
      } }, authority, view, async () => true, undefined));
      const deps: ToolExecutionDeps = {
        autonomousSource: () => ({ goal: 'Read owned files', criteria: ['Keep invocation authority'] }),
        permissionManager: manager, toolRegistry: registry, hookDispatcher: null, runtimeBus: null,
        sessionId: 'cheap-admission', emitterContext: () => ({ sessionId: 'cheap-admission', traceId: 'synthetic', source: 'orchestrator' }),
      };
      const result = await executeToolCalls(deps, 'cheap-turn', [{ id: 'cheap-call', name: 'find', arguments: { queries: [{ id: 'q', mode: 'files' }] } }]);
      expect(reached).toBe(true); expect(held).toBe(revoked); expect(result[0]?.success).toBe(!revoked);
      if (revoked) expect(result[0]?.output).toBeUndefined();
    } finally { installJudgmentPort(previous); log[Symbol.dispose](); }
  });
}
