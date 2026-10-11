import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ChannelDeliveryRouter, type ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ProcessManager, ToolInputProjectionError, assertCurrentToolEffect, type BackgroundProcess } from '@goodvibes-jev/engine/sdk/platform/tools';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CommandContext } from '../../input/command-registry.ts';
import { CommandRegistry } from '../../input/command-registry.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { runCommand, runTranslatedWorkspaceCommand } from '../../tools/agent-harness-command-runner.ts';
import { createAgentTerminalTool, createAgentProcessTool } from '../../tools/agent-terminal-process-tools.ts';
import { createAgentChannelSendTool } from '../../tools/agent-channel-send-tool.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { runWorkspaceAction } from '../../tools/agent-harness-workspace-action-runner.ts';
import { runWorkspaceEditorAction } from '../../tools/agent-harness-workspace-editor-runner.ts';
import { runLocalWorkspaceAction } from '../../tools/agent-harness-local-operations.ts';
import { clearSetupCheckpoint } from '../../tools/agent-harness-setup-posture.ts';
import { saveSetupWizardCheckpoint, setupWizardCheckpointPath } from '../../agent/setup-wizard-checkpoint.ts';
import { skillStorePath } from '../../agent/skill-registry.ts';
import { getOnboardingCompletionMarkerPath } from '../../runtime/onboarding/index.ts';
import type { AgentWorkspaceLocalEditor } from '../../input/agent-workspace-types.ts';
import { channelDraftSaveHandoff, channelDraftSendHandoff, channelRoutingAssignHandoff, channelRoutingRemoveHandoff } from '../../tools/agent-harness-comms.ts';
import { getDraft, saveDraft, channelDraftFilePath, listDrafts } from '../../agent/channel-draft.ts';
import { listChannelProfileRoutes } from '../../agent/channel-profile-routing.ts';
import { assignChannelToProfile } from '../../agent/channel-profile-routing.ts';
import { harnessCatalogInvocationAuthority } from '../../tools/agent-harness-catalog-ingress.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';
import { EXPLICIT_USER_REQUEST_HEADER } from '../../agent/daemon-operator-client.ts';

