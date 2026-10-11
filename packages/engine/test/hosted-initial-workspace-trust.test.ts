import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.ts';
import { spawnSync } from 'node:child_process';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.ts';
import { createContractInputAuthority } from '../sdk/src/platform/contract/input-authority.ts';
import type { Contract } from '../sdk/src/platform/contract/types.ts';
import { runCapturedCommand, probeCapturedExecAvailability } from '../sdk/src/platform/tools/exec/captured-exec.ts';
import { executeFileOperations } from '../sdk/src/platform/tools/exec/file-ops.ts';
import { createExecTool } from '../sdk/src/platform/tools/exec/runtime.ts';
import { captureCurrentExecWorkspaceConstraint, ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.ts';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDecisionLog, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../sdk/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices, type ClientRuntimeServices } from '../sdk/src/platform/runtime/client-services.ts';
import { createHostedSessionRuntime, type HostedSessionRuntime } from '../sdk/src/platform/hosted-sessions/session-runtime.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../sdk/src/platform/core/orchestrator-tool-runtime.ts';
import { admitSandboxEscalation } from '../sdk/src/platform/runtime/permissions/autonomous-sandbox-escalation.ts';
import { withExternalOperationSource } from '../sdk/src/platform/permissions/external-operation-scope.ts';
import { WorkspaceTrustManager } from '../sdk/src/platform/runtime/workspace-trust.ts';
import { createShellPathService } from '../sdk/src/platform/runtime/shell-paths.ts';
import { detectSandboxAvailability, probeSandboxHost, resolveExecSandboxPlan } from '../sdk/src/platform/tools/exec/sandbox.ts';
import { toolReadingsPort } from './_helpers/tool-readings.ts';
import { forgetCredentialEnvReadings } from '../sdk/src/platform/tools/exec/credential-env.ts';
import { forgetGateReadings } from './_helpers/gate-readings.ts';

const command = 'printf owned-sandbox-fixture';
const availability = detectSandboxAvailability(probeSandboxHost());
let root: string; let workspaceTrust: WorkspaceTrustManager; let services: ClientRuntimeServices; let runtime: HostedSessionRuntime;
let restore: () => void; let deps: ToolExecutionDeps;
let denyEscalation: boolean; let revokeBeforeSpawn: (() => void | Promise<void>) | undefined; let sawEscalation: boolean;
let humanAsks: string[]; let requests: JudgmentRequest<Questions>[];

beforeEach(() => {
  forgetGateReadings(); forgetCredentialEnvReadings(); humanAsks = []; requests = []; denyEscalation = false; sawEscalation = false; revokeBeforeSpawn = undefined;
  root = mkdtempSync(join(tmpdir(), 'hosted-initial-trust-'));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'config'), workingDir: root, homeDir: root });
  workspaceTrust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), surfaceRoot: 'tui' });
  services = createClientRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), surfaceRoot: 'tui',
    workingDir: root, homeDirectory: root, modelDiscovery: 'skip', workspaceTrust,
    requestApproval: async input => { humanAsks.push(input.request.tool); return { approved: false }; },
  });
  // Synthetic semantic readings exercise the exact escalation branch. The command
  // itself only prints a fixture string; no external network operation is needed.
  const readings = toolReadingsPort([], [[command, { needsNetwork: false }]]);
  const semantic = fakePort((_name, question, state) => choiceAnswer(question, denyEscalation && JSON.stringify(state).includes('sandboxEscalation') ? 'reject' : 'act', 0.97));
  const recorded = withDecisionLog({ model: readings.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.(); requests.push(request as JudgmentRequest<Questions>);
    if ('disposition' in request.questions) sawEscalation = true;
    if (sawEscalation && 'credential' in request.questions && revokeBeforeSpawn) { const revoke = revokeBeforeSpawn; revokeBeforeSpawn = undefined; await revoke(); }
    return 'disposition' in request.questions ? semantic.port.ask(request) : readings.port.ask(request);
  } }, services.judgment.decisionLog);
  const spy = spyOn(services.judgment.port, 'ask').mockImplementation(recorded.ask); restore = () => spy.mockRestore();
  runtime = createHostedSessionRuntime({ sessionId: 'sandbox-fixture', workspaceRoot: root, systemPrompt: 'Synthetic owned fixture',
    floor: { services, contractRunner: services.contractRunner, dispose() {} } });
  deps = { autonomousSource: () => ({ goal: 'Run only the owned fixture with the existing sandbox boundary', criteria: ['Do not access an external service', 'Do not ask a human or weaken containment'] }),
    permissionManager: services.permissionManager, toolRegistry: runtime.toolRegistry, hookDispatcher: null, runtimeBus: null,
    sessionId: runtime.sessionId, emitterContext: () => ({ sessionId: runtime.sessionId, traceId: 'synthetic', source: 'orchestrator' }) };
});
afterEach(() => { runtime?.dispose(); restore?.(); services?.dispose(); if (root) rmSync(root, { recursive: true, force: true }); forgetGateReadings(); });

