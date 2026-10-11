import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ConfigManager, DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { assertCurrentToolInvocation, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createHarnessCatalogInputProjector } from '../../tools/agent-harness-catalog-ingress.ts';
import { createAgentSetupTool, registerAgentSetupTool } from '../../tools/agent-setup-tool.ts';
import { executeNestedSetupSmoke, resolveSetupSmokeNativeEvidence } from '../../tools/agent-setup-smoke-reference.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog, readings: ReturnType<typeof fakePort>;
let onDisposition: ((tool: string) => 'act' | 'reject' | undefined) | undefined;
const roots: string[] = [];
beforeEach(() => {
  onDisposition = undefined;
  readings = fakePort((name, question, state) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    const owner = state && typeof state === 'object' && !Array.isArray(state) ? state.input : undefined;
    const tool = owner && typeof owner === 'object' && !Array.isArray(owner) && typeof owner.tool === 'string' ? owner.tool : '';
    const label = name === 'disposition' ? onDisposition?.(tool) ?? 'act' : name === 'kind' ? 'read'
      : name === 'family' || name === 'capability' ? 'generic' : undefined;
    if (!label) throw new Error(`Unexpected recorded setup fixture question ${name}`);
    return choiceAnswer(question, label, 0.999);
  });
  log = new SqliteDecisionLog(':memory:'); prior = installJudgmentPort(withDecisionLog(readings.port, log));
});
afterEach(() => {
  installJudgmentPort(prior); log[Symbol.dispose]();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = makeProjectTempDir('registered-setup-facade'); roots.push(root);
  const store = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  const context = { platform: { artifactStore: store, configManager }, workspace: { shellPaths: { workingDirectory: root, homeDirectory: root } } } as unknown as CommandContext;
  let mode: PermissionMode = 'prompt', sequence = 0;
  const source = { goal: 'Complete only the requested synthetic setup operation in this isolated fixture',
    criteria: ['Keep original user-run credential values private and use freshly recorded registered child tools'] };
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode });
  const reader: PermissionConfigReader = { getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: root }),
    getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => root };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState()), registry = new ToolRegistry(manager);
  const calls: Record<string, unknown>[] = [], executed: { name: string; args: Record<string, unknown>; options: Parameters<Tool['execute']>[1] }[] = [];
  let retainedParent: { args: Record<string, unknown>; options: Parameters<Tool['execute']>[1] } | undefined;
  let inspectParent: ((args: Record<string, unknown>, options: Parameters<Tool['execute']>[1]) => Promise<void>) | undefined;
  function child(name: string): Tool {
    return { definition: { name, description: 'Recorded synthetic setup child with the actual smoke source owner and native artifact writer.', sideEffects: ['state'],
      parameters: { type: 'object', additionalProperties: true } }, async execute(args, options) {
      expect(assertCurrentToolInvocation(args, options)).toBe(true);
      executed.push({ name, args, options });
      const callable = { ...args }; delete callable.nativeReferenceSubjects;
      if (args.mode === 'run_setup_smoke') {
        const evidence = resolveSetupSmokeNativeEvidence(args, options, context);
        if (args.fields) callable.fields = Object.fromEntries(evidence.fields.map(field => [field.id, field.value]));
        evidence.assertCurrent();
        await evidence.createArtifact?.({ kind: 'document', text: evidence.fields.map(field => field.value).join('\n'), metadata: { purpose: 'agent-setup-smoke-evidence' } });
        evidence.assertCurrent();
      }
      calls.push(callable);
      return { success: true, output: JSON.stringify({ name, args: callable }) };
    } };
  }
  const harness = child('agent_harness'), settings = child('import_goodvibes_settings');
  registry.register(harness, { inputProjection: createHarnessCatalogInputProjector(registry, undefined, undefined, context) });
  registry.register(settings);
  registerAgentSetupTool(registry, {} as CommandRegistry, context);
  const tool = registry.list().find(tool => tool.definition.name === 'setup')!;
  const original = tool.execute;
  tool.execute = async (args, options) => { retainedParent = { args, options }; await inspectParent?.(args, options); return original(args, options); };
  const run = async (args: Record<string, unknown>, signal?: AbortSignal, afterPrepare?: () => void) => {
    const call = await registry.prepareCall(`setup-fixture-${++sequence}`, 'setup', args, { signal });
    afterPrepare?.();
    const admission = await manager.admitAutonomous(call.callId, call.name, call.args, { signal, schemaRevision: call.schemaRevision,
      preparedCall: { registry, call }, sourceOf: () => source });
    return registry.executePrepared(call, admission);
  };
  return { root, store, context, registry, tool, harness, calls, executed, run, source,
    retained: () => retainedParent!, setMode(value: PermissionMode) { mode = value; }, rawBody: original,
    inspectParent(callback: NonNullable<typeof inspectParent>) { inspectParent = callback; } };
}

