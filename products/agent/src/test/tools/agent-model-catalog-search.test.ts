import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { gateJudgmentRegistry } from '@goodvibes-jev/engine/sdk/platform/gate';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import type { ProtectedSourceOwner } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolRegistry, assertCurrentToolExecution } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { createAgentHarnessTool, registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { createAgentModelsTool, registerAgentModelsTool } from '../../tools/agent-models-tool.ts';
import { localEndpointId } from '../../tools/agent-harness-local-model-endpoints.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, ordinaryResearchOwner, researchScreeningFixture } from '../helpers/research-screening.ts';

type Json = Record<string, unknown>;
type ToolExecuteOptions = NonNullable<Parameters<Tool['execute']>[1]>;
type Surface = { readonly name: 'models' | 'agent_harness'; readonly registered: boolean };
const record = (value: unknown): Json => value !== null && typeof value === 'object' ? value as Json : {};
const rows = (value: unknown): Json[] => Array.isArray(value) ? value.map(record) : [];
const body = (result: { output?: unknown }): Json => record(JSON.parse(String(result.output)));
const candidates = (result: { error?: unknown }): Json[] => rows(JSON.parse(String(result.error).split('Candidates: ')[1]!));
const battery = 'engine.tools.registry-rank';
const query = 'search inbox';
const winner = 'fixture:opaque';
const distractor = 'fixture:search-inbox';
const localBaseUrl = 'http://127.0.0.1:18433/v1';
const endpoint = localEndpointId(localBaseUrl);
const surfaces: readonly Surface[] = [
  { name: 'models', registered: false }, { name: 'agent_harness', registered: false },
  { name: 'models', registered: true }, { name: 'agent_harness', registered: true },
];
const routeIds = ['main', 'embedding-provider', 'system-prompt', 'helper-model', 'tool-llm', 'catalog-refresh', 'local-model-cookbook', 'pinned-models', 'custom-providers'];
let previous: ReturnType<typeof installJudgmentPort>;
const restores: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  previous = installJudgmentPort(undefined);
  // Endpoint candidate counts must not depend on the developer's local servers.
  for (const key of ['OLLAMA_BASE_URL', 'OLLAMA_HOST', 'LM_STUDIO_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL', 'OPENAI_COMPAT_BASE_URL', 'VLLM_BASE_URL', 'LLAMA_CPP_BASE_URL', 'LITELLM_BASE_URL']) {
    const value = process.env[key]; delete process.env[key];
    restores.push(() => { if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  }
});
afterEach(async () => { for (const restore of restores.splice(0).reverse()) await restore(); installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

function readings(fits: Readonly<Record<string, number>> = {}) {
  return fakePort((name, question, state) => {
    if (name === 'match') return noulAnswer(fits[String(record(record(state).candidate).name)] ?? 0.01);
    if (question.type === 'score') return scoreAnswer(question, name === 'memoryAdequacy' ? 2 : 4, 0.99);
    if (question.type === 'choice') return choiceAnswer(question, name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'hazard' ? 'none' : 'generic', 0.999);
    return noulAnswer(name === 'cloudTransfer' ? 0.99 : 0.001);
  });
}
// Real SQLite recording with deterministic UUID inputs, including a known
// PAN-shaped UUID. The producer encodes it; a separate old-row control proves
// that genuine sensitive provenance still meets the unchanged screening floor.
const collisionId = '01a126ad-991e-7023-9665-055983b11cdd';
class FixtureDecisionLog extends SqliteDecisionLog {
  private sequence = 0;
  private collided = false;
  constructor(private readonly collide = false, private readonly legacyPath?: string) { super(legacyPath ?? ':memory:'); }
  override record(entry: Parameters<SqliteDecisionLog['record']>[0]): ReturnType<SqliteDecisionLog['record']> {
    const suffix = (++this.sequence).toString(6).padStart(12, '0').replace(/[0-5]/g, digit => 'abcdef'[Number(digit)]!);
    const id = this.collide && !this.collided && entry.context.battery === 'agent.models.local-recipe-fit'
      ? collisionId : `aaaaaaaa-aaaa-7aaa-aaaa-${suffix}`;
    if (id === collisionId) this.collided = true;
    const original = Bun.randomUUIDv7;
    // SqliteDecisionLog.record is synchronous; no callback or await can observe
    // this fixture generator, and the real generator is always restored.
    Bun.randomUUIDv7 = (() => id) as typeof Bun.randomUUIDv7;
    try {
      const generated = super.record(entry);
      if (this.legacyPath !== undefined && id === collisionId) {
        // Emulate an existing schema-v3 row with its original raw UUID key.
        // Production never rewrites or exempts these keys.
        using db = new Database(this.legacyPath);
        db.query('UPDATE decisions SET id = ? WHERE id = ?').run(collisionId, generated);
        return collisionId as ReturnType<SqliteDecisionLog['record']>;
      }
      return generated;
    } finally { Bun.randomUUIDv7 = original; }
  }
}
const ranks = (fake: ReturnType<typeof readings>) => fake.requests.filter(request => request.context?.battery === battery);
const rankedNames = (fake: ReturnType<typeof readings>) => ranks(fake).map(request => String(record(record(request.state).candidate).name));

function fixture(owner: ProtectedSourceOwner = ordinaryResearchOwner(), registry = new ToolRegistry()) {
  const effects: string[] = [];
  const models: Json[] = [
    { registryKey: distractor, modelId: 'search-inbox', providerId: 'fixture', displayName: 'Search inbox', contextWindow: 4096,
      capabilities: { toolCalling: true, multimodal: true }, tier: 'premium', available: true, isConfigured: true },
    { registryKey: winner, modelId: 'opaque', providerId: 'fixture', displayName: 'Unrelated fixture', contextWindow: 8192,
      capabilities: { toolCalling: true, multimodal: true }, tier: 'premium', available: true, isConfigured: true },
  ];
  const registryModels: Json[] = [...models];
  const providers: Json[] = [
    { id: 'fixture', baseUrl: 'https://inference.example.invalid/v1', hosting: 'Third-party hosted inference', isConfigured: true, isAvailable: true },
    { id: 'opaque-local', baseUrl: localBaseUrl, isConfigured: true, isAvailable: true },
  ];
  const health = { routes: models.map(model => ({ providerId: model.providerId, modelRouteId: model.registryKey,
    status: 'healthy', avgLatencyMs: 40, lastCheckedAt: '2026-10-09T12:00:00.000Z', lastSuccessAt: '2026-10-09T12:00:00.000Z', isConfigured: true, isActive: true })) };
  const artifacts: Json[] = [], config: Json = {};
  const providerApi = { listModels: async () => models, getFavorites: async () => ({ pinned: [] }), getCurrentModel: async () => models[0]!,
    listProviderIds: () => providers.map(provider => String(provider.id)),
    setModel: async () => { effects.push('set-model'); }, refreshModels: async () => { effects.push('refresh-models'); } };
  const providerRegistry = { listModels: () => registryModels, listProviders: () => providers,
    getKnownContextWindowForModel: (model: Json): number | null => typeof model.contextWindow === 'number' ? model.contextWindow : null,
    getContextWindowForModel: (model: Json): number | null => typeof model.contextWindow === 'number' ? model.contextWindow : null };
  const context = { extensions: {}, workspace: {}, ops: {}, clients: { providerApi }, provider: { providerRegistry },
    platform: { config: {}, configManager: { get: (key: string) => config[key], set: () => { effects.push('set-config'); } },
      artifactStore: { list: () => artifacts }, readModels: { providerHealth: health } },
    session: { runtime: { sessionId: 'model-catalog-session', model: distractor, provider: 'fixture' } },
  } as unknown as CommandContext;
  const commands = new CommandRegistry();
  for (const name of ['model', 'provider', 'pin', 'unpin', 'settings', 'refresh-models', 'exec']) commands.register({ name,
    description: 'Synthetic mutation tripwire', handler: () => { effects.push(name); } });
  bindAgentResearchSourceOwner(registry, owner);
  const deps = { commandRegistry: commands, commandContext: context, toolRegistry: registry };
  const tools = { models: createAgentModelsTool(deps), agent_harness: createAgentHarnessTool(deps) };
  const register = (name: Surface['name']) => name === 'models'
    ? registerAgentModelsTool(registry, commands, context) : registerAgentHarnessTool(registry, commands, context);
  const invoke = (surface: Surface, args: Json, options?: ToolExecuteOptions) => surface.registered
    ? registry.execute('model-catalog-search', surface.name, args, options) : tools[surface.name].execute(args, options);
  return { context, models, registryModels, providers, providerApi, providerRegistry, health, config, artifacts, commands, registry, tools, effects, register, invoke };
}
function summaryArgs(surface: Surface, extra: Json = {}): Json {
  return { ...(surface.name === 'models' ? { action: 'status' } : { mode: 'model_routing' }), query, ...extra };
}
function detailArgs(surface: Surface, extra: Json = {}): Json {
  return { ...(surface.name === 'models' ? { action: 'route' } : { mode: 'model_route' }), query, ...extra };
}
function suspended() {
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { start, release, started, gate };
}
function replaceBattery() {
  const get = gateJudgmentRegistry.get, original = get.call(gateJudgmentRegistry, battery);
  gateJudgmentRegistry.get = name => name === battery ? { ...original } as typeof original : get.call(gateJudgmentRegistry, name);
  restores.push(() => { gateJudgmentRegistry.get = get; });
}
function pauseSourceRelease(original: ProtectedSourceOwner, selected: (source: string) => boolean) {
  const wait = suspended(), sources = new WeakMap<object, string>(), counts = { selected: 0 };
  const owner: ProtectedSourceOwner = { ...original,
    capture(parts) { const handle = original.capture(parts); sources.set(handle, parts.join('\n')); return handle; },
    async release(handle) {
      await original.release(handle);
      if (selected(sources.get(handle) ?? '')) { counts.selected++; if (counts.selected === 1) { wait.start(); await wait.gate; } }
    },
  };
  return { owner, wait, counts };
}

// All HTTP in this suite is a scripted local source-screening fixture or an
// explicit no-probe tripwire. No live provider inference or model smoke occurs.
for (const surface of surfaces) describe(`${surface.registered ? 'registered' : 'raw'} ${surface.name} model catalog`, () => {
  test('canonical counter-lexical ranking reads every candidate before independent per-kind limits', async () => {
    const f = fixture(); if (surface.registered) f.register(surface.name);
    f.models.push({ ...f.models[1], registryKey: 'main', modelId: 'model-main' });
    const fake = readings({ [`model:${winner}`]: 0.99, [`model:${distractor}`]: 0.85, 'model:main': 0.91, 'route:main': 0.86, 'route:custom-providers': 0.98 });
    using log = new FixtureDecisionLog(); installJudgmentPort(withDecisionLog(fake.port, log));
    const output = body(await f.invoke(surface, summaryArgs(surface, { limit: 1, includeParameters: true })));
    expect(rows(output.models).map(model => model.modelRouteId)).toEqual([winner]);
    expect(rows(output.routes).map(route => route.modelRouteId)).toEqual(['custom-providers']);
    expect(output.returned).toEqual({ routes: 1, models: 1 });
    expect(ranks(fake)).toHaveLength(Number(record(output.total).routes) + Number(record(output.total).models));
    expect(new Set(rankedNames(fake))).toEqual(new Set([...routeIds.map(id => `route:${id}`), `model:${distractor}`, `model:${winner}`, 'model:main']));
    for (const candidate of [...rows(output.models), ...rows(output.routes)]) {
      expect(record(candidate.judgment).id).toBe(`${candidate.kind}:${candidate.modelRouteId}`);
      expect(record(record(candidate.judgment).reading).verdict).toBe('yes');
      expect(typeof record(candidate.judgment).decisionId).toBe('string');
      expect(candidate.queryMatch).toBeUndefined();
    }
    expect(output.queryMatch).toBeUndefined(); expect(f.effects).toEqual([]);
  });

  test('a lone canonical yes resolves the nonlexical model and leaves the lexical distractor rejected', async () => {
    const f = fixture(); if (surface.registered) f.register(surface.name);
    const fake = readings({ [`model:${winner}`]: 0.99 }); installJudgmentPort(fake.port);
    const result = await f.invoke(surface, detailArgs(surface)); expect(result.success).toBe(true);
    const output = body(result); expect(output.modelRouteId).toBe(winner);
    expect(record(output.judgment).id).toBe(`model:${winner}`);
    expect(record(record(output.judgment).reading).verdict).toBe('yes');
    expect(new Set(rankedNames(fake))).toEqual(new Set([...routeIds.map(id => `route:${id}`), `model:${distractor}`, `model:${winner}`, `local-server-endpoint:${endpoint}`]));
    expect(f.effects).toEqual([]);
  });

  test.each(['uncertain', 'yes-and-uncertain', 'multiple-yes', 'no'] as const)('%s detail never guesses a lexical result', async kind => {
    const f = fixture(); if (surface.registered) f.register(surface.name);
    const fits: Readonly<Record<string, number>> = kind === 'uncertain' ? { [`model:${winner}`]: 0.5 }
      : kind === 'yes-and-uncertain' ? { [`model:${winner}`]: 0.99, [`model:${distractor}`]: 0.5 }
      : kind === 'multiple-yes' ? { [`model:${winner}`]: 0.99, 'route:custom-providers': 0.98 } : {};
    const fake = readings(fits); installJudgmentPort(fake.port);
    const result = await f.invoke(surface, detailArgs(surface)); expect(result.success).toBe(false);
    if (kind === 'no') expect(result.error).toContain('Unknown model route');
    else {
      expect(result.error).toContain('Ambiguous model route');
      const matches = candidates(result); expect(matches).toHaveLength(kind === 'uncertain' ? 1 : 2);
      expect(matches[0]!.modelRouteId).toBe(winner);
      expect(matches.every(match => record(record(match.judgment).reading).verdict !== 'no')).toBe(true);
      if (kind === 'uncertain') expect(record(record(matches[0]!.judgment).reading).verdict).toBe('uncertain');
    }
    expect(f.effects).toEqual([]);
  });

  test('summary includes explicit uncertainty and excludes canonical negatives without lexical fallback', async () => {
    const f = fixture(); if (surface.registered) f.register(surface.name);
    const fake = readings({ [`model:${winner}`]: 0.5, 'route:custom-providers': 0.5 }); installJudgmentPort(fake.port);
    const output = body(await f.invoke(surface, summaryArgs(surface)));
    expect(rows(output.models).map(model => model.modelRouteId)).toEqual([winner]);
    expect(rows(output.routes).map(route => route.modelRouteId)).toEqual(['custom-providers']);
    expect([...rows(output.models), ...rows(output.routes)].every(candidate => record(record(candidate.judgment).reading).verdict === 'uncertain')).toBe(true);
    installJudgmentPort(readings().port);
    const none = body(await f.invoke(surface, summaryArgs(surface)));
    expect(none.returned).toEqual({ routes: 0, models: 0 }); expect(none.routes).toEqual([]); expect(none.models).toEqual([]);
    expect(f.effects).toEqual([]);
  });

  test('ambiguity cap follows canonical order across route, model, and endpoint kinds', async () => {
    const f = fixture(); if (surface.registered) f.register(surface.name);
    const fake = readings(Object.fromEntries([
      ...routeIds.map(id => [`route:${id}`, 0.85]), [`model:${winner}`, 0.99], [`model:${distractor}`, 0.97], [`local-server-endpoint:${endpoint}`, 0.98],
    ])); installJudgmentPort(fake.port);
    const result = await f.invoke(surface, detailArgs(surface));
    expect(result.success).toBe(false); const matches = candidates(result); expect(matches).toHaveLength(8);
    expect(matches.slice(0, 3).map(match => record(match.judgment).id)).toEqual([`model:${winner}`, `local-server-endpoint:${endpoint}`, `model:${distractor}`]);
    expect(ranks(fake)).toHaveLength(routeIds.length + f.models.length + 1); expect(f.effects).toEqual([]);
  });

  test('exact and case-insensitive route, model, and endpoint identities and no-query summary acquire zero rank reads', async () => {
    const f = fixture(); if (surface.registered) f.register(surface.name);
    const fake = readings(); installJudgmentPort(fake.port);
    for (const [lookup, identity] of [
      ['main', 'main'], ['MAIN', 'main'], [winner, winner], [winner.toUpperCase(), winner], ['opaque', winner],
      [endpoint, endpoint], [endpoint.toUpperCase(), endpoint], [localBaseUrl, endpoint], [`${localBaseUrl}/models`, endpoint],
    ]) {
      const result = await f.invoke(surface, detailArgs(surface, { modelRouteId: lookup }));
      expect(result.success).toBe(true); expect(body(result).modelRouteId).toBe(identity); expect(body(result).judgment).toBeUndefined();
    }
    const output = body(await f.invoke(surface, summaryArgs(surface, { query: undefined, limit: 1 })));
    expect(rows(output.routes)[0]!.modelRouteId).toBe('main'); expect(rows(output.models)[0]!.modelRouteId).toBe(distractor);
    expect(ranks(fake)).toHaveLength(0); expect(f.effects).toEqual([]);
  });
});

describe('model catalog protected source and caller boundaries', () => {
  test.each(['models', 'agent_harness'] as const)('%s screens original hidden invocation metadata before ranking', async name => {
    const sensitive = 'synthetic-private-invocation';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) }); const f = fixture(screening.owner);
    const surface = { name, registered: false }; const args = summaryArgs(surface, { limit: 1 });
    Object.defineProperty(args, 'undisplayed', { value: { note: sensitive }, enumerable: false });
    const fake = readings({ [`model:${winner}`]: 0.99 }); installJudgmentPort(fake.port);
    await expect(f.invoke(surface, args)).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).toContain(sensitive); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test.each(['unlisted-model', 'hidden-model', 'long-provider', 'config', 'health', 'artifact'] as const)('%s original source is screened before rank or display limits', async field => {
    const sensitive = 'synthetic-private-full-source';
    const screening = researchScreeningFixture({ spans: exactSensitiveSpans([sensitive]) }); const f = fixture(screening.owner);
    if (field === 'unlisted-model') f.registryModels.push({ registryKey: 'fixture:unlisted', metadata: { privateNote: sensitive } });
    if (field === 'hidden-model') Object.defineProperty(f.models[1]!, 'metadata', { value: { note: sensitive }, enumerable: false });
    if (field === 'long-provider') f.providers[0]!.documentation = 'x'.repeat(900) + sensitive;
    if (field === 'config') f.config['helper.globalModel'] = { privateNote: sensitive };
    if (field === 'health') record(f.health.routes[0]).lastErrorMessage = sensitive;
    if (field === 'artifact') f.artifacts.push({ id: 'hidden-artifact', metadata: { privateNote: sensitive } });
    const fake = readings({ [`model:${winner}`]: 0.99 }); installJudgmentPort(fake.port);
    await expect(f.tools.models.execute({ action: 'status', query, limit: 1, includeParameters: false })).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).toContain(sensitive); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test('redaction introduced only at the ranking source cannot publish the unredacted candidate', async () => {
    // The complete source passed its own receipt; a later catalog receipt is
    // deliberately redacted to prove the consumer requires source preservation.
    const sensitive = 'synthetic-private-rank-description';
    const screening = researchScreeningFixture({ spans: source => source.parts.some(part => part.startsWith('["route:')) ? exactSensitiveSpans([sensitive])(source) : [] });
    const f = fixture(screening.owner); f.models[1]!.displayName = sensitive;
    const fake = readings({ [`model:${winner}`]: 0.99 }); installJudgmentPort(fake.port);
    await expect(f.tools.models.execute({ action: 'status', query, limit: 1 })).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).toContain(sensitive); expect(ranks(fake)).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test.each(['invocation', 'model', 'unlisted-model', 'provider'] as const)('%s credentials never reach local screening or hosted ranking', async field => {
    const secret = 'synthetic-do-not-transmit'; const screening = researchScreeningFixture(); const f = fixture(screening.owner);
    const args: Json = { action: 'status', query, limit: 1 };
    const unlisted: Json = { registryKey: 'fixture:unlisted' }; if (field === 'unlisted-model') f.registryModels.push(unlisted);
    const target = field === 'invocation' ? args : field === 'model' ? f.models[1]! : field === 'provider' ? f.providers[0]! : unlisted;
    Object.defineProperty(target, 'undisplayed', { value: { nested: { authorization: `Bearer ${secret}` } }, enumerable: false });
    const fake = readings(); installJudgmentPort(fake.port);
    await expect(f.tools.models.execute(args)).rejects.toThrow();
    expect(JSON.stringify(screening.calls)).not.toContain(secret); expect(fake.requests).toHaveLength(0); expect(f.effects).toEqual([]);
  });

  test.each(['missing', 'rejected', 'malformed'] as const)('%s canonical rank is a failure, never a lexical fallback', async kind => {
    const f = fixture();
    if (kind === 'rejected') installJudgmentPort({ model: 'synthetic', ask: async () => { throw new Error('rank unavailable'); } });
    if (kind === 'malformed') installJudgmentPort({ model: 'synthetic', ask: async () => ({ answers: {} }) as never });
    const pending = f.tools.models.execute({ action: 'route', query });
    if (kind === 'missing') await expect(pending).rejects.toBeInstanceOf(JudgmentPortMissingError);
    else await expect(pending).rejects.toThrow();
    expect(f.effects).toEqual([]);
  });

  test.each(['models', 'agent_harness'] as const)('%s cancellation and source-owner lifetime signals both hold an awaited rank', async name => {
    for (const signal of ['caller', 'owner'] as const) {
      const screening = researchScreeningFixture(); const f = fixture(screening.owner); const wait = suspended(); const controller = new AbortController();
      const fake = readings({ [`model:${winner}`]: 0.99 }); const seen: unknown[] = [];
      installJudgmentPort({ ...fake.port, ask: async request => {
        if (request.context?.battery === battery) { seen.push(request.signal); wait.start(); await wait.gate; }
        return fake.port.ask(request);
      } });
      let delivered = 0; const surface = { name, registered: false };
      const pending = f.invoke(surface, detailArgs(surface), { signal: controller.signal }).then(result => { delivered++; return result; });
      await wait.started; if (signal === 'caller') controller.abort(); else screening.lifetime.abort();
      wait.release(); await expect(pending).rejects.toThrow();
      expect(seen.length).toBeGreaterThan(0); expect(seen.every(value => value === controller.signal)).toBe(true);
      expect(delivered).toBe(0); expect(f.effects).toEqual([]);
    }
  });

  test.each(['original-args', 'session', 'owner', 'model-content', 'provider-api', 'config', 'registration', 'options-signal'] as const)('awaited ranking fences %s loss through models argument translation', async changed => {
    const f = fixture(); const fake = readings({ [`model:${winner}`]: 0.99 }); const wait = suspended(); const controller = new AbortController();
    const args: Json = { action: 'route', query }; const options = { signal: controller.signal };
    installJudgmentPort({ ...fake.port, ask: async request => {
      if (request.context?.battery === battery) { wait.start(); await wait.gate; }
      return fake.port.ask(request);
    } });
    let delivered = 0; const pending = f.tools.models.execute(args, options).then(result => { delivered++; return result; });
    await wait.started;
    if (changed === 'original-args') Object.defineProperty(args, 'undisplayed', { value: 'late metadata', enumerable: false });
    if (changed === 'session') record(f.context.session.runtime).sessionId = 'replacement';
    if (changed === 'owner') bindAgentResearchSourceOwner(f.registry, researchScreeningFixture().owner);
    if (changed === 'model-content') f.models[1]!.displayName = 'replacement';
    if (changed === 'provider-api') record(record(f.context).clients).providerApi = { ...f.providerApi };
    if (changed === 'config') f.config['helper.enabled'] = true;
    if (changed === 'registration') f.registry.register({ definition: { name: 'models', description: 'replacement', parameters: { type: 'object' } }, execute: async () => ({ success: true }) });
    if (changed === 'options-signal') options.signal = new AbortController().signal;
    wait.release(); await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
  });

  test.each(['models', 'agent_harness'] as const)('registered %s retains actual registration across canonical ranking', async name => {
    const f = fixture(); f.register(name); const fake = readings({ [`model:${winner}`]: 0.99 }); const wait = suspended();
    installJudgmentPort({ ...fake.port, ask: async request => {
      if (request.context?.battery === battery) { wait.start(); await wait.gate; }
      return fake.port.ask(request);
    } });
    const surface = { name, registered: true }; const pending = f.invoke(surface, detailArgs(surface));
    await wait.started; f.registry.unregister(name); wait.release(); await expect(pending).rejects.toThrow(); expect(f.effects).toEqual([]);
  });
});

function replaceProperty(target: object, key: string, descriptor: PropertyDescriptor) {
  const before = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restores.push(() => { if (before) Object.defineProperty(target, key, before); else Reflect.deleteProperty(target, key); });
}
type BackendChange = 'port' | 'model' | 'ask' | 'recorder' | 'recorder-method' | 'battery' | 'rerank' | 'header' | 'port-accessor' | 'rank-accessor' | 'recorder-accessor';
function changeBackend(changed: BackendChange, port: JudgmentPort, fake: ReturnType<typeof readings>, touched: { count: number }) {
  if (changed === 'port') installJudgmentPort(readings().port);
  if (changed === 'model') replaceProperty(port, 'model', { value: 'replacement-model', writable: true });
  if (changed === 'ask') replaceProperty(port, 'ask', { value: async (request: Parameters<JudgmentPort['ask']>[0]) => fake.port.ask(request), writable: true });
  if (changed === 'recorder') replaceProperty(port, 'recorder', { value: {}, writable: true });
  if (changed === 'recorder-method') replaceProperty(port.recorder!, 'recordAction', { value: () => { touched.count++; }, writable: true });
  if (changed === 'battery') replaceBattery();
  const definition = gateJudgmentRegistry.get(battery)!;
  if (changed === 'rerank') replaceProperty(definition, 'rerank', { value: async () => { touched.count++; throw new Error('replacement rerank must not run'); }, writable: true });
  if (changed === 'header') replaceProperty(definition, 'version', { value: 10_000, writable: true });
  if (changed === 'port-accessor') replaceProperty(port, 'model', { get() { touched.count++; return 'jev-1.13.0'; } });
  if (changed === 'rank-accessor') {
    const original = record(definition).rerank;
    replaceProperty(definition, 'rerank', { get() { touched.count++; return original; } });
  }
  if (changed === 'recorder-accessor') {
    const original = port.recorder!.recordAction;
    replaceProperty(port.recorder!, 'recordAction', { get() { touched.count++; return original; } });
  }
}

describe('acquired ranking backend survives every publication boundary', () => {
  test.each(['port', 'model', 'ask', 'recorder', 'recorder-method', 'battery', 'rerank', 'header', 'port-accessor', 'rank-accessor', 'recorder-accessor'] as const)('an awaited rank holds %s replacement without calling replacement accessors or methods', async changed => {
    const f = fixture(); const fake = readings({ [`model:${winner}`]: 0.99 }); const wait = suspended(); const touched = { count: 0 };
    using log = new FixtureDecisionLog();
    const port = withDecisionLog({ ...fake.port, ask: async request => {
      if (request.context?.battery === battery) { wait.start(); await wait.gate; }
      return fake.port.ask(request);
    } }, log); installJudgmentPort(port);
    let delivered = 0; const pending = f.tools.models.execute({ action: 'route', query }).then(result => { delivered++; return result; });
    await wait.started; changeBackend(changed, port, fake, touched); wait.release();
    await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(touched.count).toBe(0); expect(f.effects).toEqual([]);
  });

  for (const phase of ['cookbook', 'readiness'] as const) test.each(['battery', 'rerank', 'header', 'rank-accessor'] as const)(`${phase} await still fences earlier rank %s after ranking receipts were released`, async changed => {
    const f = fixture(); const fake = readings({ [`model:${winner}`]: 0.99 }); const wait = suspended(); const touched = { count: 0 };
    let rankingFinished = false, matchedPhase = false;
    const port: JudgmentPort = { ...fake.port, ask: async request => {
      if (request.context?.battery === battery) rankingFinished = true;
      const later = phase === 'cookbook' ? request.context?.battery === 'agent.models.local-recipe-fit' : request.context?.site === 'agent.models.route-readiness';
      if (later && rankingFinished) { matchedPhase = true; wait.start(); await wait.gate; }
      return fake.port.ask(request);
    } }; installJudgmentPort(port);
    let delivered = 0; const pending = f.tools.models.execute({ action: 'status', query, limit: 1 }).then(result => { delivered++; return result; });
    await wait.started; expect(matchedPhase).toBe(true); expect(ranks(fake)).toHaveLength(routeIds.length + f.models.length);
    changeBackend(changed, port, fake, touched); wait.release(); await expect(pending).rejects.toThrow();
    expect(delivered).toBe(0); expect(touched.count).toBe(0); expect(f.effects).toEqual([]);
  });

  for (const surface of [{ name: 'models', registered: false }, { name: 'agent_harness', registered: true }] as const) {
    test.each(['port', 'model', 'ask', 'recorder', 'recorder-method', 'battery', 'rerank', 'header'] as const)(`${surface.registered ? 'registered' : 'raw'} ${surface.name} final original-invocation release fences %s`, async changed => {
      const discriminator = surface.name === 'models' ? '"action":"route"' : '"mode":"model_route"';
      const paused = pauseSourceRelease(ordinaryResearchOwner(), source => source.includes(discriminator) && !source.includes('"invocation"'));
      const f = fixture(paused.owner); if (surface.registered) f.register(surface.name);
      const fake = readings({ 'route:custom-providers': 0.99 }); const touched = { count: 0 };
      using log = new FixtureDecisionLog(); const port = withDecisionLog(fake.port, log); installJudgmentPort(port);
      let delivered = 0; const pending = f.invoke(surface, detailArgs(surface)).then(result => { delivered++; return result; });
      await paused.wait.started; expect(ranks(fake)).toHaveLength(routeIds.length + f.models.length + 1);
      changeBackend(changed, port, fake, touched); paused.wait.release(); await expect(pending).rejects.toThrow();
      expect(delivered).toBe(0); expect(paused.counts.selected).toBe(1); expect(touched.count).toBe(0); expect(f.effects).toEqual([]);
    });
  }

  test.each(['models', 'agent_harness'] as const)('%s reusing the exact raw args object creates a fresh independent reading lifetime', async name => {
    const f = fixture(); const surface = { name, registered: false }; const args = detailArgs(surface);
    const first = readings({ 'route:custom-providers': 0.99 }); installJudgmentPort(first.port);
    expect(body(await f.invoke(surface, args)).modelRouteId).toBe('custom-providers');
    const second = readings({ 'route:main': 0.99 }); installJudgmentPort(second.port);
    expect(body(await f.invoke(surface, args)).modelRouteId).toBe('main');
    expect(ranks(first)).toHaveLength(routeIds.length + f.models.length + 1);
    expect(ranks(second)).toHaveLength(routeIds.length + f.models.length + 1); expect(f.effects).toEqual([]);
  });
});

for (const name of ['models', 'agent_harness'] as const) test(`registered ${name} retains authentic admission through translated ranking and final release`, async () => {
  let revoked = false;
  const reader = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: revoked, directory: '/synthetic/model-search' }),
    isAutoApproveEnabled: () => revoked, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/model-search' } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const discriminator = name === 'models' ? '"action":"route"' : '"mode":"model_route"';
  const paused = pauseSourceRelease(ordinaryResearchOwner(), source => source.includes(discriminator) && !source.includes('"invocation"'));
  const f = fixture(paused.owner, new ToolRegistry(manager)); f.register(name);
  const registered = f.registry.list().find(tool => tool.definition.name === name)!, execute = registered.execute;
  let originalArgs: Json | undefined, originalOptions: ToolExecuteOptions | undefined;
  registered.execute = async (args, options) => {
    originalArgs = args; originalOptions = options; expect(assertCurrentToolExecution(args, options)).toBe(true);
    return execute(args, options);
  };
  const fake = readings({ 'route:custom-providers': 0.99 }); let observedAdmission = 0;
  using log = new FixtureDecisionLog(); installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => {
    if (request.context?.battery === battery) { expect(assertCurrentToolExecution(originalArgs!, originalOptions)).toBe(true); observedAdmission++; }
    return fake.port.ask(request);
  } }, log));
  const surface = { name, registered: true }; const call = await f.registry.prepareCall('admitted-model-search', name, detailArgs(surface));
  const admission = await manager.admitAutonomous(call.callId, name, call.args, { sourceOf: () => ({ goal: 'Inspect the synthetic catalog', criteria: ['Read only synthetic data'] }),
    schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call } });
  expect(admission.result.approved).toBe(true);
  let delivered = 0; const pending = f.registry.executePrepared(call, admission).then(result => { delivered++; return result; });
  await paused.wait.started; expect(observedAdmission).toBe(routeIds.length + f.models.length + 1);
  revoked = true; paused.wait.release(); await expect(pending).rejects.toThrow();
  expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test.each(['raw', 'registered'] as const)('models local %s defaults to canonical local query without probing, mutating, or running smoke commands', async kind => {
  let inferenceRequests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { inferenceRequests++; return Response.json({ data: [] }); } });
  try {
    const f = fixture(); f.providers[1]!.baseUrl = `http://127.0.0.1:${server.port}/v1`;
    const surface = { name: 'models', registered: kind === 'registered' } as const; if (surface.registered) f.register('models');
    const fake = readings({ [`model:${winner}`]: 0.99, 'route:custom-providers': 0.99 }); installJudgmentPort(fake.port);
    const before = JSON.stringify({ models: f.models, providers: f.providers, config: f.config, artifacts: f.artifacts, runtime: f.context.session.runtime });
    const output = body(await f.invoke(surface, { action: 'local', limit: 1, includeParameters: true }));
    expect(ranks(fake).length).toBeGreaterThan(0); expect(ranks(fake).every(request => record(request.state).query === 'local')).toBe(true);
    expect(rows(output.models)[0]!.modelRouteId).toBe(winner);
    expect(record(record(output.localCookbook).localServerHealth).liveProbe).toBe('not-run');
    expect(inferenceRequests).toBe(0); expect(f.effects).toEqual([]);
    expect(JSON.stringify({ models: f.models, providers: f.providers, config: f.config, artifacts: f.artifacts, runtime: f.context.session.runtime })).toBe(before);
  } finally { await server.stop(true); }
});