test.skipIf(!availability.available)('explicit restricted workspace forbids initial non-escalating native Exec', async () => {
  await workspaceTrust.setLevel('restricted');
  let spawns = 0; const original = Bun.spawn;
  const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => { spawns++; return original(...args); }) as typeof Bun.spawn);
  try {
    await expect(executeToolCalls(deps, 'restricted-initial', [{ id: 'restricted-initial-call', name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 1000 }] } }])).rejects.toThrow('restricted');
    expect(spawns).toBe(0); expect(humanAsks).toEqual([]);
  } finally { spy.mockRestore(); }
}, 15000);


test('restricted workspace retains native read access but forbids initial write', async () => {
  await workspaceTrust.setLevel('restricted'); writeFileSync(join(root, 'note.txt'), 'owned-read-fixture');
  const read = await executeToolCalls(deps, 'restricted-read', [{ id: 'restricted-read-call', name: 'read', arguments: { files: [{ path: join(root, 'note.txt') }] } }]);
  expect(read[0]!.success).toBe(true); expect(read[0]!.output).toContain('owned-read-fixture');
  await expect(executeToolCalls(deps, 'restricted-write', [{ id: 'restricted-write-call', name: 'write', arguments: { files: [{ path: join(root, 'forbidden.txt'), content: 'never' }] } }])).rejects.toThrow('restricted');
  expect(existsSync(join(root, 'forbidden.txt'))).toBe(false); expect(humanAsks).toEqual([]);
}, 15000);

for (const mode of ['foreground', 'progress', 'until', 'pty', 'background'] as const) {
  test(`real native ${mode} refuses trust ABA during post-Jev environment preparation`, async () => {
    runtime.dispose();
    services.configManager.set('sandbox.enabled', false); // Explicit owned temporary workstream fixture, never a public hosted grant.
    runtime = createHostedSessionRuntime({ sessionId: 'trust-workstream', workspaceRoot: root, systemPrompt: 'Owned temporary workstream fixture',
      floor: { services, contractRunner: services.contractRunner, dispose() {} }, execPosture: 'workstream' });
    deps = { ...deps, toolRegistry: runtime.toolRegistry, sessionId: runtime.sessionId };
    await workspaceTrust.setLevel('trusted');
    let applied = false;
    revokeBeforeSpawn = async () => { await workspaceTrust.setLevel('restricted'); await workspaceTrust.setLevel('trusted'); applied = true; };
    let spawns = 0; const original = Bun.spawn;
    const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => { spawns++; return original(...args); }) as typeof Bun.spawn);
    try {
      const result = await executeToolCalls(deps, `trust-${mode}`, [{ id: `trust-${mode}-call`, name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 1000,
        progress: mode === 'progress', interactive: mode === 'pty', background: mode === 'background', ...(mode === 'until' ? { until: { pattern: 'owned', kill_after: true } } : {}) }] } }]);
      expect(applied).toBe(true); expect(spawns).toBe(0); expect(result[0]!.success).toBe(false); expect(humanAsks).toEqual([]);
    } finally { spy.mockRestore(); }
  }, 15000);
}


for (const wrapper of ['same', 'copied-options', 'missing-options', 'copied-args'] as const) {
  test(`authentic registry Exec wrapper ${wrapper} cannot downgrade invocation proof`, async () => {
    const raw = createExecTool(services.processManager, { defaultWorkingDirectory: root, overflowHandler: new OverflowHandler({ baseDir: root }), credentialEnvScrub: { enabled: false } });
    const registry = new ToolRegistry(services.permissionManager);
    registry.register({ ...raw, execute: (args, opts) => raw.execute(wrapper === 'copied-args' ? { ...args } : args,
      wrapper === 'missing-options' ? undefined : wrapper === 'copied-options' ? { ...opts } : opts) });
    let spawns = 0; const original = Bun.spawn;
    const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => { spawns++; return original(...args); }) as typeof Bun.spawn);
    try {
      const result = await executeToolCalls({ ...deps, toolRegistry: registry }, 'wrapper', [{ id: `wrapper-${wrapper}`, name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 1000 }] } }]);
      expect(spawns).toBe(wrapper === 'same' ? 1 : 0); expect(result[0]!.success).toBe(wrapper === 'same'); expect(humanAsks).toEqual([]);
    } finally { spy.mockRestore(); }
  }, 15000);
}

