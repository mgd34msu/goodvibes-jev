import { answerExecPrompt, commitExecPromptAnswer, discardExecPromptAnswer } from '../sdk/src/platform/runtime/permissions/autonomous-tool-prompts.ts';
import { runInteractiveCommand, detectPtyAvailability, probePtyHost } from '../sdk/src/platform/tools/exec/interactive.ts';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

const command = 'printf "Continue? [y/n]: " > /dev/tty; read ans < /dev/tty; if [ "$ans" = "y" ]; then echo owned-terminal-receipt; else exit 1; fi';
const availability = detectSandboxAvailability(probeSandboxHost());
let root: string; let workspaceTrust: WorkspaceTrustManager; let services: ClientRuntimeServices; let runtime: HostedSessionRuntime;
let restore: () => void; let deps: ToolExecutionDeps;
let denyEscalation: boolean; let revokeBeforeSpawn: (() => void | Promise<void>) | undefined; let sawEscalation: boolean;
let control: 'revise_0' | 'reject';
let humanAsks: string[]; let requests: JudgmentRequest<Questions>[];

beforeEach(() => {
  control = 'revise_0';
  forgetGateReadings(); forgetCredentialEnvReadings(); humanAsks = []; requests = []; denyEscalation = false; sawEscalation = false; revokeBeforeSpawn = undefined;
  root = mkdtempSync(join(tmpdir(), 'hosted-autonomous-prompts-'));
  const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir: join(root, 'config'), workingDir: root, homeDir: root });
  configManager.set('sandbox.enabled', false); // Explicit temporary workstream fixture only.
  workspaceTrust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }), surfaceRoot: 'tui' });
  services = createClientRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), surfaceRoot: 'tui',
    workingDir: root, homeDirectory: root, modelDiscovery: 'skip', workspaceTrust,
    requestApproval: async input => { humanAsks.push(input.request.tool); return { approved: false }; },
  });
  // Synthetic semantic readings exercise the exact escalation branch. The command
  // itself only prints a fixture string; no external network operation is needed.
  const readings = toolReadingsPort([['Continue?', { awaitingInput: true }]]);
  const semantic = fakePort((_name, question, state) => choiceAnswer(question, question.type === 'choice' && 'revise_0' in question.criteria && !('act' in question.criteria) ? control : 'act', 0.97));
  const recorded = withDecisionLog({ model: readings.port.model, async ask(request) {
    request.signal?.throwIfAborted(); request.beforeAttempt?.(); requests.push(request as JudgmentRequest<Questions>);
    if ('disposition' in request.questions && JSON.stringify(request.state).includes('sandboxEscalation')) sawEscalation = true;
    if (sawEscalation && 'credential' in request.questions && revokeBeforeSpawn) { const revoke = revokeBeforeSpawn; revokeBeforeSpawn = undefined; await revoke(); }
    return 'disposition' in request.questions ? semantic.port.ask(request) : readings.port.ask(request);
  } }, services.judgment.decisionLog);
  const spy = spyOn(services.judgment.port, 'ask').mockImplementation(recorded.ask); restore = () => spy.mockRestore();
  runtime = createHostedSessionRuntime({ sessionId: 'sandbox-fixture', workspaceRoot: root, systemPrompt: 'Synthetic owned fixture',
    floor: { services, contractRunner: services.contractRunner, dispose() {} }, execPosture: 'workstream' });
  deps = { autonomousSource: () => ({ goal: 'Run only the owned fixture with the existing sandbox boundary', criteria: ['Do not access an external service', 'Do not ask a human or weaken containment'] }),
    permissionManager: services.permissionManager, toolRegistry: runtime.toolRegistry, hookDispatcher: null, runtimeBus: null,
    sessionId: runtime.sessionId, emitterContext: () => ({ sessionId: runtime.sessionId, traceId: 'synthetic', source: 'orchestrator' }) };
});
afterEach(() => { runtime?.dispose(); restore?.(); services?.dispose(); if (root) rmSync(root, { recursive: true, force: true }); forgetGateReadings(); });

test('actual hosted terminal selects exact Jev control without a human or saved trust', async () => {
  const result = await executeToolCalls(deps, 'terminal', [{ id: 'terminal-call', name: 'exec', arguments: { commands: [{ cmd: command, interactive: true, timeout_ms: 5000 }] } }]);
  expect(humanAsks).toEqual([]); expect(result[0]!.success).toBe(true);
  expect(result[0]!.output).toContain('owned-terminal-receipt'); expect(workspaceTrust.isDecided()).toBe(false);
  expect(requests.some(item => item.context?.site === 'engine.exec.prompt-control')).toBe(true);
}, 15000);