for (const name of ['models', 'agent_harness'] as const) test.each(['preparation', 'execution'] as const)(`registered ${name} independently retains its %s cancellation signal through admission and ranking`, async cancelled => {
  const reader = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/model-search' }),
    isAutoApproveEnabled: () => false, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/model-search' } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const f = fixture(ordinaryResearchOwner(), new ToolRegistry(manager)); f.register(name);
  const preparation = new AbortController(), execution = new AbortController(), wait = suspended();
  const fake = readings({ 'route:custom-providers': 0.99 }); const seen: (AbortSignal | undefined)[] = [];
  using log = new FixtureDecisionLog(); installJudgmentPort(withDecisionLog({ ...fake.port, ask: async request => {
    if (request.context?.battery === battery) { seen.push(request.signal); wait.start(); await wait.gate; }
    return fake.port.ask(request);
  } }, log));
  const surface = { name, registered: true };
  const call = await f.registry.prepareCall('dual-signal-model-search', name, detailArgs(surface), { signal: preparation.signal });
  const admission = await manager.admitAutonomous(call.callId, name, call.args, { sourceOf: () => ({ goal: 'Inspect synthetic model routes', criteria: ['Read only synthetic catalog data'] }),
    schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call } });
  expect(admission.result.approved).toBe(true);
  let delivered = 0;
  const pending = f.registry.executePrepared(call, admission, { signal: execution.signal }).then(result => { delivered++; return result; });
  await wait.started; (cancelled === 'preparation' ? preparation : execution).abort();
  expect(seen.length).toBeGreaterThan(0); expect(seen.every(signal => signal?.aborted)).toBe(true);
  expect(cancelled === 'preparation' ? execution.signal.aborted : preparation.signal.aborted).toBe(false);
  wait.release(); await expect(pending).rejects.toThrow(); expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test.each(['models', 'agent_harness'] as const)('%s rejected raw invocation can be retried with the same object under a new backend', async name => {
  const f = fixture(); const surface = { name, registered: false }; const args = detailArgs(surface);
  installJudgmentPort({ model: 'jev-1.13.0', ask: async () => { throw new Error('synthetic rejected ranking'); } });
  await expect(f.invoke(surface, args)).rejects.toThrow('synthetic rejected ranking');
  const fresh = readings({ 'route:custom-providers': 0.99 }); installJudgmentPort(fresh.port);
  expect(body(await f.invoke(surface, args)).modelRouteId).toBe('custom-providers');
  expect(ranks(fresh)).toHaveLength(routeIds.length + f.models.length + 1); expect(f.effects).toEqual([]);
});

test.each(['unchanged', 'unavailable-current'] as const)('ranked current-model enrichment uses complete facts for %s cache identity', async kind => {
  const f = fixture();
  if (kind === 'unavailable-current') f.providerApi.getCurrentModel = async () => ({ ...f.models[0]!, available: false });
  const fake = readings({ [`model:${distractor}`]: 0.99 }); installJudgmentPort(fake.port);
  const output = body(await f.tools.models.execute({ action: 'status', query, limit: 1, includeParameters: true }));
  const current = record(record(output.current).currentModel), listed = rows(output.models)[0]!;
  expect(current.modelRouteId).toBe(distractor); expect(listed.modelRouteId).toBe(distractor);
  expect(fake.requests.filter(request => request.context?.site === 'agent.models.route-readiness'
    && record(record(request.state).subject).registryKey === distractor)).toHaveLength(kind === 'unchanged' ? 1 : 2);
  if (kind === 'unchanged') { expect(current.readiness).toEqual(listed.readiness); expect(current.available).toBe(true); }
  else {
    expect(current.available).toBe(false); expect(current.readiness).toMatchObject({ score: null, outcome: 'unavailable' });
    expect(listed.available).toBe(true); expect(listed.readiness).toMatchObject({ score: 100, outcome: 'ready' });
  }
  expect(f.effects).toEqual([]);
});

test('exact route identity keeps existing route-before-model precedence even when typed search identities collide', async () => {
  const f = fixture(); f.models.push({ ...f.models[1], registryKey: 'main', modelId: 'model-main' });
  const fake = readings({ 'model:main': 0.99 }); installJudgmentPort(fake.port);
  const output = body(await f.tools.models.execute({ action: 'route', modelRouteId: 'MAIN' }));
  expect(output.kind).toBe('route'); expect(output.modelRouteId).toBe('main'); expect(output.judgment).toBeUndefined();
  expect(ranks(fake)).toHaveLength(0); expect(f.effects).toEqual([]);
});

test('sole canonical endpoint yes returns inspection facts without probing the endpoint', async () => {
  let probes = 0; const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { probes++; return Response.json({ data: [] }); } });
  try {
    const f = fixture(); const baseUrl = `http://127.0.0.1:${server.port}/v1`; f.providers[1]!.baseUrl = baseUrl;
    const id = localEndpointId(baseUrl); const fake = readings({ [`local-server-endpoint:${id}`]: 0.99 }); installJudgmentPort(fake.port);
    const output = body(await f.tools.models.execute({ action: 'route', query }));
    expect(output.kind).toBe('local-server-endpoint'); expect(output.modelRouteId).toBe(id);
    expect(record(output.judgment).id).toBe(`local-server-endpoint:${id}`); expect(record(output.diagnostics).liveProbe).toBe('not-run');
    expect(probes).toBe(0); expect(f.effects).toEqual([]);
  } finally { await server.stop(true); }
});