test('detached continuation cannot revive a settled authentic Exec invocation with copied options', async () => {
  const raw = createExecTool(services.processManager, { defaultWorkingDirectory: root, overflowHandler: new OverflowHandler({ baseDir: root }), credentialEnvScrub: { enabled: false } });
  const registry = new ToolRegistry(services.permissionManager);
  let release!: () => void;
  let late!: ReturnType<typeof raw.execute>;
  registry.register({ ...raw, execute: async (args, opts) => {
    late = new Promise<void>(resolve => { release = resolve; }).then(() => raw.execute(args, { ...opts }));
    return { success: true, output: 'fixture scheduled continuation' };
  } });
  let spawns = 0; const original = Bun.spawn;
  const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => { spawns++; return original(...args); }) as typeof Bun.spawn);
  try {
    await executeToolCalls({ ...deps, toolRegistry: registry }, 'late-wrapper', [{ id: 'late-wrapper-call', name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 1000 }] } }]);
    release(); expect((await late).success).toBe(false); expect(spawns).toBe(0); expect(humanAsks).toEqual([]);
  } finally { spy.mockRestore(); }
}, 15000);

for (const copied of [false, true]) test(`workspace restriction capture requires exact active invocation (copied=${copied})`, async () => {
  let captured: (() => void) | undefined; let late!: () => void;
  const registry = new ToolRegistry(services.permissionManager);
  registry.register({ definition: { name: 'exec', description: 'Owned capture fixture', parameters: { type: 'object', properties: {}, additionalProperties: true } },
    execute: async (args, opts) => {
      captured = captureCurrentExecWorkspaceConstraint(args, copied ? { ...opts } : opts);
      late = () => { captureCurrentExecWorkspaceConstraint(args, opts); };
      return { success: true, output: 'owned' };
    } });
  const result = await executeToolCalls({ ...deps, toolRegistry: registry }, 'capture', [{ id: 'capture-call', name: 'exec', arguments: { commands: [{ cmd: command }] } }]);
  if (copied) { expect(result[0]!.success).toBe(false); expect(captured).toBeUndefined(); }
  else { expect(result[0]!.success).toBe(true); expect(captured).toBeFunction(); expect(() => late()).toThrow(); captured!();
    await workspaceTrust.setLevel('restricted'); expect(() => captured!()).toThrow(); }
});

test('file operation guard runs after each awaited path authorization and before the write', async () => {
  writeFileSync(join(root, 'source.txt'), 'owned');
  const guard = await workspaceTrust.prepareAutonomousConstraint('execute');
  await expect(executeFileOperations([{ op: 'copy', source: 'source.txt', destination: 'copy.txt' }], root,
    { beforeOperation: async () => { await workspaceTrust.setLevel('restricted'); }, beforeImportUpdates: async () => {} }, guard)).rejects.toThrow();
  expect(existsSync(join(root, 'copy.txt'))).toBe(false);
});