test('explicit restricted terminal control refuses without persisted escalation', async () => {
  await workspaceTrust.setLevel('restricted');
  await expect(executeToolCalls(deps, 'terminal-restricted', [{ id: 'terminal-restricted-call', name: 'exec', arguments: { commands: [{ cmd: command, interactive: true, timeout_ms: 3000 }] } }])).rejects.toThrow('restricted');
  expect(humanAsks).toEqual([]);
}, 15000);


function controlHost(signal: AbortSignal) { return { port: services.judgment.port, permissionManager: services.permissionManager,
  config: services.configManager, signal, workspaceTrust }; }
const safePrompt = () => ({ command: 'printf owned-control', prompt: 'Continue? [y/n]:', recentOutput: 'Owned test fixture', workingDirectory: root });

test('canonical control is frozen, copied responses refuse, and an owned answer is single-use', async () => {
  const signal = new AbortController().signal;
  await withExternalOperationSource({ sourceOf: () => ({ goal: 'Confirm the owned fixture', criteria: ['No external service'] }), assertCurrent() {} }, async () => {
    const answer = await answerExecPrompt(controlHost(signal), safePrompt(), { signal, assertCurrent() {} });
    expect(answer).toEqual({ answered: true, text: 'y' }); expect(Object.isFrozen(answer)).toBe(true);
    expect(() => commitExecPromptAnswer({ ...answer })).toThrow('owned admission');
    commitExecPromptAnswer(answer); expect(() => commitExecPromptAnswer(answer)).toThrow(); discardExecPromptAnswer(answer);
  });
}, 15000);

for (const reason of ['config', 'source', 'cancel', 'prompt'] as const) {
  test(`terminal ${reason} revocation cannot write a prepared response`, async () => {
    const controller = new AbortController(); let changed = false; let current = true;
    await withExternalOperationSource({ sourceOf: () => ({ goal: changed ? 'Different owner goal' : 'Confirm the owned fixture', criteria: ['No external service'] }), assertCurrent() {} }, async () => {
      const answer = await answerExecPrompt(controlHost(controller.signal), safePrompt(), { signal: controller.signal, assertCurrent() { if (!current) throw new Error('Prompt changed'); } });
      expect(answer.answered).toBe(true);
      if (reason === 'config') services.configManager.set('sandbox.enabled', true);
      if (reason === 'source') changed = true;
      if (reason === 'cancel') controller.abort();
      if (reason === 'prompt') current = false;
      expect(() => commitExecPromptAnswer(answer)).toThrow(); discardExecPromptAnswer(answer);
    });
  }, 15000);
}

test('unsupported and protected terminal evidence refuses before a hosted reading', async () => {
  await withExternalOperationSource({ sourceOf: () => ({ goal: 'Owned fixture', criteria: [] }), assertCurrent() {} }, async () => {
    for (const ask of [{ ...safePrompt(), prompt: 'Password:' }, { ...safePrompt(), recentOutput: 'Authorization: Bearer synthetic-private-control-value' }]) {
      const before = requests.length;
      expect(await answerExecPrompt(controlHost(new AbortController().signal), ask, { assertCurrent() {} })).toEqual({ answered: false });
      expect(requests.length).toBe(before);
    }
  });
});

test('Jev may refuse fixed terminal controls without a human fallback', async () => {
  control = 'reject';
  const result = await withExternalOperationSource({ sourceOf: () => ({ goal: 'Owned fixture', criteria: [] }), assertCurrent() {} },
    () => answerExecPrompt(controlHost(new AbortController().signal), safePrompt(), { assertCurrent() {} }));
  expect(result).toEqual({ answered: false }); expect(humanAsks).toEqual([]);
});

test.skipIf(!detectPtyAvailability(probePtyHost()).available)('real PTY output changed during callback prevents old bytes from being sent', async () => {
  const result = await runInteractiveCommand({ cmdStr: 'printf "Continue? [y/n]: "; sleep 0.3; printf "changed prompt: "; read answer; echo "SENT=$answer"',
    cwd: root, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeoutMs: 1000, startTime: Date.now(), sandboxArgv: [],
    interaction: { availability: detectPtyAvailability(probePtyHost()), quietWindowMs: 10,
      requestPromptAnswer: async () => { await new Promise(resolve => setTimeout(resolve, 400)); return { answered: true, text: 'y' }; } } });
  expect(result.success).toBe(false); expect(result.prompts_answered).toBeUndefined(); expect(result.stdout).not.toContain('SENT=y');
}, 10000);