test.each(['original-source', 'admission'] as const)('hosted retry hook rechecks %s revocation before retry or any stale log write', async changed => {
  let revoked = false;
  const reader = { getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: revoked, directory: '/synthetic/model-search' }),
    isAutoApproveEnabled: () => revoked, getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }), getWorkingDirectory: () => '/synthetic/model-search' } as PermissionConfigReader;
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const f = fixture(ordinaryResearchOwner(), new ToolRegistry(manager)); const args: Json = { action: 'route', query };
  if (changed === 'admission') f.register('models');
  const wait = suspended(), fake = readings({ 'route:custom-providers': 0.99 }); let retryHooks = 0, writes = 0, delivered = 0;
  using log = new FixtureDecisionLog();
  const port = withDecisionLog({ ...fake.port, ask: async request => {
    if (request.context?.battery === battery) {
      wait.start(); await wait.gate; expect(typeof request.beforeAttempt).toBe('function');
      retryHooks++; request.beforeAttempt!();
    }
    return fake.port.ask(request);
  } }, log);
  const recorder = port.recorder!;
  record(port).recorder = {
    recordReadings: (...args: Parameters<typeof recorder.recordReadings>) => { writes++; recorder.recordReadings(...args); },
    recordAction: (...args: Parameters<typeof recorder.recordAction>) => { writes++; recorder.recordAction(...args); },
  };
  installJudgmentPort(port);
  const pending = (async () => {
    if (changed === 'original-source') return f.tools.models.execute(args);
    const call = await f.registry.prepareCall('retry-model-search', 'models', args);
    const admission = await manager.admitAutonomous(call.callId, 'models', call.args, { sourceOf: () => ({ goal: 'Inspect synthetic model routes', criteria: ['Read only synthetic catalog data'] }),
      schemaRevision: call.schemaRevision, preparedCall: { registry: f.registry, call } });
    expect(admission.result.approved).toBe(true); return f.registry.executePrepared(call, admission);
  })().then(result => { delivered++; return result; });
  await wait.started; const priorWrites = writes;
  if (changed === 'original-source') Object.defineProperty(args, 'undisplayed', { value: 'revoked original source', enumerable: false });
  else revoked = true;
  wait.release(); await expect(pending).rejects.toThrow();
  expect(retryHooks).toBeGreaterThan(0); expect(ranks(fake)).toHaveLength(0);
  expect(writes).toBe(priorWrites); expect(log.query({ battery })).toHaveLength(0);
  expect(delivered).toBe(0); expect(f.effects).toEqual([]);
});

