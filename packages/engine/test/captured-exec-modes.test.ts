import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.js';
import { ProcessManager } from '../sdk/src/platform/tools/shared/process-manager.js';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.js';
import { createCapturedExecNodeRuntimeAdmission } from '../sdk/src/platform/tools/exec/captured-exec-runtime-input.js';
import { startCapturedBackground } from '../sdk/src/platform/tools/exec/captured-exec-background.js';
import { runCapturedCommand, probeCapturedExecAvailability } from '../sdk/src/platform/tools/exec/captured-exec.js';
import { detectPtyAvailability, probePtyHost } from '../sdk/src/platform/tools/exec/interactive.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { useToolReadings } from './_helpers/tool-readings.js';
useToolReadings([['CAPTURE_PROMPT', { awaitingInput: true }]]);
const supported = (await probeCapturedExecAvailability()).available;
test('required captured mode capability cannot silently skip', () => {
  if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT !== undefined) {
    expect(process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT).toBe('1');
    expect(supported).toBe(true);
    expect(detectPtyAvailability(probePtyHost()).available).toBe(true);
  }
});
const roots: string[] = [];
const managers: ProcessManager[] = [];
afterEach(async () => { for (const manager of managers.splice(0)) await manager.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]) { const result = spawnSync('git', ['-C', root, ...args]); if (result.status) throw new Error(result.stderr.toString()); }
async function fixture(nodeRuntime = false) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-modes-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, 'source.txt'), 'captured source'); git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner); const root = contractInputPath(inputSnapshot);
  git(owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch: `input/${inputSnapshot.id}` });
  const manager = new ProcessManager(); managers.push(manager);
  const base = { authority, root, readAccessFilter: async () => true };
  const binding = { ...base, nodeRuntimeAdmission: nodeRuntime ? createCapturedExecNodeRuntimeAdmission(base) : undefined };
  const tool = createExecTool(manager, { capturedInput: binding, defaultWorkingDirectory: root, overflowHandler: new OverflowHandler({ baseDir: root }),
    interaction: { availability: detectPtyAvailability(probePtyHost()), quietWindowMs: 30, requestPromptAnswer: async () => ({ answered: true, text: 'synthetic-answer' }) } });
  return { owner, root, authority, manager, tool, binding };
}
const output = (result: { output?: string | undefined }) => JSON.parse(result.output ?? '{}') as { stdout?: string; success?: boolean; process_id?: string; pty?: boolean; prompts_answered?: number };
async function waitUntil(predicate: () => boolean | Promise<boolean>) { const deadline = Date.now() + 5000; while (!await predicate()) { if (Date.now() > deadline) throw new Error('fixture did not settle'); await new Promise((r) => setTimeout(r, 20)); } }

for (const mode of ['background', 'interactive'] as const)
  test.skipIf(!supported)(`captured ${mode} commands consume the shared direct Node admission`, async () => {
    const f = await fixture(true);
    const result = await f.tool.execute({ commands: [{
      cmd: `node -e 'console.log("DIRECT_NODE_MODE"); require("node:fs").writeFileSync("node-mode.txt", "${mode}")'`,
      [mode]: true,
      timeout_ms: 10000,
    }] });
    expect(result.success, result.output ?? result.error).toBe(true);
    if (mode === 'background') {
      const id = output(result).process_id!;
      expect(id).toBeString();
      await waitUntil(() => f.manager.getStatus(id)?.done === true);
      const completed = await f.tool.execute({ commands: [{ cmd: `bg_output ${id}` }] });
      expect(completed.success, completed.output ?? completed.error).toBe(true);
      expect(output(completed).stdout).toContain('DIRECT_NODE_MODE');
    } else {
      expect(output(result).pty).toBe(true);
      expect(output(result).stdout).toContain('DIRECT_NODE_MODE');
    }
    expect(readFileSync(join(f.root, 'node-mode.txt'), 'utf8')).toBe(mode);
    expect(existsSync(join(f.owner, 'node-mode.txt'))).toBe(false);
  });