describe('setup adapter', () => {
  test('routes status and item reads to the existing harness setup modes', async () => {
    const f = fixture();
    await f.run({ action: 'status', includeParameters: true, query: 'host' });
    await f.run({ mode: 'show', itemId: 'provider-access' });
    await f.run({ action: 'repair', setupItemId: 'connected-host-readiness', includeParameters: true });
    expect(f.calls).toEqual([
      { mode: 'setup_posture', query: 'host', includeParameters: true },
      { mode: 'setup_item', setupItemId: 'provider-access' },
      { mode: 'setup_repair', setupItemId: 'connected-host-readiness', includeParameters: true },
    ]);
  });

  test('routes checkpoints, token provisioning, smoke, and finish through harness effects', async () => {
    const f = fixture();
    await f.run({ action: 'checkpoint' });
    await f.run({ action: 'save_checkpoint', setupItemId: 'install-smoke', confirm: true, explicitUserRequest: 'Save my setup checkpoint.' });
    await f.run({ action: 'clear_checkpoint', explicitUserRequest: 'Clear my setup checkpoint.' });
    await f.run({ action: 'token', confirm: true, explicitUserRequest: 'Repair connected-host auth.' });
    await f.run({ action: 'smoke', fields: { firstAssistantTurn: 'ready' }, confirm: true, explicitUserRequest: 'Run setup smoke.' });
    await f.run({ action: 'finish', confirm: true, explicitUserRequest: 'Finish setup.' });
    expect(f.calls).toEqual([
      { mode: 'setup_checkpoint' },
      { mode: 'mark_setup_checkpoint', setupItemId: 'install-smoke', confirm: true, explicitUserRequest: 'Save my setup checkpoint.' },
      { mode: 'clear_setup_checkpoint', explicitUserRequest: 'Clear my setup checkpoint.' },
      { mode: 'provision_connected_host_token', setupItemId: 'connected-host-auth', confirm: true, explicitUserRequest: 'Repair connected-host auth.' },
      { mode: 'run_setup_smoke', setupItemId: 'install-smoke', fields: { firstAssistantTurn: 'ready' }, confirm: true, explicitUserRequest: 'Run setup smoke.' },
      { mode: 'run_workspace_action', actionId: 'onboarding-apply-close', confirm: true, explicitUserRequest: 'Finish setup.' },
    ]);
  });

  test('routes settings import preview and confirmed apply to the import adapter', async () => {
    const f = fixture();
    await f.run({ action: 'import_settings' });
    await f.run({ action: 'import_settings', confirm: true, explicitUserRequest: 'Import my GoodVibes settings.' });
    expect(f.calls).toEqual([{ action: 'preview' }, { action: 'apply', confirm: true, explicitUserRequest: 'Import my GoodVibes settings.' }]);
  });

  test('registers the direct setup adapter', () => {
    const registry = new ToolRegistry();
    registerAgentSetupTool(registry, {} as CommandRegistry, {} as CommandContext);
    expect(registry.has('setup')).toBe(true);
  });

  test('flags and forged native context do not authorize raw setup bodies', async () => {
    const f = fixture(), args = { action: 'smoke', fields: { notes: 'ready' }, confirm: true, explicitUserRequest: 'Caller claim' };
    const raw = createAgentSetupTool({ commandContext: f.context, toolRegistry: f.registry });
    expect((await raw.execute(args)).success).toBe(false);
    expect((await raw.execute(args, { inputProjectionContext: Object.freeze({}) })).success).toBe(false);
    expect(f.calls).toEqual([]); expect(readings.requests).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
  });

  test('active copied parent arguments or options cannot dispatch a child', async () => {
    const f = fixture();
    f.inspectParent(async (args, options) => {
      const before = readings.requests.length;
      await expect(f.rawBody({ ...args }, options)).rejects.toThrow();
      await expect(f.rawBody(args, { ...options })).rejects.toThrow();
      await expect(executeNestedSetupSmoke(new ToolRegistry(), 'other-registry-parent', args, options,
        { mode: 'run_setup_smoke', setupItemId: 'install-smoke', fields: args.fields }, f.context)).rejects.toThrow();
      expect(f.executed).toHaveLength(0); expect(readings.requests).toHaveLength(before);
    });
    expect((await f.run({ action: 'smoke', fields: { notes: 'ready' } })).success).toBe(true);
    expect(f.executed).toHaveLength(1); expect(f.store.list()).toHaveLength(1);
  });

  test('raw setup refuses caller accessors before reading them', async () => {
    const f = fixture(); let getters = 0;
    const args = Object.defineProperty({}, 'action', { get() { getters++; return 'smoke'; } });
    expect((await f.tool.execute(args)).success).toBe(false); expect(getters).toBe(0);
    expect(readings.requests).toHaveLength(0); expect(f.calls).toEqual([]);
  });

  test.each(['smoke', 'run_smoke', 'install-smoke'] as const)('native %s route transfers the immutable private source into a distinct admitted child', async alias => {
    const f = fixture(), raw = { mode: alias, itemId: 'install-smoke', fields: { notes: 'safe-before\nAuthorization: Basic cHJpdmF0ZS1mYWNhZGU=\nsafe-after' } };
    const result = await f.run(raw, undefined, () => { raw.fields.notes = '4111111111111111'; });
    expect(result.success).toBe(true); expect(f.store.list()).toHaveLength(1); expect(f.executed).toHaveLength(1);
    const child = f.executed[0]!, parent = f.retained();
    expect(child.options).not.toBe(parent.options); expect(child.options?.inputProjectionContext).not.toBe(parent.options?.inputProjectionContext);
    expect(child.args.fields).toEqual({ notes: 'native-smoke:notes' });
    const artifact = (await f.store.readContent(f.store.list()[0]!.id)).buffer.toString();
    const outward = `${JSON.stringify(readings.requests)}${result.output}${artifact}`;
    expect(outward).not.toContain('cHJpdmF0ZS1mYWNhZGU='); expect(outward).not.toContain('4111111111111111');
    expect(artifact).toBe('safe-before\nAuthorization: <redacted>\nsafe-after');
    const sourceReadings = readings.requests.filter(request => request.context?.battery === 'engine.gate.autonomous-disposition');
    expect(sourceReadings.length).toBeGreaterThanOrEqual(2);
    for (const request of sourceReadings) {
      expect(JSON.stringify(request)).toContain(f.source.goal);
      for (const criterion of f.source.criteria) expect(JSON.stringify(request)).toContain(criterion);
    }
    const before = readings.requests.length;
    await expect(executeNestedSetupSmoke(f.registry, 'expired-smoke-parent', parent.args, parent.options,
      { mode: 'run_setup_smoke', setupItemId: 'install-smoke', fields: parent.args.fields }, f.context)).rejects.toThrow();
    expect(readings.requests).toHaveLength(before); expect(f.store.list()).toHaveLength(1);
  });

  test.each(['card-after-credential', 'card-after-display-cap', 'encoded-issuer', 'unselected-field', 'unrelated-action', 'other-item'] as const)('%s cannot obtain native setup smoke intake', async kind => {
    const f = fixture();
    const args = kind === 'card-after-credential' ? { action: 'smoke', fields: { notes: 'Authorization: Basic private-facade\n4111111111111111' } }
      : kind === 'card-after-display-cap' ? { action: 'smoke', fields: { notes: `${'safe '.repeat(2000)}4111111111111111` } }
      : kind === 'encoded-issuer' ? { action: 'smoke', fields: { notes: '{"ordinary":"\\u0067hp_' + 'a'.repeat(36) + '"}' } }
      : kind === 'unselected-field' ? { action: 'smoke', fields: { notes: 'ready', extra: 'password=private-facade' } }
      : kind === 'unrelated-action' ? { action: 'status', fields: { notes: 'apiKey=private-facade' } }
      : { action: 'smoke', itemId: 'other-item', fields: { notes: 'apiKey=private-facade' } };
    await expect(f.run(args)).rejects.toThrow();
    expect(readings.requests).toHaveLength(0); expect(f.executed).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
  });

  test('fresh child refusal prevents effects under a genuinely admitted parent', async () => {
    const f = fixture(); onDisposition = tool => tool === 'agent_harness' ? 'reject' : 'act';
    const result = await f.run({ action: 'smoke', fields: { notes: 'ready' } });
    expect(result.success).toBe(false); expect(result.error).toContain('Nested tool admission reject');
    expect(f.executed).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
  });

  test.each(['plan', 'cancel', 'store', 'workspace', 'config', 'executor', 'schema', 'source'] as const)('late %s change prevents the freshly admitted smoke child from publishing', async kind => {
    const f = fixture(), controller = new AbortController(); let changed = false, readingsAtChange = -1;
    onDisposition = tool => {
      if (tool === 'agent_harness' && !changed) {
        changed = true;
        if (kind === 'plan') f.setMode('plan');
        if (kind === 'cancel') controller.abort();
        if (kind === 'store') (f.context.platform as unknown as { artifactStore: unknown }).artifactStore = {};
        if (kind === 'workspace') (f.context.workspace.shellPaths as { workingDirectory: string }).workingDirectory = join(f.root, 'changed');
        if (kind === 'config') (f.context.platform as unknown as { configManager: unknown }).configManager = {};
        if (kind === 'executor') f.harness.execute = async () => { throw new Error('Replaced child must not run'); };
        if (kind === 'schema') f.harness.definition = { ...f.harness.definition, description: 'Changed selected schema owner.' };
        if (kind === 'source') f.source.goal = 'Changed original host goal.';
        readingsAtChange = readings.requests.length;
      }
      return 'act';
    };
    await expect(f.run({ action: 'smoke', fields: { notes: 'ready' } }, controller.signal)).rejects.toThrow();
    expect(changed).toBe(true); expect(f.executed).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
    expect(readings.requests).toHaveLength(readingsAtChange);
    expect(readdirSync(join(f.root, 'artifacts'))).toHaveLength(0);
  });

  test('child cancellation retains native writer drainage and prevents artifact publication', async () => {
    const f = fixture(), controller = new AbortController(), original = f.store.create; let started = false;
    f.store.create = async function (input, ownership) {
      started = true;
      const pending = original.call(this, input, ownership);
      controller.abort();
      return pending;
    };
    await expect(f.run({ action: 'smoke', fields: { notes: 'ready' } }, controller.signal)).rejects.toThrow();
    expect(started).toBe(true);
    expect(f.store.list()).toHaveLength(0); expect(readdirSync(join(f.root, 'artifacts'))).toHaveLength(0);
  });
});