test.each(['recordReadings', 'recordAction'] as const)('revocation inside the first %s callback prevents every subsequent stale recorder write', async boundary => {
  const f = fixture(), fake = readings({ 'route:custom-providers': 0.99 }); const args: Json = { action: 'route', query };
  const counts = { recordReadings: 0, recordAction: 0 }; let revoked = false, staleWrites = 0, delivered = 0;
  const write = (kind: keyof typeof counts) => {
    if (revoked) staleWrites++;
    counts[kind]++;
    if (kind === boundary) { revoked = true; Object.defineProperty(args, 'undisplayed', { value: 'revoked during recorder callback', enumerable: false }); }
  };
  const port: JudgmentPort = { ...fake.port,
    ask: async request => ({ ...await fake.port.ask(request), decisionId: 'synthetic-catalog-decision' }),
    recorder: { recordReadings: () => write('recordReadings'), recordAction: () => write('recordAction') },
  }; installJudgmentPort(port);
  await expect(f.tools.models.execute(args).then(result => { delivered++; return result; })).rejects.toThrow();
  expect(counts[boundary]).toBe(1); expect(staleWrites).toBe(0); expect(delivered).toBe(0);
  if (boundary === 'recordReadings') expect(counts.recordAction).toBe(0);
  else expect(counts.recordReadings).toBe(routeIds.length + f.models.length + 1);
  expect(f.effects).toEqual([]);
});


