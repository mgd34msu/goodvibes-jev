import { test, expect, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/index.js';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/bootstrap.js';
import { createRuntimeStore, RuntimeEventBus } from '../sdk/src/platform/runtime/state.js';
import { createLaunchTolerantProviderRegistry } from '../sdk/src/platform/providers/index.js';
import { captureContractInput, materializeContractInput, contractInputPath } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { installJudgmentPort } from '../errors/src/index.js';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

for (const viewKind of ['snapshot', 'member'] as const) {
  for (const access of ['denied', 'allowed', 'revoked', 'cancelled', 'missing', 'forged', 'alias', 'policy-revoked'] as const) {
  for (const workflow of ['find', 'read', 'write-read'] as const) {
    if (viewKind === 'snapshot' && workflow === 'write-read') continue;
    if (access !== 'denied' && access !== 'allowed' && workflow !== 'find') continue;
    test(`actual ${viewKind} Agent ${workflow} preserves stored original-path ${access}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'captured-authority-'));
      git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
      writeFileSync(join(root, 'private.ts'), 'export const SYNTHETIC_PRIVATE_MARKER = "fixture only";\n');
      writeFileSync(join(root, 'allowed.ts'), 'export const SYNTHETIC_ALLOWED_MARKER = "fixture only";\n');
      git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
      const snapshot = await captureContractInput(root);
      const view = viewKind === 'snapshot' ? contractInputPath(snapshot) : join(root, '.goodvibes', '.worktrees', 'contract', 'member-fixture');
      const branch = `${viewKind}-fixture`;
      git(root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--no-checkout', '-b', branch, view, snapshot.inputCommit);
      await materializeContractInput(snapshot, view);
      const contract = { inputSnapshot: snapshot, projectRoot: root } as Contract;
      const stop = new AbortController();
      const authority = await createContractInputAuthority(contract, view, { signal: stop.signal, mutable: viewKind === 'member', branch });
      const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
      config.set('permissions.engine', 'policy-engine'); config.set('permissions.mode', 'prompt'); config.set('behavior.autoApprove', false);
      const runtime = createClientRuntimeServices({ surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), modelDiscovery: 'skip', providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }) });
      await runtime.userPermissionRuleStore.add({ rule: { id: 'deny-original-private', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [join(root, 'private.ts')] }, createdAt: Date.now(), tier: 'path', tool: 'read' });
      const previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
      expect(await runtime.permissionManager.readAccess(join(root, 'private.ts'))).toBe('restricted');
      expect(await runtime.permissionManager.readAccess(join(root, 'allowed.ts'))).toBe('allow');
      const requests: string[] = [];
      const opened: string[] = [];
      const syncRead = fs.readFileSync;
      const readTap = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => { opened.push(String(args[0])); return syncRead(...args); }) as typeof fs.readFileSync);
      let policyChange: Promise<void> | undefined;
      const file = Bun.file;
      const tap = spyOn(Bun, 'file').mockImplementation(((...args: Parameters<typeof Bun.file>) => { opened.push(String(args[0]));
        if (access === 'policy-revoked' && String(args[0]) === join(view, 'allowed.ts') && !policyChange) policyChange = runtime.userPermissionRuleStore.add({ rule: { id: 'revoke-original-allowed', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [join(root, 'allowed.ts')] }, createdAt: Date.now(), tier: 'path', tool: 'read' });
        return file(...args); }) as typeof Bun.file);
      let calls = 0;
      const target = access === 'denied' ? 'private.ts' : workflow === 'write-read' ? 'generated.ts' : 'allowed.ts';
      const toolSteps = workflow === 'find'
        ? [{ id: 'find-file', name: 'find', arguments: { queries: [{ id: 'files', mode: 'files', patterns: [target] }], output: { format: 'with_preview', preview_lines: 5 } } }]
        : workflow === 'read'
          ? [{ id: 'read-file', name: 'read', arguments: { files: [{ path: target }] } }]
          : [{ id: 'write-file', name: 'write', arguments: { files: [{ path: target, mode: 'overwrite', content: 'export const SYNTHETIC_ALLOWED_MARKER = 1;\n' }] } }, { id: 'read-file', name: 'read', arguments: { files: [{ path: target }] } }];
      runtime.providerRegistry.registerRuntimeProvider({ provider: { name: 'snapshot-fixture', models: ['fixture'], isConfigured: () => true, async chat(...input: unknown[]) {
        requests.push(JSON.stringify(input)); calls++;
        return { content: calls <= toolSteps.length ? '' : 'done', toolCalls: calls <= toolSteps.length ? [toolSteps[calls - 1]!] : [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: calls <= toolSteps.length ? 'tool_call' : 'completed' };
      } }, models: [{ id: 'fixture', provider: 'snapshot-fixture', registryKey: 'snapshot-fixture:fixture', displayName: 'Fixture', description: 'Synthetic', capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false }, contextWindow: 4096, selectable: true, tier: 'standard' }], replace: true });
      await runtime.providerRegistry.ready();
      let done!: () => void;
      const settled = new Promise<void>((resolve) => { done = resolve; });
      let failure: unknown;
      runtime.agentManager.setExecutor({ async runAgent(record) { try { await runtime.agentOrchestrator.runAgent(record); } catch (error) { failure = error; throw error; } finally { done(); } } });
      let id: string | undefined;
      try {
        if (access === 'revoked') revokeContractInputAuthority(authority);
        if (access === 'cancelled') stop.abort();
        const alias = join(root, 'view-alias');
        if (access === 'alias') symlinkSync(view, alias, 'dir');
        const input = { mode: 'spawn', outsideContract: true, template: 'planner', task: 'Inspect the fixture using find', tools: workflow === 'write-read' ? ['write', 'read'] : [workflow], restrictTools: true, workingDirectory: access === 'alias' ? alias : view, model: 'snapshot-fixture:fixture', provider: 'snapshot-fixture', executionIntent: { filesystemPolicy: workflow === 'write-read' ? 'workspace-write' : 'read-only', networkPolicy: 'deny', riskClass: 'safe' } } as const;
        if (access === 'forged') {
          expect(() => runtime.agentManager.spawn({ ...input, tools: [...input.tools] }, { inputReadAuthority: { kind: 'contract-input-authority' } })).toThrow('unrecognized contract input authority');
          expect(calls).toBe(0); return;
        }
        const record = runtime.agentManager.spawn({ ...input, tools: [...input.tools] }, access === 'missing' || access === 'alias' ? undefined : { inputReadAuthority: authority });
        id = record.id;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([settled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('agent did not settle')), 10_000); })]); } finally { if (timer) clearTimeout(timer); }
        await policyChange;
        const beforeAdmission = ['revoked', 'cancelled', 'missing', 'alias'].includes(access);
        if (beforeAdmission) expect(failure).toBeDefined(); else expect(failure).toBeUndefined();
        expect(calls).toBe(beforeAdmission ? 0 : access === 'policy-revoked' ? 1 : toolSteps.length + 1);
        expect(requests.some((request) => request.includes('SYNTHETIC_PRIVATE_MARKER'))).toBe(false);
        expect(opened).not.toContain(join(view, 'private.ts'));
        if (access === 'policy-revoked') expect(requests.some((request) => request.includes('SYNTHETIC_ALLOWED_MARKER'))).toBe(false);
        if (access === 'allowed') {
          if (workflow === 'find') expect(opened).toContain(join(view, 'allowed.ts'));
          expect(requests.some((request) => request.includes('SYNTHETIC_ALLOWED_MARKER'))).toBe(true);
        }
      } finally {
        tap.mockRestore(); readTap.mockRestore(); if (id) runtime.agentManager.cancel(id); stop.abort(); runtime.dispose(); installJudgmentPort(previous); rmSync(root, { recursive: true, force: true });
      }
    }, 20_000);
  }
  }
}
