import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import type { UserPermissionRuleStore } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { buildGoodVibesSecretKey } from '../../config/secret-config.ts';
import { captureRemoteSettingsPrecondition } from '@goodvibes-jev/engine/sdk/platform/config';
import { createDaemonConfigClient } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { registerAgentSettingsTool } from '../../tools/agent-settings-tool.ts';
import { registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY } from '../../config/host-settings.ts';
import { agentDaemonConfigClient, installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
/**
 * SETTINGS effect-owner acceptance on the isolated settings slice.
 * Recorded judgment I/O is synthetic; Agent composition, registry, manager,
 * persistence and the owned loopback HTTP router are real production paths.
 * No external service, provider, credential or non-fixture setting is used.
 * The original parked combined acceptance remains unchanged beside this file.
 */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { executeToolCalls, type ToolExecutionDeps } from '@goodvibes-jev/engine/sdk/platform/core';
import type { ToolResult } from '@goodvibes-jev/engine/sdk/platform/types';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ReadTool } from '@goodvibes-jev/engine/sdk/platform/tools';
import { CodeIntelligence } from '@goodvibes-jev/engine/sdk/platform/intelligence';
import { withTurnSurface } from '@goodvibes-jev/engine/sdk/platform/security';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { composeAgentToolRegistry } from '../../runtime/agent-tool-registry.ts';
import { composeAgentPermissionManager } from '../../runtime/bootstrap-core.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { launchSettingsHttpHost } from '../helpers/settings-http-host.ts';

type Request = JudgmentRequest<Questions>;
let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
let requests: Request[];
let selected: 'act' | 'reject' | 'defer_0';
let reportsMutation: boolean;
let secrets: 'no' | 'yes' | 'uncertain';
let platform: 'no' | 'yes' | 'uncertain';
let platformRequested: 'no' | 'yes' | 'uncertain';
let beforeAnswer: ((request: Request) => void | Promise<void>) | undefined;
let readBodies: number;
let restoreRead: (() => void) | undefined;
const runtimes: RuntimeServices[] = [];
afterAll(cleanupResearchScreeningFixtures);
const restoreOthers: (() => void | Promise<void>)[] = [];

beforeEach(() => {
  requests = []; selected = 'act'; reportsMutation = true; secrets = 'no'; platform = 'no'; platformRequested = 'no'; beforeAnswer = undefined; readBodies = 0;
  log = new SqliteDecisionLog(':memory:');
  const originalRead = ReadTool.prototype.execute;
  const readSpy = spyOn(ReadTool.prototype, 'execute').mockImplementation(function (this: ReadTool, args, options) {
    readBodies++;
    return originalRead.call(this, args, options);
  });
  restoreRead = () => readSpy.mockRestore();
  previous = installJudgmentPort(recordedPort());
});

afterEach(async () => {
  try {
    for (const runtime of runtimes.splice(0).reverse()) {
      try { await runtime.processManager.close(); } finally { runtime.dispose(); }
    }
  } finally {
    restoreRead?.(); restoreRead = undefined;
    let cleanupFailure: { error: unknown } | undefined;
    for (const restore of restoreOthers.splice(0).reverse()) {
      try { await restore(); } catch (error) { cleanupFailure ??= { error }; }
    }
    installJudgmentPort(previous); log[Symbol.dispose]();
    if (cleanupFailure) throw cleanupFailure.error;
  }
});

