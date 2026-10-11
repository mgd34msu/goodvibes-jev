import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
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
  root = mkdtempSync(join(tmpdir(), 'hosted-sandbox-escalation-'));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'config'), workingDir: root, homeDir: root });
  workspaceTrust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), surfaceRoot: 'tui' });
  services = createClientRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), surfaceRoot: 'tui',
    workingDir: root, homeDirectory: root, modelDiscovery: 'skip', workspaceTrust,
    requestApproval: async input => { humanAsks.push(input.request.tool); return { approved: false }; },
  });
  // Synthetic semantic readings exercise the exact escalation branch. The command
  // itself only prints a fixture string; no external network operation is needed.
  const readings = toolReadingsPort([], [[command, { needsNetwork: true }]]);
  const semantic = fakePort((_name, question, state) => choiceAnswer(question, denyEscalation && JSON.stringify(state).includes('sandboxEscalation') ? 'reject' : 'act', 0.97));
  const recorded = withDecisionLog({ model: readings.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.(); requests.push(request as JudgmentRequest<Questions>);
    if ('disposition' in request.questions && JSON.stringify(request.state).includes('sandboxEscalation')) sawEscalation = true;
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

test.skipIf(!availability.available)('actual hosted sandbox escalation retains Jev ownership and never opens a human wait', async () => {
  const result = await executeToolCalls(deps, 'sandbox-turn', [{ id: 'sandbox-call', name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 2000 }] } }]);
  expect(humanAsks).toEqual([]);
  expect(requests.some(request => 'disposition' in request.questions && JSON.stringify(request.state).includes('sandboxEscalation'))).toBe(true);
  // A host where bwrap cannot establish its boundary may fail. It must never
  // silently run the command uncontained merely because Jev admitted the attempt.
  const output = JSON.parse(result[0]!.output!);
  expect(output.sandboxed).toBe(true);
  expect(output.sandbox_network).not.toBe('enabled');
}, 15000);


test.skipIf(!availability.available)('actual hosted Jev refusal denies escalation without a human fallback', async () => {
  denyEscalation = true;
  const result = await executeToolCalls(deps, 'sandbox-deny', [{ id: 'sandbox-deny-call', name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 1000 }] } }]);
  expect(humanAsks).toEqual([]); expect(sawEscalation).toBe(true);
  expect(result[0]!.success).toBe(false); expect(result[0]!.output).toContain('Sandbox escalation denied');
}, 15000);

for (const reason of ['config', 'source', 'cancellation', 'trust-aba'] as const) {
  test.skipIf(!availability.available)(`actual hosted ${reason} revocation after Jev and during environment preparation prevents spawn`, async () => {
    const controller = new AbortController();
    let changed = false; let revocationApplied = false;
    if (reason === 'trust-aba') await workspaceTrust.setLevel('trusted');
    deps = { ...deps, turnSignal: controller.signal };
    if (reason === 'source') deps = { ...deps, autonomousSource: () => ({ goal: changed ? 'Changed owner goal' : 'Run only the owned fixture with the existing sandbox boundary', criteria: ['Keep containment'] }) };
    revokeBeforeSpawn = async () => {
      if (reason === 'config') services.configManager.set('sandbox.enabled', false);
      if (reason === 'source') changed = true;
      if (reason === 'cancellation') controller.abort();
      if (reason === 'trust-aba') { await workspaceTrust.setLevel('restricted'); await workspaceTrust.setLevel('trusted'); }
      revocationApplied = true;
    };
    let spawns = 0;
    const original = Bun.spawn;
    const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => { spawns++; return original(...args); }) as typeof Bun.spawn);
    try {
      const pending = executeToolCalls(deps, 'sandbox-revoke', [{ id: 'sandbox-revoke-call', name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 1000 }] } }]);
      if (reason === 'cancellation') await expect(pending).rejects.toThrow();
      else expect((await pending)[0]!.success).toBe(false);
      expect(humanAsks).toEqual([]); expect(sawEscalation).toBe(true); expect(revokeBeforeSpawn).toBeUndefined(); expect(revocationApplied).toBe(true);
      expect(spawns).toBe(0);
    } finally { spy.mockRestore(); }
  }, 15000);
}


async function directPermit(trust: WorkspaceTrustManager | null | undefined = null) {
  const controller = new AbortController();
  const plan = resolveExecSandboxPlan({ config: { enabled: true, egressAllowlist: [], workspaceWritable: [] }, availability,
    featureEnabled: true, command, workspaceDir: root, cwd: root, needs: { needsNetwork: true, needsPrivilege: false } });
  return withExternalOperationSource({ sourceOf: () => ({ goal: 'Run the owned fixture without changing its boundary', criteria: ['Keep containment'] }), assertCurrent() {} },
    () => admitSandboxEscalation({ port: services.judgment.port, permissionManager: services.permissionManager, config: services.configManager, signal: controller.signal,
      workspaceTrust: trust }, { command, escalations: ['network'], boundary: plan.boundary, plan, workingDirectory: root, policyReasons: ['Synthetic network reading'] },
    { assertCurrent() {} }));
}

test.skipIf(!availability.available)('owned sandbox permit is frozen and single-use', async () => {
  const permit = await directPermit(); expect(permit).not.toBe(false);
  if (!permit) throw new Error('Expected admitted fixture');
  expect(Object.isFrozen(permit)).toBe(true); permit.claim(); expect(() => permit.claim()).toThrow(); permit.close(); expect(() => permit.assertCurrent()).toThrow();
  expect(humanAsks).toEqual([]);
}, 15000);

test.skipIf(!availability.available)('explicit restricted workspace refuses sandbox admission without a human trust prompt', async () => {
  const trust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), surfaceRoot: 'tui' });
  await trust.setLevel('restricted');
  expect(await directPermit(trust)).toBe(false); expect(humanAsks).toEqual([]); expect(sawEscalation).toBe(false);
}, 15000);


test.skipIf(!availability.available)('actual hosted explicit restricted workspace sends no sandbox process and never asks a human', async () => {
  await workspaceTrust.setLevel('restricted');
  let spawns = 0; const original = Bun.spawn;
  const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => { spawns++; return original(...args); }) as typeof Bun.spawn);
  try {
    await expect(executeToolCalls(deps, 'restricted-escalation', [{ id: 'restricted-escalation-call', name: 'exec', arguments: { commands: [{ cmd: command, timeout_ms: 1000 }] } }])).rejects.toThrow('restricted');
    expect(spawns).toBe(0); expect(humanAsks).toEqual([]); expect(sawEscalation).toBe(false);
  } finally { spy.mockRestore(); }
}, 15000);