const fetchOwner: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis;
let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
const roots: string[] = [];
beforeEach(() => {
  resetSessionUntrustedContentLedgerForTests();
  log = new SqliteDecisionLog(':memory:');
  // A synthetic read disposition deliberately underreports mutation; captured
  // deterministic effect floors must still stop plan/custom-denied effects.
  const fake = fakePort((name, question) => {
    if (question.type === 'choice') {
      const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (label === undefined) throw new Error(`Unexpected question ${name}`);
      return choiceAnswer(question, label, 0.999);
    }
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected question ${name}`);
  });
  prior = installJudgmentPort(withDecisionLog(fake.port, log));
});
afterEach(() => {
  installJudgmentPort(prior); log[Symbol.dispose](); resetSessionUntrustedContentLedgerForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function processScene() {
  const root = makeProjectTempDir('agent-process-effect'); roots.push(root);
  let launches = 0, stops = 0, writes = 0; let duringLaunch: (() => void) | undefined, duringWrite: (() => void) | undefined;
  const manager = new ProcessManager();
  let entry: BackgroundProcess = { id: 'fixture-process', pid: 1, cmd: 'fixture', startTime: 1, stdout: [], stderr: [], exitCode: null, done: false, killDeadline: null };
  manager.getStatus = id => id === entry.id ? entry : undefined;
  manager.spawn = async (_command, _cwd, _env, options) => {
    await Promise.resolve(); duringLaunch?.(); options?.signal?.throwIfAborted(); options?.assertCurrent?.();
    expect(options?.stdin).toBe('pipe');
    launches++; return { cmd: _command, exit_code: null, stdout: '', stderr: '', success: true, process_id: 'fixture-process', pid: 1 };
  };
  manager.writeInput = async (_id, data, options) => {
    options?.assertCurrent?.();
    await Promise.resolve(); duringWrite?.(); options?.signal?.throwIfAborted(); options?.assertCurrent?.();
    writes++; return Buffer.byteLength(data);
  };
  manager.stop = () => { stops++; return true; };
  const workspace = { processManager: manager, shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) };
  const context = { workspace, platform: { config: {}, readModels: {} }, extensions: {}, clients: {}, ops: {} } as CommandContext;
  return { root, manager, workspace, context, launches: () => launches, stops: () => stops, writes: () => writes,
    beforeLaunch(callback: () => void) { duringLaunch = callback; }, beforeWrite(callback: () => void) { duringWrite = callback; },
    replaceEntry() { entry = { ...entry }; } };
}
function sendScene() {
  const requests: ChannelDeliveryRequest[] = []; let beforeSend: (() => void) | undefined;
  const router = new ChannelDeliveryRouter({ strategies: [{ id: 'synthetic-guarded-delivery', supportsGuardedDelivery: true,
    canHandle: () => true, async deliver(request) {
      await Promise.resolve(); beforeSend?.(); request.signal?.throwIfAborted(); request.assertCurrent?.();
      requests.push(request); return { responseId: 'fixture-response' };
    } }] });
  return { router, requests, beforeSend(callback: () => void) { beforeSend = callback; } };
}
const terminalArgs = { command: 'synthetic-intercepted-command', background: true, processClass: 'command' };
const sendArgs = { message: 'A fixture message', channel: 'slack:fixture' };

test('raw confirmation fields cannot launch, stop, write, or send', async () => {
  const process = processScene(); const send = sendScene();
  const asserted = { confirm: true, explicitUserRequest: 'Caller assertion' };
  await expect(createAgentTerminalTool(process.context).execute({ ...terminalArgs, ...asserted })).rejects.toThrow(ToolInputProjectionError);
  await expect(createAgentProcessTool(process.context).execute({ action: 'stop', processId: 'fixture', ...asserted })).rejects.toThrow(ToolInputProjectionError);
  await expect(createAgentProcessTool(process.context).execute({ action: 'write', processId: 'fixture-process', data: 'fixture', ...asserted })).rejects.toThrow(ToolInputProjectionError);
  expect(await createAgentChannelSendTool(send.router).execute({ ...sendArgs, ...asserted })).toMatchObject({ success: false });
  expect(process.launches()).toBe(0); expect(process.stops()).toBe(0); expect(process.writes()).toBe(0); expect(send.requests).toHaveLength(0);
});

test('recorded admission launches, stops, and sends without JSON confirmation', async () => {
  const process = processScene(), send = sendScene();
  expect(await recordedEffectFixture(createAgentTerminalTool(process.context), 'prompt', {}, process.root).run(terminalArgs)).toMatchObject({ success: true });
  expect(await recordedEffectFixture(createAgentProcessTool(process.context), 'prompt', {}, process.root).run({ action: 'stop', processId: 'fixture' })).toMatchObject({ success: true });
  const written = await recordedEffectFixture(createAgentProcessTool(process.context), 'prompt', {}, process.root).run({ action: 'write', processId: 'fixture-process', data: 'fixture input λ' });
  expect(JSON.parse(written.output!)).toMatchObject({ status: 'written', bytesWritten: Buffer.byteLength('fixture input λ') });
  expect(written.output).not.toContain('fixture input λ'); expect(process.writes()).toBe(1);
  expect(await recordedEffectFixture(createAgentChannelSendTool(send.router)).run(sendArgs)).toMatchObject({ success: true });
  expect(process.launches()).toBe(1); expect(process.stops()).toBe(1); expect(send.requests).toHaveLength(1);
  expect(send.requests[0]?.assertCurrent).toBeFunction();
});

test.each(['plan', 'custom'] as const)('recorded synthetic read does not bypass %s mutation floors', async mode => {
  const process = processScene(), send = sendScene(); const deny = mode === 'custom' ? { write: 'deny' as const } : {};
  await expect(recordedEffectFixture(createAgentTerminalTool(process.context), mode, deny, process.root).run(terminalArgs)).rejects.toThrow();
  await expect(recordedEffectFixture(createAgentProcessTool(process.context), mode, deny, process.root).run({ action: 'write', processId: 'fixture-process', data: 'fixture' })).rejects.toThrow();
  const result = await recordedEffectFixture(createAgentChannelSendTool(send.router), mode, deny).run({ ...sendArgs, confirm: true, explicitUserRequest: 'Caller assertion' });
  expect(result.success).toBe(false); expect(process.launches()).toBe(0); expect(process.writes()).toBe(0); expect(send.requests).toHaveLength(0);
});

test('stdin final owner boundary rejects cancellation, revocation, and process replacement', async () => {
  for (const change of ['cancel', 'revoke', 'entry'] as const) {
    const process = processScene(), controller = new AbortController();
    const fixture = recordedEffectFixture(createAgentProcessTool(process.context), 'prompt', {}, process.root);
    process.beforeWrite(() => {
      if (change === 'cancel') controller.abort();
      else if (change === 'revoke') fixture.setMode('plan');
      else process.replaceEntry();
    });
    await expect(fixture.run({ action: 'write', processId: 'fixture-process', data: 'fixture' }, controller.signal)).rejects.toThrow();
    expect(process.writes()).toBe(0);
  }
});

test('launch physical cwd rejects a symlink escape', async () => {
  const process = processScene(); const outside = mkdtempSync(join(tmpdir(), 'agent-process-outside-')); roots.push(outside);
  symlinkSync(outside, join(process.root, 'escape'));
  await expect(recordedEffectFixture(createAgentTerminalTool(process.context), 'prompt', {}, process.root).run({ ...terminalArgs, cwd: 'escape' })).rejects.toThrow();
  expect(process.launches()).toBe(0);
});

test('launch final owner boundary sees cancellation, revocation, and cwd replacement', async () => {
  for (const change of ['cancel', 'revoke', 'cwd'] as const) {
    const process = processScene(), controller = new AbortController();
    const fixture = recordedEffectFixture(createAgentTerminalTool(process.context), 'prompt', {}, process.root);
    process.beforeLaunch(() => {
      if (change === 'cancel') controller.abort();
      else if (change === 'revoke') fixture.setMode('plan');
      else { const replacement = join(process.root, 'changed'); mkdirSync(replacement); process.workspace.shellPaths = createShellPathService({ workingDirectory: replacement, homeDirectory: process.root }); }
    });
    await expect(fixture.run(terminalArgs, controller.signal)).rejects.toThrow(); expect(process.launches()).toBe(0);
  }
});

test('delivery final strategy boundary sees cancellation, revocation, and new taint sources', async () => {
  for (const change of ['cancel', 'revoke', 'taint'] as const) {
    const send = sendScene(), controller = new AbortController(), fixture = recordedEffectFixture(createAgentChannelSendTool(send.router));
    send.beforeSend(() => {
      if (change === 'cancel') controller.abort();
      else if (change === 'revoke') fixture.setMode('plan');
      else getSessionUntrustedContentLedger().record({ surface: 'web-page', origin: 'https://fixture.invalid', at: 'fixture-time', content: 'New source arrived' });
    });
    const result = await fixture.run(sendArgs, controller.signal);
    expect(result.success).toBe(false); expect(send.requests).toHaveLength(0); resetSessionUntrustedContentLedgerForTests();
  }
});

test('preview and process wait stay read-only without confirmation or effect proof', async () => {
  const send = sendScene(), process = processScene();
  const preview = await createAgentChannelSendTool(send.router).execute({ ...sendArgs, preview: true });
  expect(preview).toMatchObject({ success: true }); expect(preview.output).toContain('delivery preview');
  expect(await createAgentProcessTool(process.context).execute({ action: 'wait', processId: 'missing' })).toMatchObject({ success: true });
  expect(process.launches()).toBe(0); expect(send.requests).toHaveLength(0);
});

function commandScene(mode: 'prompt' | 'plan' = 'prompt', translated = false) {
  const process = processScene(), commands = new CommandRegistry(); let effects = 0, nested = 0;
  commands.register({ name: 'synthetic-effect', description: 'Intercepted fixture command.', handler: async (_args, context) => {
    effects++; if (nested) await context.executeCommand?.('synthetic-nested', []);
  } });
  commands.register({ name: 'synthetic-nested', description: 'Intercepted nested fixture command.', handler: () => { effects++; } });
  let before: (() => void) | undefined;
  const tool: Tool = { definition: { name: 'workspace', description: 'Synthetic workspace command route.', sideEffects: ['state'],
    parameters: { type: 'object', properties: {}, additionalProperties: true } }, async execute(args, options) {
    before?.();
    const deps = { commandRegistry: commands, commandContext: process.context, toolRegistry: fixture.registry };
    return translated ? runTranslatedWorkspaceCommand(deps, args, '/synthetic-effect', options) : runCommand(deps, args, {}, options);
  } };
  const fixture = recordedEffectFixture(tool, mode, {}, process.root);
  return { process, commands, fixture, tool, effects: () => effects,
    beforeRun(callback: () => void) { before = callback; }, withNested() { nested = 1; } };
}

test('slash dispatch refuses caller flags and preserves exact original facade admission', async () => {
  const raw = commandScene();
  await expect(raw.tool.execute({ commandName: 'synthetic-effect', confirm: true, explicitUserRequest: 'Caller assertion' })).rejects.toThrow();
  expect(raw.effects()).toBe(0);
  const admitted = commandScene('prompt', true); admitted.withNested();
  expect(await admitted.fixture.run({ actionId: 'synthetic-route' })).toMatchObject({ success: true });
  expect(admitted.effects()).toBe(2);
});

test('slash dispatch refuses plan effects and changed handler after authority sampling', async () => {
  const planned = commandScene('plan');
  await expect(planned.fixture.run({ commandName: 'synthetic-effect' })).rejects.toThrow(); expect(planned.effects()).toBe(0);
  const changed = commandScene(); changed.beforeRun(() => changed.fixture.beforeAuthorityRead(() => {
    const command = changed.commands.get('synthetic-effect');
    if (command) command.handler = () => { throw new Error('Changed handler must never run'); };
  }));
  await expect(changed.fixture.run({ commandName: 'synthetic-effect' })).rejects.toThrow(); expect(changed.effects()).toBe(0);
});

function workspaceScene(mode: 'prompt' | 'plan' = 'prompt') {
  const process = processScene();
  const tool: Tool = { definition: { name: 'agent_harness', description: 'Isolated workspace effect fixture.', sideEffects: ['state'],
    parameters: { type: 'object', properties: {}, additionalProperties: true } }, execute(args, options) {
    return runWorkspaceAction({ commandRegistry: new CommandRegistry(), commandContext: process.context, toolRegistry: fixture.registry }, args, options);
  } };
  const fixture = recordedEffectFixture(tool, mode, {}, process.root);
  return { process, fixture, tool };
}

test('onboarding requires actual admission and writes physically owned markers without request flags', async () => {
  const scene = workspaceScene(); const path = getOnboardingCompletionMarkerPath(scene.process.workspace.shellPaths);
  expect(await scene.tool.execute({ actionId: 'onboarding-apply-close', confirm: true, explicitUserRequest: 'Caller assertion' })).toMatchObject({ success: false });
  expect(existsSync(path)).toBe(false);
  expect(await scene.fixture.run({ actionId: 'onboarding-apply-close' })).toMatchObject({ success: true });
  expect(existsSync(path)).toBe(true);
});

test('onboarding refuses read-only mode and physical user-store escape', async () => {
  const planned = workspaceScene('plan');
  await expect(planned.fixture.run({ actionId: 'onboarding-apply-close' })).rejects.toThrow();
  expect(existsSync(getOnboardingCompletionMarkerPath(planned.process.workspace.shellPaths))).toBe(false);
  const escaped = workspaceScene(); const outside = mkdtempSync(join(tmpdir(), 'agent-onboarding-outside-')); roots.push(outside);
  symlinkSync(outside, join(escaped.process.root, '.goodvibes'));
  await expect(escaped.fixture.run({ actionId: 'onboarding-apply-close' })).rejects.toThrow();
  expect(existsSync(join(outside, 'agent', 'onboarding-complete.json'))).toBe(false);
});

test('checkpoint clear authenticates at the concrete owner boundary', async () => {
  const process = processScene(), paths = process.workspace.shellPaths;
  saveSetupWizardCheckpoint(paths, { currentStepId: 'fixture', currentStepLabel: 'Fixture', source: 'harness' });
  const checkpoint = setupWizardCheckpointPath(paths);
  expect(() => clearSetupCheckpoint(process.context, { confirm: true, explicitUserRequest: 'Caller assertion' })).toThrow();
  expect(existsSync(checkpoint)).toBe(true);
  const fixture = recordedEffectFixture({ definition: { name: 'checkpoint-fixture', description: 'Isolated checkpoint removal.', parameters: {} },
    execute(args, options) { clearSetupCheckpoint(process.context, args, options); return Promise.resolve({ success: true }); } }, 'prompt', {}, process.root);
  expect(await fixture.run({})).toMatchObject({ success: true }); expect(existsSync(checkpoint)).toBe(false);
});

test('learned-behavior creation does not require a human editor confirmation field', async () => {
  const process = processScene();
  const editor: AgentWorkspaceLocalEditor = { kind: 'learned-behavior', mode: 'create', title: 'Fixture', selectedFieldIndex: 0, message: '', fields: [
    { id: 'target', label: 'Target', value: 'skill', required: true, multiline: false, hint: '' },
    { id: 'name', label: 'Name', value: 'Fixture skill', required: true, multiline: false, hint: '' },
    { id: 'description', label: 'Description', value: 'Fixture skill description', required: true, multiline: false, hint: '' },
    { id: 'notes', label: 'Notes', value: 'Fixture procedure', required: true, multiline: false, hint: '' },
    { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Historical human field' },
  ] };
  const tool: Tool = { definition: { name: 'workspace-editor-fixture', description: 'Isolated learned behavior creation.', parameters: {} },
    execute(args, options) { return runWorkspaceEditorAction({ commandRegistry: new CommandRegistry(), commandContext: process.context, toolRegistry: fixture.registry },
      { id: 'learned-behavior', kind: 'editor', editorKind: 'learned-behavior', label: 'Fixture', detail: 'Fixture', safety: 'safe' }, editor, args, options); } };
  const fixture = recordedEffectFixture(tool, 'prompt', {}, process.root);
  expect(await fixture.run({})).toMatchObject({ success: true }); expect(existsSync(skillStorePath(process.workspace.shellPaths))).toBe(true);
});

test.each(['absent', 'provided'] as const)('workspace model child preserves %s audit provenance without inventing confirmation', async provenance => {
  const process = processScene(); const children: Record<string, unknown>[] = [];
  const editor: AgentWorkspaceLocalEditor = { kind: 'artifact-export-file', mode: 'create', title: 'Fixture export', selectedFieldIndex: 0, message: '', fields: [
    { id: 'artifactId', label: 'Artifact', value: 'fixture-artifact', required: true, multiline: false, hint: '' },
    { id: 'destinationPath', label: 'Destination', value: join(process.root, 'fixture-export.txt'), required: true, multiline: false, hint: '' },
  ] };
  const tool: Tool = { definition: { name: 'workspace-model-child-fixture', description: 'Intercepted nested export boundary.', parameters: {} },
    execute(args, options) {
      return runWorkspaceEditorAction({ commandRegistry: new CommandRegistry(), commandContext: process.context, toolRegistry: fixture.registry },
        { id: 'artifact-export', kind: 'editor', editorKind: 'artifact-export-file', label: 'Fixture', detail: 'Fixture', safety: 'safe' }, editor, args, options);
    } };
  const fixture = recordedEffectFixture(tool, 'prompt', {}, process.root);
  fixture.registry.register({ definition: { name: 'agent_artifacts', description: 'Intercepted artifact export owner.', parameters: { type: 'object', additionalProperties: true } },
    async execute(args, options) {
      if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
      children.push(args); return { success: true };
    } });
  expect(await tool.execute({ confirm: true, explicitUserRequest: 'Raw caller claim' })).toMatchObject({ success: false });
  expect(children).toHaveLength(0);
  const args = provenance === 'provided' ? { explicitUserRequest: 'Provided fixture audit text' } : {};
  expect(await fixture.run(args)).toMatchObject({ success: true }); expect(children).toHaveLength(1);
  expect(children[0]).not.toHaveProperty('confirm');
  if (provenance === 'provided') expect(children[0]?.explicitUserRequest).toBe('Provided fixture audit text');
  else expect(children[0]).not.toHaveProperty('explicitUserRequest');
});

test('local workspace mutation obtains fresh child admission without caller flags', async () => {
  const process = processScene(); let effects = 0;
  const tool: Tool = { definition: { name: 'workspace-local-fixture', description: 'Isolated nested local mutation.', parameters: {} },
    execute(args, options) { return runLocalWorkspaceAction({ commandContext: process.context, toolRegistry: fixture.registry },
      { id: 'notes-delete', kind: 'local-operation', localOperation: 'note-delete', label: 'Fixture', detail: 'Fixture', safety: 'safe' }, args, options); } };
  const fixture = recordedEffectFixture(tool, 'prompt', {}, process.root);
  fixture.registry.register({ definition: { name: 'agent_local_registry', description: 'Intercepted local fixture deletion.', parameters: { type: 'object', additionalProperties: true } },
    async execute(args, options) { if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held'); effects++; return { success: true }; } });
  expect(await fixture.run({ recordId: 'fixture-record' })).toMatchObject({ success: true }); expect(effects).toBe(1);
});

test('draft and routing writes use original admission and cannot be forged with caller flags', async () => {
  const process = processScene();
  const save: Tool = { definition: { name: 'draft-fixture', description: 'Isolated draft write.', parameters: {} },
    async execute(args, options) { const result = await channelDraftSaveHandoff(process.context, args, options); return { success: typeof result !== 'string', output: JSON.stringify(result) }; } };
  const args = { draftMessage: 'Fixture draft', draftChannel: 'slack:fixture' };
  expect(await save.execute({ ...args, confirm: true, explicitUserRequest: 'Caller assertion' })).toMatchObject({ success: false });
  const saved = await recordedEffectFixture(save, 'prompt', {}, process.root).run(args);
  expect(saved.success).toBe(true);
  const id = JSON.parse(saved.output!).draft.id;
  expect(getDraft(process.workspace.shellPaths, id)?.message).toBe('Fixture draft');
  const assign: Tool = { definition: { name: 'route-fixture', description: 'Isolated route write.', parameters: {} },
    async execute(args, options) { const result = await channelRoutingAssignHandoff(process.context, args, options); return { success: typeof result !== 'string', output: JSON.stringify(result) }; } };
  const route = await recordedEffectFixture(assign, 'prompt', {}, process.root).run({ surfaceKind: 'slack', profileId: 'fixture-profile' });
  expect(route.success).toBe(true);
  expect(listChannelProfileRoutes(process.workspace.shellPaths).routes).toHaveLength(1);
  const remove: Tool = { definition: { name: 'route-remove-fixture', description: 'Isolated route removal.', parameters: {} },
    async execute(args, options) { const result = channelRoutingRemoveHandoff(process.context, args, options); return { success: typeof result !== 'string', output: JSON.stringify(result) }; } };
  expect(await recordedEffectFixture(remove, 'prompt', {}, process.root).run({ draftRoute: JSON.parse(route.output!).route.id })).toMatchObject({ success: true });
  expect(listChannelProfileRoutes(process.workspace.shellPaths).routes).toHaveLength(0);
  await expect(recordedEffectFixture(save, 'plan', {}, process.root).run(args)).rejects.toThrow();
});

test.each(['draft', 'route'] as const)('admitted %s synchronization selects fresh native admission without claiming a human request', async kind => {
  const process = processScene();
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: process.root, homeDir: process.root,
    configDir: join(process.root, '.goodvibes', 'agent') });
  const tokenPath = connectedHostOperatorTokenPath(process.root);
  mkdirSync(join(process.root, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: 'fixture-comms-private-token' }));
  const context: CommandContext = { ...process.context, platform: { ...process.context.platform, configManager: config } };
  const requests: Array<{ input: Record<string, unknown>; headers: Headers }> = [];
  const connectedEnv = globalThis.process.env.GOODVIBES_CONNECTED_HOST_TOKEN, daemonEnv = globalThis.process.env.GOODVIBES_DAEMON_TOKEN;
  delete globalThis.process.env.GOODVIBES_CONNECTED_HOST_TOKEN; delete globalThis.process.env.GOODVIBES_DAEMON_TOKEN;
  const fetchSpy = spyOn(fetchOwner, 'fetch').mockImplementation(async (_url, init) => {
    requests.push({ input: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json(kind === 'draft' ? { saved: true } : { assignmentId: 'fixture-native-assignment' });
  });
  try {
    const tool: Tool = { definition: { name: 'comms-native-selection-fixture', description: 'Intercepted native channel synchronization.', parameters: {} },
      async execute(args, options) {
        const result = kind === 'draft' ? await channelDraftSaveHandoff(context, args, options) : await channelRoutingAssignHandoff(context, args, options);
        return { success: typeof result !== 'string', output: JSON.stringify(result) };
      } };
    const args = kind === 'draft' ? { draftMessage: 'Fixture native draft', draftChannel: 'slack:fixture' }
      : { surfaceKind: 'slack', profileId: 'fixture-native-profile' };
    expect(await tool.execute({ ...args, admission: 'autonomous', confirm: true, explicitUserRequest: 'Caller claim' })).toMatchObject({ success: false });
    expect(requests).toHaveLength(0);
    await expect(recordedEffectFixture(tool, 'plan', {}, process.root).run(args)).rejects.toThrow();
    expect(requests).toHaveLength(0);
    const result = await recordedEffectFixture(tool, 'prompt', {}, process.root).run(args);
    expect(result.success).toBe(true); expect(requests).toHaveLength(1);
    expect(requests[0]?.input.admission).toBe('autonomous');
    expect(requests[0]?.input).not.toHaveProperty('confirm'); expect(requests[0]?.input).not.toHaveProperty('explicitUserRequest');
    expect(requests[0]?.headers.get(EXPLICIT_USER_REQUEST_HEADER)).toBeNull();
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer fixture-comms-private-token');
    expect(result.output).not.toContain('fixture-comms-private-token');
  } finally {
    fetchSpy.mockRestore();
    if (connectedEnv === undefined) delete globalThis.process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
    else globalThis.process.env.GOODVIBES_CONNECTED_HOST_TOKEN = connectedEnv;
    if (daemonEnv === undefined) delete globalThis.process.env.GOODVIBES_DAEMON_TOKEN;
    else globalThis.process.env.GOODVIBES_DAEMON_TOKEN = daemonEnv;
  }
});

test('draft send retains selected content, taint, and admission at the final delivery boundary', async () => {
  for (const change of ['none', 'cancel', 'revoke', 'draft', 'taint', 'empty-turn'] as const) {
    const process = processScene(), send = sendScene(), controller = new AbortController();
    const context: CommandContext = { ...process.context, platform: { ...process.context.platform, channelDeliveryRouter: send.router } };
    const saved = await saveDraft(process.workspace.shellPaths, { message: 'Fixture draft', channel: 'slack:fixture' });
    const tool: Tool = { definition: { name: 'draft-send-fixture', description: 'Intercepted draft delivery.', parameters: {} },
      async execute(args, options) { const result = await channelDraftSendHandoff(context, args, options); return { success: typeof result !== 'string' && result.status === 'sent', output: JSON.stringify(result) }; } };
    const fixture = recordedEffectFixture(tool, 'prompt', {}, process.root);
    send.beforeSend(() => {
      if (change === 'cancel') controller.abort();
      else if (change === 'revoke') fixture.setMode('plan');
      else if (change === 'draft') {
        const path = channelDraftFilePath(process.workspace.shellPaths);
        writeFileSync(path, readFileSync(path, 'utf8').replace('Fixture draft', 'Changed fixture'));
      } else if (change === 'taint') getSessionUntrustedContentLedger().record({ surface: 'web-page', origin: 'https://fixture.invalid', at: 'fixture-time', content: 'New source' });
      else if (change === 'empty-turn') getSessionUntrustedContentLedger().startTurn();
    });
    const result = await fixture.run({ draftId: saved.draft.id }, controller.signal);
    expect(result.success).toBe(change === 'none');
    expect(send.requests).toHaveLength(change === 'none' ? 1 : 0);
    expect(getDraft(process.workspace.shellPaths, saved.draft.id)?.status).toBe(change === 'none' ? 'sent' : 'queued');
    resetSessionUntrustedContentLedgerForTests();
  }
});

test('generated draft references remain usable when the creation timestamp has a card-number shape', async () => {
  setSystemTime(new Date('2026-10-11T00:00:01.000Z'));
  try {
    const process = processScene(), send = sendScene();
    const context: CommandContext = { ...process.context, platform: { ...process.context.platform, channelDeliveryRouter: send.router } };
    const saved = await saveDraft(process.workspace.shellPaths, { message: 'Fixture timestamp draft', channel: 'slack:fixture' });
    const tool: Tool = { definition: { name: 'draft-id-fixture', description: 'Intercepted delivery of a generated draft reference.', parameters: {} },
      async execute(args, options) {
        const result = await channelDraftSendHandoff(context, args, options);
        return { success: typeof result !== 'string' && result.status === 'sent', output: JSON.stringify(result) };
      } };
    expect(await recordedEffectFixture(tool, 'prompt', {}, process.root).run({ draftId: saved.draft.id })).toMatchObject({ success: true });
    expect(send.requests).toHaveLength(1);
  } finally { setSystemTime(); }
});

test('generated routing references remain removable when the creation timestamp has a card-number shape', async () => {
  setSystemTime(new Date('2026-10-11T00:00:01.000Z'));
  try {
    const process = processScene();
    const route = await assignChannelToProfile(process.workspace.shellPaths, { surfaceKind: 'slack', profileId: 'fixture-profile' });
    const tool: Tool = { definition: { name: 'generated-route-remove-fixture', description: 'Isolated routing reference removal.', parameters: {} },
      async execute(args, options) {
        const result = channelRoutingRemoveHandoff(process.context, args, options);
        return { success: typeof result !== 'string', output: JSON.stringify(result) };
      } };
    expect(await recordedEffectFixture(tool, 'prompt', {}, process.root).run({ draftRoute: route.route.id })).toMatchObject({ success: true });
    expect(listChannelProfileRoutes(process.workspace.shellPaths).routes).toHaveLength(0);
  } finally { setSystemTime(); }
});

test.each(['context', 'router', 'strategy', 'late-context', 'late-router', 'late-strategy'] as const)(
  'draft delivery rejects %s accessors without invoking them', async change => {
    const process = processScene(), send = sendScene();
    const saved = await saveDraft(process.workspace.shellPaths, { message: 'Accessor boundary fixture', channel: 'slack:fixture' });
    const context: CommandContext = { ...process.context, platform: { ...process.context.platform, channelDeliveryRouter: send.router } };
    const strategy = send.router.listStrategies()[0];
    if (!strategy) throw new Error('Missing intercepted delivery strategy');
    let getters = 0;
    const replace = () => {
      const subject = change.endsWith('context') ? context : change.endsWith('router') ? send.router : strategy;
      const field = change.endsWith('context') ? 'platform' : change.endsWith('router') ? 'deliver' : 'canHandle';
      Object.defineProperty(subject, field, { configurable: true, get() { getters++; throw new Error('Replacement getter was invoked'); } });
    };
    if (change.startsWith('late-')) send.beforeSend(replace); else replace();
    const tool: Tool = { definition: { name: 'draft-source-descriptor-fixture', description: 'Intercepted native source accessor boundary.', parameters: {} },
      async execute(args, options) {
        const result = await channelDraftSendHandoff(context, args, options);
        return { success: typeof result !== 'string' && result.status === 'sent', output: JSON.stringify(result) };
      } };
    const result = await recordedEffectFixture(tool, 'prompt', {}, process.root).run({ draftId: saved.draft.id })
      .then(value => value, (error: unknown) => error);
    expect(result instanceof Error || typeof result === 'object' && result !== null && 'success' in result && result.success === false).toBe(true);
    expect(getters).toBe(0); expect(send.requests).toHaveLength(0);
    expect(getDraft(process.workspace.shellPaths, saved.draft.id)?.status).toBe(change.startsWith('late-') ? 'queued' : 'draft');
  });

test('draft and route stores cannot publish an old snapshot after the daemon await', async () => {
  for (const kind of ['draft', 'route'] as const) for (const change of ['source', 'revoke', 'cancel'] as const) {
    const process = processScene(), controller = new AbortController();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), pending = new Promise<void>(resolve => { started = resolve; });
    const tool: Tool = { definition: { name: 'channel-store-fixture', description: 'Isolated daemon await and local store boundary.', parameters: {} },
      async execute(args, options) {
        const assertCurrent = () => {
          options?.signal?.throwIfAborted();
          if (!harnessCatalogInvocationAuthority(args, options, 'write')) throw new ToolInputProjectionError('held');
        };
        const invoke = async (methodId: string) => { started(); await gate; return { ok: true as const, methodId, route: 'synthetic-route', body: { assignmentId: 'synthetic-assignment' } }; };
        const guards = { signal: options?.signal, assertCurrent, invoke };
        if (kind === 'draft') await saveDraft(process.workspace.shellPaths, { message: 'Original admitted draft' }, guards);
        else await assignChannelToProfile(process.workspace.shellPaths, { surfaceKind: 'slack', profileId: 'original-profile' }, guards);
        return { success: true };
      } };
    const fixture = recordedEffectFixture(tool, 'prompt', {}, process.root);
    const result = fixture.run({}, controller.signal); const settled = result.then(() => undefined, (error: unknown) => error);
    await pending;
    if (change === 'cancel') controller.abort();
    else if (change === 'revoke') fixture.setMode('plan');
    else if (kind === 'draft') await saveDraft(process.workspace.shellPaths, { message: 'Concurrent source' });
    else await assignChannelToProfile(process.workspace.shellPaths, { surfaceKind: 'slack', profileId: 'concurrent-profile' });
    release(); expect(await settled).toBeInstanceOf(Error);
    if (kind === 'draft') expect(listDrafts(process.workspace.shellPaths).drafts.every(draft => draft.message !== 'Original admitted draft')).toBe(true);
    else expect(listChannelProfileRoutes(process.workspace.shellPaths).routes.every(route => route.profileId !== 'original-profile')).toBe(true);
  }
});