function recordedPort(): JudgmentPort {
  const scripted = fakePort((name, question, state) => {
    if (name === 'match') return noulAnswer((state as unknown as { candidate: { name: string } }).candidate.name === 'display.theme' ? 0.999 : 0.001);
    if (name === 'disposition' && question.type === 'choice') {
      const choice = selected === 'act' && !Object.hasOwn(question.criteria, 'act') ? 'reject' : selected;
      return choiceAnswer(question, choice, 0.999);
    }
    if (name === 'hazard') return choiceAnswer(question, 'approval-gate', 0.999);
    if (name === 'family' || name === 'capability') return choiceAnswer(question, 'generic', 0.999);
    if (name === 'kind') return choiceAnswer(question, 'read', 0.999);
    if (name === 'secrets') return noulAnswer(secrets === 'yes' ? 0.999 : secrets === 'uncertain' ? 0.5 : 0.001);
    if (name === 'platform_source') return noulAnswer(platform === 'yes' ? 0.999 : platform === 'uncertain' ? 0.5 : 0.001);
    if (name === 'platform_requested') return noulAnswer(platformRequested === 'yes' ? 0.999 : platformRequested === 'uncertain' ? 0.5 : 0.001);
    if (question.type === 'noul') return noulAnswer(name === 'mutates' && reportsMutation ? 0.999 : 0.001);
    throw new Error(`Unscripted Agent read/settings fixture question: ${name}`);
  });
  const observed: JudgmentPort = {
    model: scripted.port.model,
    async ask(request) {
      request.signal?.throwIfAborted(); request.beforeAttempt?.();
      requests.push(request as Request);
      await beforeAnswer?.(request as Request);
      return scripted.port.ask(request);
    },
  };
  return withDecisionLog(observed, log);
}

async function fixture(remote?: 'normal' | 'lost-response', readOnly = false) {
  const root = makeProjectTempDir('agent-read-settings-admission');
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const configDir = join(home, '.goodvibes', 'agent');
  mkdirSync(workspace, { recursive: true }); mkdirSync(configDir, { recursive: true });
  const serving = remote ? await remoteOwner(root, home, remote) : undefined;
  execFileSync('git', ['init', '-q'], { cwd: workspace, timeout: 30_000 });
  const configManager = new AgentConfigManager({ surfaceRoot: 'agent', workingDir: workspace, homeDir: home, configDir, readOnly });
  // Seed the synthetic starting state before the real client floor arms its
  // file watcher. No admission-generation exemption or watcher disable is used.
  if (!readOnly) { configManager.set('permissions.mode', 'prompt'); configManager.set('display.theme', 'vaporwave'); }
  const runtime = createRuntimeServices({
    modelDiscovery: 'skip', runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
    configManager,
    workingDir: workspace, homeDirectory: home, getConversationTitle: () => 'read/settings acceptance',
  });
  runtimes.push(runtime);
  // Runtime construction owns the production installation; replace only its I/O.
  installJudgmentPort(recordedPort());
  let prompts = 0;
  runtime.permissionPromptRef.requestPermission = async () => { prompts++; throw new Error('No human semantic permission callback is allowed'); };
  const source = { goal: 'Read the scratch fixtures and apply the exact scratch setting requested by this test', criteria: ['Do not touch any real file, account or setting'] };
  const sourceOf = () => source;
  const registry = composeAgentToolRegistry({ services: runtime, configManager: runtime.configManager,
    homeDirectory: home, resolveSessionId: () => 'adoption-session', getLastUserMessage: () => source.goal }).toolRegistry;
  const commands = {} as CommandRegistry;
  const context = { platform: { configManager: runtime.configManager, secretsManager: runtime.secretsManager } } as unknown as CommandContext;
  registerAgentHarnessTool(registry, commands, context);
  registerAgentSettingsTool(registry, commands, context);
  const manager = composeAgentPermissionManager(runtime);
  const deps: ToolExecutionDeps = { toolRegistry: registry, permissionManager: manager, autonomousSource: sourceOf,
    hookDispatcher: null, runtimeBus: null, sessionId: 'adoption-session',
    emitterContext: () => { throw new Error('No runtime emitter is used by this fixture'); } };
  let sequence = 0;
  const run = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const result = (await executeToolCalls(deps, `turn-${++sequence}`, [{ id: `call-${sequence}`, name, arguments: args }]))[0];
    if (!result) throw new Error('Composed execution returned no result');
    return result;
  };
  const write = (path: string, body = 'SYNTHETIC ORDINARY FILE') => writeFileSync(join(workspace, path), body);
  const prepare = async (id: string, name: string, args: Record<string, unknown>) => {
    await manager.prepareAutonomousOwner();
    const owner = manager.autonomousPreparation(id, sourceOf);
    return registry.prepareCall(id, name, args, { port: owner.port, assertCurrent: owner.assertCurrent });
  };
  return { runtime, registry, manager, deps, run, write, workspace, home, context, source, sourceOf, prepare, serving, prompts: () => prompts };
}