test.skipIf(!supported)('captured background job has live scoped output, commits on completion, and never uses host spawn', async () => {
  const f = await fixture();
  const started = await f.tool.execute({ commands: [{ cmd: 'echo READY; sleep 0.3; echo built > built.txt; echo DONE', background: true }] });
  expect(started.success).toBe(true); const id = output(started).process_id!; expect(id).toBeString(); expect(id).toMatch(/^bg_owned_[a-j_]+$/);
  await waitUntil(async () => output(await f.tool.execute({ commands: [{ cmd: `bg_output ${id}` }] })).stdout?.includes('READY') === true);
  expect(f.manager.getOutput(id)).toEqual({ stdout: '', stderr: '' });
  const other = await fixture();
  const otherTool = createExecTool(f.manager, { capturedInput: other.binding, defaultWorkingDirectory: other.root, overflowHandler: new OverflowHandler({ baseDir: other.root }) });
  expect((await otherTool.execute({ commands: [{ cmd: `bg_output ${id}` }] })).success).toBe(false);
  expect((await otherTool.execute({ commands: [{ cmd: `bg_stop ${id}` }] })).success).toBe(false);
  await waitUntil(() => f.manager.getStatus(id)?.done === true);
  expect(readFileSync(join(f.root, 'built.txt'), 'utf8')).toBe('built\n');
  expect(existsSync(join(f.owner, 'built.txt'))).toBe(false);
  expect(output(await f.tool.execute({ commands: [{ cmd: `bg_output ${id}` }] })).stdout).toContain('DONE');
});

for (const stop of ['bg_stop', 'close', 'revoke'] as const)
  test.skipIf(!supported)(`captured background ${stop} owns termination and withholds delayed writes`, async () => {
    const f = await fixture();
    const started = await f.tool.execute({ commands: [{ cmd: 'echo READY; sleep 1; echo late > late.txt', background: true }] });
    const id = output(started).process_id!;
    if (stop === 'bg_stop') expect((await f.tool.execute({ commands: [{ cmd: `bg_stop ${id}` }] })).success).toBe(true);
    else if (stop === 'close') await f.manager.close();
    else { revokeContractInputAuthority(f.authority); await waitUntil(() => f.manager.getStatus(id)?.done === true); }
    await new Promise((r) => setTimeout(r, 1100));
    expect(existsSync(join(f.root, 'late.txt'))).toBe(false);
  });

test.skipIf(!supported)('captured PTY uses existing prompt/answer flow inside the boundary', async () => {
  const f = await fixture();
  const result = await f.tool.execute({ commands: [{ cmd: 'test -t 0 && printf "CAPTURE_PROMPT: "; read answer; printf "answered=%s\\n" "$answer"; echo edited > pty.txt', interactive: true, timeout_ms: 5000 }] });
  expect(result.success).toBe(true); expect(output(result).pty).toBe(true);
  expect(output(result).stdout).toContain('answered=synthetic-answer'); expect(output(result).prompts_answered).toBe(1);
  expect(readFileSync(join(f.root, 'pty.txt'), 'utf8')).toBe('edited\n');
});

for (const kill of [true, false])
  test.skipIf(!supported)(`captured until match ${kill ? 'terminates' : 'promotes an owned job'}`, async () => {
    const f = await fixture();
    const result = await f.tool.execute({ commands: [{ cmd: 'echo READY; sleep 1; echo late > late.txt', until: { pattern: 'READY', kill_after: kill, timeout_ms: 2000 } }] });
    expect(result.success).toBe(true); expect(output(result).stdout).toContain('READY');
    if (!kill) { const id = output(result).process_id!; expect(id).toBeString(); await f.tool.execute({ commands: [{ cmd: `bg_stop ${id}` }] }); }
    expect(existsSync(join(f.root, 'late.txt'))).toBe(false);
  });

test.skipIf(!supported)('captured file_ops run once before a batch and preserve mapped results', async () => {
  const f = await fixture();
  const result = await f.tool.execute({ file_ops: [{ op: 'copy', source: 'source.txt', destination: 'copy.txt' }], commands: [{ cmd: 'cat copy.txt' }, { cmd: 'test -f copy.txt' }] });
  expect(result.success).toBe(true);
  expect(result.output).toContain(join(f.root, 'copy.txt'));
  expect(readFileSync(join(f.root, 'copy.txt'), 'utf8')).toBe('captured source');
  expect(existsSync(join(f.owner, 'copy.txt'))).toBe(false);
  expect((await f.tool.execute({ file_ops: [{ op: 'copy', source: join(f.owner, 'source.txt'), destination: 'escape.txt' }], commands: [{ cmd: 'true' }] })).success).toBe(false);
  expect(existsSync(join(f.root, 'escape.txt'))).toBe(false);
});