test('a generated collision UUID records and reaches later cookbook readiness with exact encoded provenance', async () => {
  const f = fixture(), fake = readings({ [`model:${winner}`]: 0.99 });
  using log = new FixtureDecisionLog(true); installJudgmentPort(withDecisionLog(fake.port, log));
  const result = await f.tools.models.execute({ action: 'status', query });
  expect(result.success).toBe(true);
  const fit = log.query({ battery: 'agent.models.local-recipe-fit' }).find(entry => entry.id === 'abkbcgkn-jjbo-hacd-jggf-affjidlbbmnn')!;
  expect<string>(fit.id).toBe('abkbcgkn-jjbo-hacd-jggf-affjidlbbmnn');
  expect(log.get(collisionId)).toBeUndefined();
  expect(log.get(fit.id)?.context.battery).toBe('agent.models.local-recipe-fit');
  const later = fake.requests.filter(request => request.context?.site === 'agent.models.route-readiness'
    && record(request.state).localFit !== undefined);
  expect(later.length).toBeGreaterThan(0);
  expect(JSON.stringify(later)).toContain(fit.id);
  expect(JSON.stringify(later)).not.toContain(collisionId);
  expect(f.effects).toEqual([]);
});

test('an existing raw legacy PAN-shaped SQLite provenance key remains refused before cookbook readiness', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-decision-key-'));
  try {
    const f = fixture(), fake = readings({ [`model:${winner}`]: 0.99 });
    using log = new FixtureDecisionLog(true, join(dir, 'decisions.sqlite')); installJudgmentPort(withDecisionLog(fake.port, log));
    let held: unknown;
    try { await f.tools.models.execute({ action: 'status', query }); } catch (error) { held = error; }
    expect(held).toMatchObject({ problem: 'card-material' });
    expect(String(held)).not.toContain(collisionId);
    expect(JSON.stringify(fake.requests)).not.toContain(collisionId);
    expect(log.get(collisionId)?.context.battery).toBe('agent.models.local-recipe-fit');
    expect(fake.requests.some(request => request.context?.site === 'agent.models.route-readiness'
      && record(request.state).localFit !== undefined)).toBe(false);
    expect(f.effects).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