async function remoteOwner(root: string, home: string, mode: 'normal' | 'lost-response') {
  const daemonHome = join(home, '.goodvibes', 'daemon'); mkdirSync(daemonHome, { recursive: true });
  const oldHome = process.env.GOODVIBES_DAEMON_HOME;
  process.env.GOODVIBES_DAEMON_HOME = daemonHome;
  restoreOthers.push(() => { if (oldHome === undefined) delete process.env.GOODVIBES_DAEMON_HOME; else process.env.GOODVIBES_DAEMON_HOME = oldHome; });
  const host = launchSettingsHttpHost(root, mode);
  restoreOthers.push(() => host.stop());
  const ready = await host.ready();
  const endpoint = new URL(ready.baseUrl);
  writeFileSync(join(daemonHome, 'operator-tokens.json'), JSON.stringify({ token: ready.token }), { mode: 0o600 });
  writeFileSync(join(daemonHome, 'detached-daemon.json'), JSON.stringify({ host: endpoint.hostname, port: Number(endpoint.port), pid: ready.pid }));
  return ready;
}


const mutation = (name: string, operation = 'set', key = 'display.theme', value: unknown = 'nord') =>
  name === 'settings' ? { action: operation, key, ...(operation === 'set' ? { value } : {}) }
    : { mode: operation === 'set' ? 'set_setting' : 'reset_setting', key, ...(operation === 'set' ? { value } : {}) };

test.each(['settings', 'agent_harness'])('%s applies recorded act without human/model confirmation metadata', async name => {
  const f = await fixture();
  const result = await f.run(name, { ...mutation(name), confirm: false, explicitUserRequest: 'unrelated model assertion' });
  expect(result.success).toBe(true); expect(result.autonomousDecision?.outcome).toBe('act');
  expect(f.runtime.configManager.get('display.theme')).toBe('nord'); expect(f.prompts()).toBe(0);
  expect(JSON.parse(result.output!).status).toBe('committed');
  expect(requests.filter(request => 'hazard' in request.questions)).toHaveLength(1);
});

test.each(['settings', 'agent_harness'])('%s reject and defer are effect-free', async name => {
  const f = await fixture();
  for (const choice of ['reject', 'defer_0'] as const) {
    selected = choice; const result = await f.run(name, { ...mutation(name), confirm: true, explicitUserRequest: 'change it' });
    expect(result.success).toBe(false); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
  }
  expect(f.prompts()).toBe(0);
});