test.skipIf(!supported)('retained background output cannot overwrite a newer member edit', async () => {
  const f = await fixture();
  const started = await f.tool.execute({ commands: [{ cmd: 'sleep 0.4; echo job > source.txt', background: true }] });
  const id = output(started).process_id!;
  writeFileSync(join(f.root, 'source.txt'), 'newer member edit');
  await waitUntil(() => f.manager.getStatus(id)?.done === true);
  expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('newer member edit');
  expect((await f.tool.execute({ commands: [{ cmd: `bg_output ${id}` }] })).success).toBe(false);
});

test.skipIf(!supported)('cancelled PTY cannot accept a late prompt answer or publish output', async () => {
  const f = await fixture();
  let answer!: (value: { answered: boolean; text: string }) => void;
  let asked = false;
  const controller = new AbortController();
  const tool = createExecTool(f.manager, { capturedInput: f.binding, defaultWorkingDirectory: f.root, overflowHandler: new OverflowHandler({ baseDir: f.root }),
    interaction: { availability: detectPtyAvailability(probePtyHost()), quietWindowMs: 30,
      requestPromptAnswer: async () => { asked = true; return new Promise<{ answered: boolean; text: string }>((resolve) => { answer = resolve; }); } } });
  const pending = tool.execute({ commands: [{ cmd: 'printf "CAPTURE_PROMPT: "; read answer; echo "$answer" > late.txt', interactive: true }] }, { signal: controller.signal });
  await waitUntil(() => asked); controller.abort();
  const result = await pending;
  expect(result.success).toBe(false); expect(output(result).stdout ?? '').toBe('');
  answer({ answered: true, text: 'too-late' });
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(existsSync(join(f.root, 'late.txt'))).toBe(false);
});

test.skipIf(!supported)('noisy until input fails inside its owned runner instead of throwing from a stream listener', async () => {
  const f = await fixture();
  const result = await f.tool.execute({ commands: [{ cmd: 'bun -e "process.stdout.write(\'x\'.repeat(600000))"', until: { pattern: 'NEVER', kill_after: true } }] });
  expect(result.success).toBe(false); expect(output(result).stdout ?? '').toBe('');
});

test.skipIf(!supported)('until no-match completion retains authorized diagnostics and exit status', async () => {
  const f = await fixture();
  const result = await f.tool.execute({ commands: [{ cmd: 'echo diagnostic; exit 2', until: { pattern: 'NEVER' } }] });
  expect(result.success).toBe(false);
  expect(output(result).stdout).toContain('diagnostic');
  expect(JSON.parse(result.output!).exit_code).toBe(2);
});

test.skipIf(!supported)('file_ops preserve empty directory copy/move/delete topology', async () => {
  const f = await fixture();
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(f.root, 'empty'));
  const result = await f.tool.execute({ file_ops: [
    { op: 'copy', source: 'empty', destination: 'copy', recursive: true },
    { op: 'move', source: 'copy', destination: 'moved', recursive: true },
    { op: 'delete', source: 'empty', recursive: true },
  ], commands: [{ cmd: 'test -d moved && test ! -e empty && test ! -e copy' }] });
  expect(result.success).toBe(true); expect(existsSync(join(f.root, 'moved'))).toBe(true);
  expect(existsSync(join(f.root, 'empty'))).toBe(false); expect(existsSync(join(f.root, 'copy'))).toBe(false);
});

test.skipIf(!supported)('directory removal cannot erase an omitted denied child', async () => {
  const f = await fixture(); const { mkdirSync } = await import('node:fs');
  mkdirSync(join(f.root, 'folder')); writeFileSync(join(f.root, 'folder/private.txt'), 'SYNTHETIC_DENIED_CHILD');
  const tool = createExecTool(f.manager, { capturedInput: { ...f.binding, readAccessFilter: async (path) => !path.endsWith('/private.txt') },
    defaultWorkingDirectory: f.root, overflowHandler: new OverflowHandler({ baseDir: f.root }) });
  const result = await tool.execute({ file_ops: [{ op: 'delete', source: 'folder', recursive: true }], commands: [{ cmd: 'true' }] });
  expect(result.success).toBe(false);
  expect(readFileSync(join(f.root, 'folder/private.txt'), 'utf8')).toBe('SYNTHETIC_DENIED_CHILD');
});

