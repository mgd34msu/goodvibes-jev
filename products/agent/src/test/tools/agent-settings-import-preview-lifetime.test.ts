import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { SandboxSessionRegistry } from '@goodvibes-jev/engine/sdk/platform/runtime/sandbox';
import { ToolInputProjectionError, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ConfigManager } from '../../config/index.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../config/secret-config.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { ConversationManager } from '../../core/conversation.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { createAgentHarnessTool, registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { isAgentSettingsImportMutation } from '../../tools/agent-settings-import-admission.ts';
import { isHarnessSettingsQuery } from '../../tools/agent-harness-settings-catalog.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';
import { createTestProviderRegistry } from '../helpers/test-managers.ts';

type ExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;
type AdmissionResult = Pick<Awaited<ReturnType<Tool['execute']>>, 'success' | 'error' | 'output'>;
const request = () => ({ mode: 'run_workspace_action', actionId: 'import-goodvibes-tui-settings' });
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { await cleanupResearchScreeningFixtures(); installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

function fixture(screening: Parameters<typeof researchScreeningFixture>[0] = {}) {
  const root = makeProjectTempDir('settings-preview-lifetime');
  const workingDirectory = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory); mkdirSync(homeDirectory);
  const paths = createShellPathService({ workingDirectory, homeDirectory });
  const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: workingDirectory, homeDir: homeDirectory });
  const secrets = new SecretsManager({ projectRoot: workingDirectory, globalHome: homeDirectory, configManager: config });
  const subscriptions = new SubscriptionManager(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'subscriptions.json'));
  const source = researchScreeningFixture(screening);
  const registry = new ToolRegistry();
  bindAgentResearchSourceOwner(registry, source.owner);
  const context: CommandContext = {
    print: () => {}, renderRequest: () => {}, exit: () => {},
    workspace: { shellPaths: paths },
    platform: { config: config.getAll(), configManager: config, secretsManager: secrets, subscriptionManager: subscriptions },
    session: { conversationManager: new ConversationManager(() => 80, config), runtime: {
      sessionId: 'settings-preview-native', model: 'fixture', provider: 'fixture', debugMode: false, systemPrompt: '', reasoningEffort: 'medium',
    } },
    provider: { providerRegistry: createTestProviderRegistry() },
    ops: {}, clients: {}, extensions: { toolRegistry: registry, mcpRegistry: new McpRegistry({
      hookDispatcher: { fire: async () => ({ ok: true }) }, sandboxSessions: new SandboxSessionRegistry(root),
    }) },
  };
  const commands = new CommandRegistry();
  const deps = { commandContext: context, commandRegistry: commands, toolRegistry: registry };
  const tool = createAgentHarnessTool(deps);
  const path = paths.resolveUserPath('tui', 'settings.json');
  mkdirSync(paths.resolveUserPath('tui'), { recursive: true });
  const nextSaveHistory = !config.get('behavior.saveHistory');
  const token = `xoxb-${'N'.repeat(32)}`;
  const callerRetirementReason = new Error('Original caller retired');
  writeFileSync(path, JSON.stringify({ behavior: { saveHistory: nextSaveHistory }, surfaces: { slack: { botToken: token } } }));
  return { root, paths, path, config, secrets, subscriptions, source, registry, context, deps, tool, token, nextSaveHistory, callerRetirementReason,
    async preview(args: Record<string, unknown> = request(), options?: ExecuteOptions) {
      try { return await tool.execute(args, options); }
      catch (error) {
        if (!(error instanceof ToolInputProjectionError) && error !== callerRetirementReason
          && !(options?.signal?.aborted && error === options.signal.reason)) throw error;
        return { success: false, error: 'Native preview observation held.' };
      }
    },
    async admitted(args: Record<string, unknown>, mode: 'prompt' | 'plan' = 'prompt', afterCapture?: () => void,
      afterBody?: (result: Awaited<ReturnType<Tool['execute']>>) => void, executeOptions?: ExecuteOptions): Promise<AdmissionResult> {
      config.set('permissions.mode', mode);
      const manager = new PermissionManager(undefined, createPermissionConfigReader(config), new PolicyRuntimeState());
      const registry = new ToolRegistry(manager);
      bindAgentResearchSourceOwner(registry, source.owner);
      registerAgentHarnessTool(registry, commands, context);
      const registered = registry.list().find(tool => tool.definition.name === 'agent_harness');
      if (!registered) throw new Error('The native harness registration is missing.');
      const execute = registered.execute;
      const bodySpy = afterBody ? spyOn(registered, 'execute').mockImplementation(async (originalArgs, originalOptions) => {
        const result = await execute.call(registered, originalArgs, originalOptions);
        afterBody(result);
        return result;
      }) : undefined;
      const unexpected: { name: string; choices: readonly string[] }[] = [];
      // Recorded synthetic dispositions exercise the native effect floors;
      // they do not qualify live semantic judgments about arbitrary imports.
      const answers = fakePort((name, question) => {
        if (question.type === 'noul') return noulAnswer(0.001);
        if (question.type === 'choice') {
          const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read'
            : name === 'family' || name === 'capability' ? 'generic' : name === 'hazard' ? 'none' : undefined;
          if (label !== undefined && Object.hasOwn(question.criteria, label)) return choiceAnswer(question, label, 0.999);
          unexpected.push({ name, choices: Object.keys(question.criteria) });
        }
        throw new Error('Unexpected synthetic settings admission contract.');
      });
      using log = new SqliteDecisionLog(':memory:');
      const previous = installJudgmentPort(withDecisionLog(answers.port, log));
      try {
        const call = await registry.prepareCall('native-settings-import-fixture', 'agent_harness', args);
        afterCapture?.();
        const admission = await manager.admitAutonomous(call.callId, 'agent_harness', call.args, {
          sourceOf: () => ({ goal: 'Verify isolated native settings import', criteria: ['Only temporary native config, credentials and subscription files'] }),
          schemaRevision: call.schemaRevision, preparedCall: { registry, call },
        });
        const result = await registry.executePrepared(call, admission, executeOptions);
        expect(unexpected).toEqual([]);
        return result;
      } catch (error) {
        expect(unexpected).toEqual([]);
        return { success: false, error: error instanceof Error ? error.message : 'Native settings admission held.' };
      } finally { bodySpy?.mockRestore(); installJudgmentPort(previous); }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('workspace settings import preview lifetime', () => {
  test('default preview uses the real native owner without writes or raw credential traffic', async () => {
    const f = fixture();
    try {
      const before = readFileSync(f.path, 'utf8');
      const result = await f.preview();
      expect(result.success).toBe(true);
      expect(result.output).toContain('"status": "confirmation_required"');
      expect(result.output).toContain('"settingsToImport": 2');
      expect(result.output).toContain('<redacted>');
      expect(result.output).not.toContain(f.token);
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
      expect(readFileSync(f.path, 'utf8')).toBe(before);
      expect(await f.secrets.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBeNull();
      expect(f.source.calls.some(call => call.path === '/v1/chat/completions')).toBe(true);
      const wire = JSON.stringify(f.source.calls);
      expect(wire).not.toContain(f.token);
      expect(wire).toContain('redactions');
      expect(wire).toContain('botToken');
    } finally { f.cleanup(); }
  });

  test('explicit preview remains read-only even with a legacy apply selector', async () => {
    const f = fixture();
    try {
      const args = { ...request(), action: 'preview', confirm: true };
      expect(isAgentSettingsImportMutation('agent_harness', args)).toBe(false);
      expect((await f.preview(args)).success).toBe(true);
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
    } finally { f.cleanup(); }
  });

  test('registered preview rejects native import-file replacement after body completion', async () => {
    const f = fixture();
    let completedBodies = 0;
    let configIncarnation: number | undefined;
    let configBytes: string | undefined;
    try {
      const original = readFileSync(f.path, 'utf8');
      const result = await f.admitted(request(), 'prompt', () => {
        configIncarnation = f.config.getConfigurationIncarnation();
        configBytes = readFileSync(f.config.getConfigPath(), 'utf8');
      }, body => {
        expect(body.success).toBe(true);
        completedBodies++;
        writeFileSync(`${f.path}.next`, original);
        renameSync(`${f.path}.next`, f.path);
      });
      expect(completedBodies).toBe(1);
      expect(readFileSync(f.path, 'utf8')).toBe(original);
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
      expect(f.config.getConfigurationIncarnation()).toBe<typeof configIncarnation>(configIncarnation);
      expect(readFileSync(f.config.getConfigPath(), 'utf8')).toBe<typeof configBytes>(configBytes);
      expect(await f.secrets.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBeNull();
      expect(result.success).toBe(false);
      expect(result.output).toBeUndefined();
    } finally { f.cleanup(); }
  });

  test('registered unchanged preview publishes the native redacted result without configuration effects', async () => {
    const f = fixture();
    try {
      const result = await f.admitted(request());
      expect(result.success).toBe(true);
      expect(result.output).toContain('"status": "confirmation_required"');
      expect(result.output).not.toContain(f.token);
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
      expect(await f.secrets.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBeNull();
    } finally { f.cleanup(); }
  });

  test('only native import previews select read-only settings publication', () => {
    expect(isHarnessSettingsQuery(request())).toBe(true);
    expect(isHarnessSettingsQuery({ ...request(), action: 'preview', confirm: true })).toBe(true);
    expect(isHarnessSettingsQuery({ mode: 'run_workspace_action', target: 'import-goodvibes-tui-settings' })).toBe(true);
    expect(isHarnessSettingsQuery({ ...request(), confirm: true })).toBe(false);
    expect(isHarnessSettingsQuery({ ...request(), action: 'import' })).toBe(false);
    expect(isHarnessSettingsQuery({ mode: 'run_workspace_action', actionId: 'setup-checkpoint-clear' })).toBe(false);
    let accessed = 0;
    const input = request();
    Object.defineProperty(input, 'actionId', { get() { accessed++; return 'import-goodvibes-tui-settings'; } });
    expect(() => isHarnessSettingsQuery(input)).toThrow(ToolInputProjectionError);
    expect(accessed).toBe(0);
    expect(() => isHarnessSettingsQuery({ ...request(), unused: '4111 1111 1111 1111' })).toThrow(ToolInputProjectionError);
    expect(() => isHarnessSettingsQuery({ ...request(), unused: `ghp_${'A'.repeat(36)}` })).toThrow(ToolInputProjectionError);
  });

  test.each(['caller-abort', 'caller-revoke'])('registered %s after body completion refuses the result', async kind => {
    const f = fixture();
    const controller = new AbortController();
    let current = true, completedBodies = 0;
    try {
      const result = await f.admitted(request(), 'prompt', undefined, body => {
        expect(body.success).toBe(true);
        completedBodies++;
        if (kind === 'caller-abort') controller.abort('Original caller retired');
        if (kind === 'caller-revoke') current = false;
      }, { signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('Original caller retired'); } });
      expect(completedBodies).toBe(1);
      expect(result.success).toBe(false);
      expect(result.output).toBeUndefined();
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
      expect(await f.secrets.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBeNull();
    } finally { f.cleanup(); }
  });

  test('missing and malformed native sources retain truthful parse-error counts', async () => {
    const f = fixture();
    try {
      writeFileSync(f.path, '{malformed ordinary settings');
      const result = await f.preview();
      expect(result.success).toBe(true);
      expect(result.output).toContain('"parseErrors": 1');
      expect(result.output).toContain('"status": "error"');
      expect(result.output).toContain('"status": "missing"');
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
    } finally { f.cleanup(); }
  });

  test.each(['card', 'issuer', 'undeclared-credential'])('complete ignored %s source is held before any privacy wire', async kind => {
    const f = fixture();
    try {
      const value = kind === 'card' ? '4111 1111 1111 1111' : kind === 'issuer' ? `ghp_${'A'.repeat(36)}` : { apiKey: 'private-fixture-value' };
      writeFileSync(f.path, JSON.stringify({ ignored: [...Array.from({ length: 100 }, () => 'ordinary field'), value] }));
      const result = await f.preview();
      expect(result.success).toBe(false);
      expect(f.source.calls).toHaveLength(0);
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
    } finally { f.cleanup(); }
  });

  test('complete original caller fields are held before acquiring the preview source', async () => {
    const f = fixture();
    try {
      const result = await f.preview({ ...request(), unused: { apiKey: 'private-original-input' } });
      expect(result.success).toBe(false);
      expect(f.source.calls).toHaveLength(0);
    } finally { f.cleanup(); }
  });

  test.each(['file-ABA', 'config', 'subscription', 'session', 'args', 'options', 'method-accessor', 'context-accessor', 'owner'])('%s change during native screening refuses publication', async kind => {
    let mutate = () => {};
    const f = fixture({ beforeProposal: async () => { mutate(); } });
    const args: Record<string, unknown> = request();
    const options: ExecuteOptions = { assertCurrent: () => {} };
    const originalPlatform = f.context.platform;
    let accessorCalls = 0;
    try {
      mutate = () => {
        if (kind === 'file-ABA') { writeFileSync(`${f.path}.next`, readFileSync(f.path, 'utf8')); renameSync(`${f.path}.next`, f.path); }
        if (kind === 'config') f.config.set('behavior.saveHistory', f.nextSaveHistory);
        if (kind === 'subscription') f.subscriptions.savePending({ provider: 'fixture', state: 'private-state', verifier: 'private-verifier', redirectUri: 'http://127.0.0.1', createdAt: 1 });
        if (kind === 'session') f.context.session.runtime.sessionId = 'replacement';
        if (kind === 'args') args.note = 'changed';
        if (kind === 'options') Object.defineProperty(options, 'assertCurrent', { value: () => {}, configurable: true });
        if (kind === 'method-accessor') Object.defineProperty(f.config, 'get', { configurable: true, get() { accessorCalls++; return () => false; } });
        if (kind === 'context-accessor') Object.defineProperty(f.context, 'platform', { configurable: true, get() { accessorCalls++; return originalPlatform; } });
        if (kind === 'owner') bindAgentResearchSourceOwner(f.registry, researchScreeningFixture().owner);
      };
      const result = await f.preview(args, options);
      expect(result.success).toBe(false);
      expect(result.output).toBeUndefined();
      expect(accessorCalls).toBe(0);
      expect(JSON.stringify(f.source.calls)).not.toContain(f.token);
    } finally { f.cleanup(); }
  });

  test.each(['caller-abort', 'owner-abort', 'caller-revoke'])('%s while screening stops the read without effects', async kind => {
    const controller = new AbortController();
    let current = true, retire = () => {};
    const f = fixture({ beforeProposal: async () => { retire(); } });
    try {
      retire = () => { if (kind === 'caller-abort') controller.abort('original caller cancelled');
        if (kind === 'owner-abort') f.source.lifetime.abort('native source owner retired');
        if (kind === 'caller-revoke') current = false; };
      const result = await f.preview(request(), { signal: controller.signal, assertCurrent: () => { if (!current) throw f.callerRetirementReason; } });
      expect(result.success).toBe(false);
      expect(result.output).toBeUndefined();
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
      expect(await f.secrets.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBeNull();
    } finally { f.cleanup(); }
  });

  test('raw apply flags cannot write, while real recorded prepared admission can', async () => {
    const f = fixture();
    try {
      const args = { ...request(), confirm: true, explicitUserRequest: 'Optional native fixture provenance' };
      expect(isAgentSettingsImportMutation('agent_harness', args)).toBe(true);
      expect((await f.preview(args)).success).toBe(false);
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
      const applied = await f.admitted(args);
      expect(applied.error).toBeUndefined();
      expect(applied.success).toBe(true);
      expect(applied.output).toContain('"status":"committed"');
      expect(applied.output).not.toContain(f.token);
      expect(f.config.get('behavior.saveHistory')).toBe(f.nextSaveHistory);
      expect(f.config.get('surfaces.slack.botToken')).toBe(buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.slack.botToken')));
      expect(await f.secrets.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBe(f.token);
    } finally { f.cleanup(); }
  });

  test.each(['read-only', 'source-replaced'])('actual prepared apply retains its %s effect floor', async kind => {
    const f = fixture();
    try {
      const result = await f.admitted({ ...request(), action: 'import' }, kind === 'read-only' ? 'plan' : 'prompt',
        kind === 'source-replaced' ? () => { writeFileSync(`${f.path}.next`, readFileSync(f.path, 'utf8')); renameSync(`${f.path}.next`, f.path); } : undefined);
      expect(result.success).toBe(false);
      expect(f.config.get('behavior.saveHistory')).toBe(!f.nextSaveHistory);
      expect(await f.secrets.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBeNull();
    } finally { f.cleanup(); }
  });
});