async function capturedFixture() {
  const git = (...args: string[]) => { const result = spawnSync('git', ['-C', root, ...args]); if (result.status) throw new Error(result.stderr.toString()); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'source.txt'), 'captured fixture'); git('add', 'source.txt'); git('commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(root); const view = contractInputPath(inputSnapshot);
  git('worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, view, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, view);
  const authority = await createContractInputAuthority({ projectRoot: root, inputSnapshot } as Contract, view, { mutable: true, branch: `input/${inputSnapshot.id}` });
  return { root: view, authority, readAccessFilter: async () => true };
}
const capturedSupported = (await probeCapturedExecAvailability()).available;
for (const revoke of [false, true]) test.skipIf(!capturedSupported)(`authentic captured background completion retains owner lifetime (revoke=${revoke})`, async () => {
  const binding = await capturedFixture();
  const registry = new ToolRegistry(services.permissionManager);
  const raw = createExecTool(services.processManager, { capturedInput: binding, defaultWorkingDirectory: binding.root,
    overflowHandler: new OverflowHandler({ baseDir: root }), credentialEnvScrub: { enabled: false } });
  registry.register(raw);
  const result = await executeToolCalls({ ...deps, toolRegistry: registry }, 'captured-background', [{ id: 'captured-background-call', name: 'exec',
    arguments: { commands: [{ cmd: 'sleep 0.5; echo completed > completed.txt', background: true }] } }]);
  expect(result[0]!.success, result[0]!.error ?? result[0]!.output).toBe(true);
  const id = JSON.parse(result[0]!.output!).process_id as string;
  expect(id).toBeString();
  if (revoke) { await workspaceTrust.setLevel('restricted'); await workspaceTrust.setLevel('trusted'); }
  const deadline = Date.now() + 10000;
  while (!services.processManager.getStatus(id)?.done) { if (Date.now() > deadline) throw new Error('owned job did not settle'); await new Promise(resolve => setTimeout(resolve, 20)); }
  expect(existsSync(join(binding.root, 'completed.txt'))).toBe(!revoke);
  if (!revoke) expect(readFileSync(join(binding.root, 'completed.txt'), 'utf8')).toBe('completed\n');
  expect(existsSync(join(root, 'completed.txt'))).toBe(false);
}, 20000);

test.skipIf(!capturedSupported)('captured file_ops cannot publish after post-spawn path authorization revokes trust', async () => {
  const base = await capturedFixture(); const guard = await workspaceTrust.prepareAutonomousConstraint('execute');
  let spawned = false; let revoked = false;
  const binding = { ...base, readAccessFilter: async () => {
    if (spawned && !revoked) { revoked = true; await workspaceTrust.setLevel('restricted'); }
    return true;
  } };
  const result = await runCapturedCommand(binding, ':', {}, binding.root, 10000, undefined, 'disabled', {}, {
    beforeSpawn: () => { guard(); spawned = true; }, beforePublish: guard,
    fileOps: [{ op: 'copy', source: join(binding.root, 'source.txt'), destination: join(binding.root, 'copy.txt') }],
  });
  expect(spawned).toBe(true); expect(revoked).toBe(true); expect(result.success).toBe(false);
  expect(existsSync(join(binding.root, 'copy.txt'))).toBe(false);
}, 20000);


test.skipIf(!capturedSupported)('actual captured tool wrapper preserves authentic registry Exec argument identity', async () => {
  const binding = await capturedFixture();
  const registry = new ToolRegistry(services.permissionManager);
  const raw = createExecTool(services.processManager, { capturedInput: binding, defaultWorkingDirectory: binding.root,
    overflowHandler: new OverflowHandler({ baseDir: root }), credentialEnvScrub: { enabled: false } });
  registry.register(capturedInputTool(raw, binding.authority, binding.root, binding.readAccessFilter, undefined));
  const result = await executeToolCalls({ ...deps, toolRegistry: registry }, 'captured-wrapper', [{ id: 'captured-wrapper-call', name: 'exec',
    arguments: { commands: [{ cmd: 'echo authenticated > authenticated.txt' }] } }]);
  expect(result[0]!.success, result[0]!.error ?? result[0]!.output).toBe(true);
  expect(readFileSync(join(binding.root, 'authenticated.txt'), 'utf8')).toBe('authenticated\n');
  expect(existsSync(join(root, 'authenticated.txt'))).toBe(false);
}, 20000);

for (const copy of ['args', 'options'] as const) test.skipIf(!capturedSupported)(`actual captured wrapper cannot authenticate copied ${copy}`, async () => {
  const binding = await capturedFixture(); const registry = new ToolRegistry(services.permissionManager);
  const raw = createExecTool(services.processManager, { capturedInput: binding, defaultWorkingDirectory: binding.root,
    overflowHandler: new OverflowHandler({ baseDir: root }), credentialEnvScrub: { enabled: false } });
  const wrapped = capturedInputTool(raw, binding.authority, binding.root, binding.readAccessFilter, undefined);
  registry.register({ ...wrapped, execute: (args, options) => wrapped.execute(copy === 'args' ? { ...args } : args, copy === 'options' ? { ...options } : options) });
  const result = await executeToolCalls({ ...deps, toolRegistry: registry }, 'captured-copy', [{ id: 'captured-copy-call', name: 'exec',
    arguments: { commands: [{ cmd: 'echo forbidden > forbidden.txt' }] } }]);
  expect(result[0]!.success).toBe(false); expect(existsSync(join(binding.root, 'forbidden.txt'))).toBe(false);
}, 20000);