test.skipIf(!supported)('ordinary model bg commands cannot inspect or stop a captured-owned process', async () => {
  const f = await fixture();
  const result = await f.tool.execute({ commands: [{ cmd: 'echo READY; sleep 2', background: true }] });
  const id = output(result).process_id!;
  expect(f.manager.handleCommand(`bg_output ${id}`)?.success).toBe(false);
  expect(f.manager.handleCommand(`bg_status ${id}`)?.success).toBe(false);
  expect(f.manager.handleCommand(`bg_stop ${id}`)?.success).toBe(false);
  expect(f.manager.handleCommand('bg_list')?.stdout).not.toContain(id);
  expect((await f.tool.execute({ commands: [{ cmd: `bg_stop ${id}` }] })).success).toBe(true);
});

test.skipIf(!supported)('two retained publishers compare under one authority lock before committing', async () => {
  const f = await fixture();
  const first = await f.tool.execute({ commands: [{ cmd: 'sleep 0.7; echo first > source.txt', background: true }] });
  const second = await f.tool.execute({ commands: [{ cmd: 'sleep 0.7; echo second > source.txt', background: true }] });
  const firstId = output(first).process_id!; const secondId = output(second).process_id!;
  await f.manager.waitOwnedBoundaries(f.authority);
  const results = await Promise.all([firstId, secondId].map((id) => f.tool.execute({ commands: [{ cmd: `bg_output ${id}` }] })));
  if (results.filter((result) => result.success).length !== 1) throw new Error(JSON.stringify({ first, second, results, content: readFileSync(join(f.root, 'source.txt'), 'utf8') }));
  expect(['first\n', 'second\n']).toContain(readFileSync(join(f.root, 'source.txt'), 'utf8'));
});

test.skipIf(!supported)('runtime close settles a retained job while its permission callback is pending', async () => {
  const f = await fixture(); let pending = false; let entered = false;
  let release!: (allowed: boolean) => void;
  const gate = new Promise<boolean>((resolve) => { release = resolve; });
  const tool = createExecTool(f.manager, { capturedInput: { ...f.binding, readAccessFilter: async () => {
    if (pending) { entered = true; return gate; } return true;
  } }, defaultWorkingDirectory: f.root, overflowHandler: new OverflowHandler({ baseDir: f.root }) });
  await tool.execute({ commands: [{ cmd: 'sleep 2; echo late > late.txt', background: true }] });
  pending = true;
  await waitUntil(() => entered);
  const closed = f.manager.close();
  const result = await Promise.race([closed.then(() => 'closed'), new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000))]);
  release(true);
  expect(result).toBe('closed'); expect(existsSync(join(f.root, 'late.txt'))).toBe(false);
});

test.skipIf(!supported)('captured cancellation settles only its owner before emitting the terminal event', async () => {
  const { finishCancelledRun, cleanupLeakedProcesses } = await import('../sdk/src/platform/agents/orchestrator-runner-finish.js');
  const a = await fixture(); const b = await fixture();
  const bTool = createExecTool(a.manager, { capturedInput: b.binding, defaultWorkingDirectory: b.root, overflowHandler: new OverflowHandler({ baseDir: b.root }) });
  const first = await a.tool.execute({ commands: [{ cmd: 'sleep 2; echo late > late.txt', background: true }] });
  const second = await bTool.execute({ commands: [{ cmd: 'sleep 2; echo other > other.txt', background: true }] });
  const aId = output(first).process_id!; const bId = output(second).process_id!;
  cleanupLeakedProcesses(a.manager, new Set());
  expect(a.manager.getStatus(aId)?.done).toBe(false); expect(a.manager.getStatus(bId)?.done).toBe(false);
  let emitted = false;
  await finishCancelledRun({ processManager: a.manager,
    beforeRunSettlement: () => a.manager.stopOwnedBoundaries(a.authority),
    emitAgentCancelledEvent: () => { emitted = true; expect(a.manager.getStatus(aId)?.done).toBe(true); expect(a.manager.getStatus(bId)?.done).toBe(false); },
  } as unknown as import('../sdk/src/platform/agents/orchestrator-run-context.js').AgentOrchestratorRunContext,
  { id: 'a', startedAt: Date.now(), toolCallCount: 1 } as import('../sdk/src/platform/tools/agent/index.js').AgentRecord, null, new Set());
  expect(emitted).toBe(true);
  await a.manager.stopOwnedBoundaries(b.authority);
});