test.each(['settings', 'agent_harness'])('%s read-only policy and false mutation readings cannot authorize writes', async name => {
  const f = await fixture(); f.runtime.configManager.set('permissions.mode', 'plan'); reportsMutation = false;
  expect((await f.run(name, mutation(name))).success).toBe(false);
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test.each(['settings', 'agent_harness'])('%s registered reads stay available without mutation evidence', async name => {
  const f = await fixture(); reportsMutation = false;
  const result = await f.run(name, name === 'settings' ? { action: 'get', key: 'display.theme' } : { mode: 'get_setting', key: 'display.theme' });
  expect(result.success).toBe(true); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
  expect(requests.some(request => 'hazard' in request.questions)).toBe(false);
});

test.each(['settings', 'agent_harness'])('%s direct/forged/replayed body contexts cannot authorize mutation', async name => {
  const f = await fixture();
  expect((await f.registry.execute('direct', name, { ...mutation(name), confirm: true })).success).toBe(false);
  const prepared = await f.prepare('forged', name, mutation(name));
  await f.registry.executePrepared(prepared, () => {}).catch(() => undefined);
  await f.registry.executePrepared(prepared, () => {}).catch(() => undefined);
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test.each(['cancel', 'config-aba', 'source', 'rule-aba'] as const)('preferred settings %s during judgment prevents all effects', async change => {
  const f = await fixture(); const abort = new AbortController(); f.deps.turnSignal = abort.signal; let changed = false;
  beforeAnswer = request => {
    if (!('disposition' in request.questions) || changed) return; changed = true;
    if (change === 'cancel') abort.abort();
    if (change === 'source') f.source.goal = 'Leave settings unchanged';
    if (change === 'config-aba') { f.runtime.configManager.set('display.theme', 'nord'); f.runtime.configManager.set('display.theme', 'vaporwave'); }
    if (change === 'rule-aba') { f.runtime.configManager.set('permissions.tools.read', 'deny'); f.runtime.configManager.set('permissions.tools.read', 'prompt'); }
  };
  await f.run('settings', mutation('settings')).catch(() => undefined);
  expect(changed).toBe(true); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('alias coercion is captured before judgment and alias/schema replacement retires the capture', async () => {
  const f = await fixture();
  const first = await f.run('settings', { action: 'set', setting: 'BEHAVIOR.SAVEHISTORY', value: 'off' });
  expect(first.success).toBe(true); expect(f.runtime.configManager.get('behavior.saveHistory')).toBe(false);
  const index = CONFIG_SCHEMA.findIndex(row => row.key === 'display.theme'); const old = CONFIG_SCHEMA[index]!;
  restoreOthers.push(() => { CONFIG_SCHEMA[index] = old; });
  beforeAnswer = request => { if ('disposition' in request.questions) CONFIG_SCHEMA[index] = { ...old, description: old.description + ' replaced' }; };
  await f.run('settings', { action: 'set', target: 'DISPLAY.THEME', value: 'nord' }).catch(() => undefined);
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('raw credential aliases are refused before any judgment, reference routes stay opaque', async () => {
  const f = await fixture();
  await f.run('settings', { action: 'set', target: 'EMAIL.PASSWORDREF', value: 'synthetic-private' }).catch(() => undefined);
  expect(requests).toHaveLength(0); expect(f.prompts()).toBe(0);
});

test('host boolean writes use the real prepared owner and enforce literal coercion', async () => {
  const f = await fixture();
  expect((await f.run('settings', mutation('settings', 'set', AGENT_NOTIFICATIONS_METADATA_ONLY_KEY, false))).success).toBe(true);
  expect(f.runtime.configManager.getHostBooleanSetting(AGENT_NOTIFICATIONS_METADATA_ONLY_KEY).get()).toBe(false);
  expect((await f.run('settings', mutation('settings', 'reset', AGENT_NOTIFICATIONS_METADATA_ONLY_KEY))).success).toBe(true);
  expect(f.runtime.configManager.getHostBooleanSetting(AGENT_NOTIFICATIONS_METADATA_ONLY_KEY).get()).toBe(true);
  await f.run('settings', mutation('settings', 'set', AGENT_NOTIFICATIONS_METADATA_ONLY_KEY, 'false')).catch(() => undefined);
  expect(f.runtime.configManager.getHostBooleanSetting(AGENT_NOTIFICATIONS_METADATA_ONLY_KEY).get()).toBe(true);
});

test('wake enablement admits and receipts both actual setting effects', async () => {
  const f = await fixture(); f.runtime.configManager.set('voice.wake.enabled', false); f.runtime.configManager.set('voice.wake.surfaces.agent', false);
  const result = await f.run('settings', mutation('settings', 'set', 'voice.wake.enabled', true));
  expect(result.success).toBe(true); expect(f.runtime.configManager.get('voice.wake.enabled')).toBe(true);
  expect(f.runtime.configManager.get('voice.wake.surfaces.agent')).toBe(true); expect(JSON.parse(result.output!).alsoSet.key).toBe('voice.wake.surfaces.agent');
  expect(JSON.stringify(requests.find(request => 'disposition' in request.questions)!.state)).toContain('voice.wake.surfaces.agent');
});

test('reentrant cancellation between companion writes yields truthful partial receipt', async () => {
  const f = await fixture(); f.runtime.configManager.set('voice.wake.enabled', false); f.runtime.configManager.set('voice.wake.surfaces.agent', false);
  const abort = new AbortController(); f.deps.turnSignal = abort.signal;
  restoreOthers.push(f.runtime.configManager.subscribe('voice.wake.enabled', () => abort.abort()));
  const prepared = await f.prepare('companion-cancellation', 'settings', mutation('settings', 'set', 'voice.wake.enabled', true));
  const admission = await f.manager.admitAutonomous('companion-cancellation', prepared.name, prepared.args, { sourceOf: f.sourceOf, signal: abort.signal,
    schemaRevision: prepared.schemaRevision, preparedCall: { registry: f.registry, call: prepared } });
  const result = await f.registry.executePrepared(prepared, admission, { signal: abort.signal });
  expect(result.success).toBe(false); expect(JSON.parse(result.output!).status).toBe('partial');
  expect(f.runtime.configManager.get('voice.wake.enabled')).toBe(true); expect(f.runtime.configManager.get('voice.wake.surfaces.agent')).toBe(false);
});

test.each(['email.passwordRef', 'surfaces.email.password'] as const)('secret reset %s deletes exactly the captured daemon scope before local override removal', async configKey => {
  const f = await fixture(); const client = agentDaemonConfigClient(); installAgentDaemonConfigClient(null); restoreOthers.push(() => installAgentDaemonConfigClient(client));
  const key = buildGoodVibesSecretKey(configKey); const daemon = join(f.home, '.goodvibes', 'daemon', 'secrets.json');
  const user = join(f.home, '.goodvibes', 'agent.secrets.json'); mkdirSync(join(f.home, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(daemon, JSON.stringify({ version: 1, secrets: { [key]: 'synthetic-daemon-copy' } }));
  writeFileSync(user, JSON.stringify({ version: 1, secrets: { [key]: 'synthetic-user-copy' } }));
  f.runtime.configManager.set(configKey, 'goodvibes://secrets/goodvibes/' + key);
  const result = await f.run('settings', mutation('settings', 'reset', configKey));
  expect(result.success).toBe(true); expect(JSON.parse(readFileSync(daemon, 'utf8')).secrets[key]).toBeUndefined();
  expect(JSON.parse(readFileSync(user, 'utf8')).secrets[key]).toBe('synthetic-user-copy');
  expect(f.runtime.configManager.get(configKey)).toBe('');
});

test('secret settlement callback revocation prevents the remaining config effect and reports partial', async () => {
  const f = await fixture(); const client = agentDaemonConfigClient(); installAgentDaemonConfigClient(null); restoreOthers.push(() => installAgentDaemonConfigClient(client));
  const key = 'GOODVIBES_EMAIL_PASSWORD_REF'; const daemon = join(f.home, '.goodvibes', 'daemon', 'secrets.json');
  mkdirSync(join(f.home, '.goodvibes', 'daemon'), { recursive: true }); writeFileSync(daemon, JSON.stringify({ version: 1, secrets: { [key]: 'synthetic-copy' } }));
  const reference = 'goodvibes://secrets/goodvibes/' + key; f.runtime.configManager.set('email.passwordRef', reference);
  restoreOthers.push(f.runtime.secretsManager.onDidChange(() => { f.source.goal = 'Stop remaining effects'; }));
  const result = await f.run('settings', mutation('settings', 'reset', 'email.passwordRef'));
  expect(result.success).toBe(false); expect(JSON.parse(result.output!).status).toBe('partial');
  expect(f.runtime.configManager.get('email.passwordRef')).toBe(reference);
});

function installPreparedClient(f: Awaited<ReturnType<typeof fixture>>) {
  const previous = agentDaemonConfigClient(); const serving = f.serving!;
  const client = createDaemonConfigClient({ probe: () => ({ available: true }),
    invoke: async () => { throw new Error('Legacy daemon dispatch must not execute'); },
    captureSettingsPrecondition: request => captureRemoteSettingsPrecondition({ baseUrl: serving.baseUrl, token: serving.token, source: 'synthetic owning server' }, request),
  });
  installAgentDaemonConfigClient(client); restoreOthers.push(() => installAgentDaemonConfigClient(previous)); return client;
}

test.each(['settings', 'agent_harness'])('%s uses exact installed remote precondition for set and remote default reset', async name => {
  const f = await fixture('normal'); const serving = f.serving!; installPreparedClient(f); const key = 'controlPlane.port';
  const before = f.runtime.configManager.get(key);
  expect((await f.run(name, mutation(name, 'set', key, 5678))).success).toBe(true); expect(serving.config.get(key)).toBe(5678);
  expect((await f.run(name, mutation(name, 'reset', key))).success).toBe(true); expect(serving.config.get(key)).toBe(serving.config.getSchema()[0]!.default);
  expect(f.runtime.configManager.get(key)).toBe(before); expect(await serving.counts()).toEqual({ captures: 2, applies: 2 });
});

test.each(['reject', 'defer_0'] as const)('preferred remote %s never dispatches apply', async decision => {
  const f = await fixture('normal'); installPreparedClient(f); selected = decision;
  expect((await f.run('settings', mutation('settings', 'set', 'controlPlane.port', 5678))).success).toBe(false);
  expect(await f.serving!.counts()).toEqual({ captures: 1, applies: 0 });
});

test.each(['install-aba', 'revoke', 'lost-response'] as const)('preferred remote %s neither retries nor falls back to local writes', async failure => {
  const f = await fixture(failure === 'lost-response' ? 'lost-response' : 'normal'); const client = installPreparedClient(f);
  const before = f.runtime.configManager.get('controlPlane.port');
  beforeAnswer = async request => {
    if (!('disposition' in request.questions)) return;
    if (failure === 'install-aba') { installAgentDaemonConfigClient(null); installAgentDaemonConfigClient(client); }
    if (failure === 'revoke') await f.serving!.revoke();
  };
  const result = await f.run('settings', mutation('settings', 'set', 'controlPlane.port', 5678)).catch(() => undefined);
  expect(result?.success).not.toBe(true); expect(f.runtime.configManager.get('controlPlane.port')).toBe(before);
  expect(await f.serving!.counts()).toEqual({ captures: 1, applies: failure === 'install-aba' ? 0 : 1 });
  if (failure === 'lost-response') { expect(f.serving!.config.get('controlPlane.port')).toBe(5678); expect(JSON.parse(result!.output!).status).toBe('unknown'); }
});

test('preferred actual admission cannot be replayed or copied to mint another effect', async () => {
  const f = await fixture(); const prepared = await f.prepare('preferred-once', 'settings', mutation('settings'));
  const admission = await f.manager.admitAutonomous('preferred-once', prepared.name, prepared.args, { sourceOf: f.sourceOf,
    schemaRevision: prepared.schemaRevision, preparedCall: { registry: f.registry, call: prepared } });
  expect((await f.registry.executePrepared(prepared, admission)).success).toBe(true);
  await expect(f.registry.executePrepared(prepared, admission)).rejects.toThrow();
  expect(f.runtime.configManager.get('display.theme')).toBe('nord');
});

test.each(['settings', 'agent_harness'])('%s honors the write-class tool deny even with false supporting readings', async name => {
  const f = await fixture(); f.runtime.configManager.set('permissions.mode', 'custom'); f.runtime.configManager.set('permissions.tools.write', 'deny'); reportsMutation = false;
  expect((await f.run(name, mutation(name))).success).toBe(false); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('preferred settings rejects a read-only physical ConfigManager before any judgment', async () => {
  const f = await fixture(undefined, true); const before = f.runtime.configManager.get('display.theme');
  await expect(f.run('settings', mutation('settings'))).rejects.toThrow();
  expect(requests).toHaveLength(0); expect(f.runtime.configManager.get('display.theme')).toBe(before);
});

test.each(['copied', 'different-manager'] as const)('preferred settings rejects %s authentic admission substitution', async kind => {
  const f = await fixture(); const prepared = await f.prepare('preferred-bound-owner', 'settings', mutation('settings'));
  const issuer = kind === 'different-manager' ? (await fixture()).manager : f.manager;
  const admission = await issuer.admitAutonomous('preferred-bound-owner', prepared.name, prepared.args, { sourceOf: f.sourceOf,
    schemaRevision: prepared.schemaRevision, preparedCall: { registry: f.registry, call: prepared } });
  await expect(f.registry.executePrepared(prepared, kind === 'copied' ? { ...admission } : admission)).rejects.toThrow();
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('a real durable rule-store publish/delete ABA retires the preferred settings admission', async () => {
  const f = await fixture(); let changed = false;
  beforeAnswer = async request => {
    if (!('disposition' in request.questions) || changed) return; changed = true;
    await f.runtime.userPermissionRuleStore.add({ createdAt: Date.now(), tier: 'tool', tool: 'settings',
      rule: { id: 'preferred-synthetic-deny', type: 'mode-constraint', origin: 'user', effect: 'deny',
        toolPattern: 'settings', activeModes: ['default'], classifications: ['write'] } });
    await (f.runtime.userPermissionRuleStore as UserPermissionRuleStore).delete('preferred-synthetic-deny');
  };
  const result = await f.run('settings', mutation('settings')).catch(() => undefined);
  expect(changed).toBe(true); expect(result?.success).not.toBe(true); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});

test('replacement of the registered physical settings owner during admission prevents dispatch', async () => {
  const f = await fixture(); const replacement = new AgentConfigManager({ surfaceRoot: 'agent', homeDir: f.home, workingDir: f.workspace });
  beforeAnswer = request => { if ('disposition' in request.questions) Reflect.set(f.context.platform, 'configManager', replacement); };
  const result = await f.run('settings', mutation('settings')).catch(() => undefined);
  expect(result?.success).not.toBe(true); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});


test('post-config credential replacement preserves committed receipt without verified-store claim', async () => {
  const f = await fixture(); const client = agentDaemonConfigClient(); installAgentDaemonConfigClient(null); restoreOthers.push(() => installAgentDaemonConfigClient(client));
  const key = buildGoodVibesSecretKey('email.passwordRef'); const daemon = join(f.home, '.goodvibes', 'daemon', 'secrets.json');
  mkdirSync(join(f.home, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(daemon, JSON.stringify({ version: 1, secrets: { [key]: 'synthetic-initial' } }));
  f.runtime.configManager.set('email.passwordRef', 'goodvibes://secrets/goodvibes/' + key);
  restoreOthers.push(f.runtime.configManager.subscribe('email.passwordRef', () => {
    writeFileSync(daemon, JSON.stringify({ version: 1, secrets: { [key]: 'synthetic-replaced' } }));
  }));
  const result = await f.run('settings', mutation('settings', 'reset', 'email.passwordRef'));
  expect(result.success).toBe(true); expect(JSON.parse(result.output!).status).toBe('committed');
  expect(JSON.parse(result.output!).verifiedInOwningStore).toBe(false);
  expect(JSON.parse(readFileSync(daemon, 'utf8')).secrets[key]).toBe('synthetic-replaced');
});


function semanticSettingsFixture(f: Awaited<ReturnType<typeof fixture>>) {
  bindAgentResearchSourceOwner(f.registry, ordinaryResearchOwner());
  const rows = CONFIG_SCHEMA.filter(row => row.key === 'display.theme' || row.key === 'display.showThinking');
  const prior = f.runtime.configManager.getSchema;
  f.runtime.configManager.getSchema = () => rows;
  restoreOthers.push(() => { f.runtime.configManager.getSchema = prior; });
}

test.each(['settings', 'agent_harness'])('%s semantic selection still requires an exact recorded act before committing', async name => {
  const f = await fixture(); semanticSettingsFixture(f);
  const args = name === 'settings' ? { action: 'set', target: 'Make the interface less glaring', value: 'nord' }
    : { mode: 'set_setting', target: 'Make the interface less glaring', value: 'nord' };
  selected = 'reject';
  const refused = await f.run(name, args);
  expect(refused.success).toBe(false); expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
  expect(requests.some(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
  selected = 'act'; requests = [];
  const applied = await f.run(name, args);
  expect(applied.success).toBe(true); expect(applied.autonomousDecision?.outcome).toBe('act');
  expect(f.runtime.configManager.get('display.theme')).toBe('nord');
  expect(JSON.parse(applied.output!).lookup.resolvedBy).toBe('search');
  expect(JSON.parse(applied.output!).status).toBe('committed');
  expect(requests.some(request => 'hazard' in request.questions)).toBe(true);
  expect(f.prompts()).toBe(0);
});

test('semantic settings cannot commit after the live request changes during its reading', async () => {
  const f = await fixture(); semanticSettingsFixture(f); let changed = false;
  beforeAnswer = request => {
    if (request.context?.battery !== 'engine.tools.registry-rank' || changed) return;
    changed = true; f.source.goal = 'Keep the existing palette; cancel that change.';
  };
  const result = await f.run('settings', { action: 'set', target: 'Make the interface less glaring', value: 'nord' }).catch(() => undefined);
  expect(changed).toBe(true); expect(result?.success).not.toBe(true);
  expect(f.runtime.configManager.get('display.theme')).toBe('vaporwave');
});