test.skipIf(!supported)('a timed-out retained job keeps typed status while original authority is valid', async () => {
  const f = await fixture();
  const started = await f.tool.execute({ commands: [{ cmd: 'sleep 2', background: true, timeout_ms: 250 }] });
  const id = output(started).process_id!;
  expect(id).toBeString();
  await f.manager.waitOwnedBoundaries(f.authority);
  const status = await f.tool.execute({ commands: [{ cmd: `bg_status ${id}` }] });
  expect(status.success).toBe(true);
  expect(JSON.parse(output(status).stdout!).timed_out).toBe(true);
  const captured = await f.tool.execute({ commands: [{ cmd: `bg_output ${id}` }] });
  expect(JSON.parse(captured.output!).timed_out).toBe(true);
});


for (const mode of ['foreground', 'pty', 'background', 'until'] as const) {
  test.skipIf(!supported)(`captured ${mode} final spawn refuses a revoked command permit after projection admission`, async () => {
    const f = await fixture();
    let claims = 0;
    const beforeSpawn = () => { claims++; throw new Error('Synthetic final command admission revoked'); };
    const command = 'echo unexpected > forbidden-spawn.txt; echo READY';
    const result = mode === 'background' || mode === 'until'
      ? await startCapturedBackground(f.manager, f.binding, command,
        mode === 'background' ? { background: true } : { until: { pattern: 'READY', kill_after: false } }, f.root, 2000, undefined, 'disabled', {}, beforeSpawn)
      : await runCapturedCommand(f.binding, command, {}, f.root, 2000, undefined, 'disabled', {}, {
        beforeSpawn, ...(mode === 'pty' ? { interaction: { availability: detectPtyAvailability(probePtyHost()) } } : {}),
      });
    expect(claims).toBe(1); expect(result.success).toBe(false);
    expect(existsSync(join(f.root, 'forbidden-spawn.txt'))).toBe(false);
    expect(existsSync(join(f.owner, 'forbidden-spawn.txt'))).toBe(false);
  });
}

import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort, forgetGateReadings } from './_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.ts';

for (const forwarding of ['exact', 'copied-options', 'cloned-args'] as const) {
  test.skipIf(!supported)(`real admitted captured Exec enforces ${forwarding} body identity before process effects`, async () => {
    const f = await fixture();
    forgetGateReadings();
    const config = {
      getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: f.owner }),
      getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
      getWorkingDirectory: () => f.owner, isAutoApproveEnabled: () => false,
    } as PermissionConfigReader;
    const permissions = new PermissionManager(undefined, config, new PolicyRuntimeState());
    const registry = new ToolRegistry(permissions);
    const gate = gateReadingsPort();
    const autonomous = fakePort((_key, question) => choiceAnswer(question, 'act', 0.99));
    const log = new SqliteDecisionLog(':memory:');
    const previous = installJudgmentPort(withDecisionLog({ ...gate.port, ask(request) {
      return 'disposition' in request.questions ? autonomous.port.ask(request) : gate.port.ask(request);
    } }, log));
    // Keep the actual constructor-bound tool identity and captured backend.
    // Interpose only the forwarding choice at its real executor boundary.
    const execute = f.tool.execute;
    let calls = 0;
    f.tool.execute = (args, options) => {
      calls++;
      return execute(forwarding === 'cloned-args' ? structuredClone(args) : args,
        forwarding === 'copied-options' ? { ...options } : options);
    };
    registry.register(capturedInputTool(f.tool, f.authority, f.root, f.binding.readAccessFilter, undefined));
    try {
      const call = await registry.prepareCall('captured-exec-identity', 'exec', {
        commands: [{ cmd: "printf 'identity-owned' > identity.txt", timeout_ms: 5000 }],
      });
      const admission = await permissions.admitAutonomous(call.callId, call.name, call.args, {
        sourceOf: () => ({ goal: 'Write the owned captured fixture marker', criteria: ['Execute the exact admitted command once'] }),
        schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      });
      const result = await registry.executePrepared(call, admission);
      expect(calls).toBe(1);
      expect(result.success, result.output ?? result.error).toBe(forwarding === 'exact');
      expect(existsSync(join(f.root, 'identity.txt'))).toBe(forwarding === 'exact');
      if (forwarding === 'exact') expect(readFileSync(join(f.root, 'identity.txt'), 'utf8')).toBe('identity-owned');
      expect(existsSync(join(f.owner, 'identity.txt'))).toBe(false);
      await expect(registry.executePrepared(call, admission)).rejects.toThrow('claimed');
      expect(calls).toBe(1);
    } finally { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); }
  });
}
