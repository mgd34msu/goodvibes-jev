/**
 * session-runtime-verbs.test.ts
 *
 * The session-scoped operator verbs: sessions.permissionMode.get/set and
 * sessions.contextUsage.get. Pins the operator<->config mode vocabulary
 * mapping, the honest 404 for a non-local session, the previousMode reported
 * on a set, and the context-usage figures (derived from the estimator, flagged
 * `estimated`).
 */
import { describe, expect, test } from 'bun:test';
import { ModelLimitsService } from '../sdk/src/platform/providers/model-limits.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import { deriveContextUsage } from '../sdk/src/platform/runtime/context-usage.js';
import { firstJsonSchemaFailure } from '../transport-http/src/client-plumbing.js';
import type { GatewayMethodInvocation } from '../sdk/src/platform/control-plane/method-catalog-shared.js';
import type { PermissionMode } from '../sdk/src/platform/config/schema-types.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { GatewayVerbError } from '../sdk/src/platform/control-plane/routes/gateway-verb-error.js';
import {
  createSessionRuntimeControls,
  SessionLiveTurnControlsHolder,
  createSessionPermissionModeGetHandler,
  createSessionPermissionModeSetHandler,
  createSessionContextUsageGetHandler,
  registerSessionRuntimeGatewayMethods,
  toOperatorPermissionMode,
  toConfigPermissionMode,
  type PermissionModeConfig,
  type SessionRuntimeStateReader,
} from '../sdk/src/platform/control-plane/routes/session-runtime.js';

function invoke(body: Record<string, unknown>): GatewayMethodInvocation {
  return { body, context: {} };
}

/** A config double storing a single permissions.mode value. */
function makeConfig(initial: PermissionMode): PermissionModeConfig & { current: PermissionMode } {
  return {
    current: initial,
    get(_key) {
      return this.current;
    },
    set(_key, value) {
      this.current = value;
    },
  };
}

function makeStore(sessionId: string, usedTokens: number, contextWindow: number): SessionRuntimeStateReader {
  return {
    getState: () => ({
      session: { id: sessionId },
      conversation: { estimatedContextTokens: usedTokens },
      model: { tokenLimits: { contextWindow } },
    }),
  };
}

const model: ModelDefinition = {
  id: 'fixture-model', provider: 'fixture-provider', registryKey: 'fixture-provider:fixture-model',
  displayName: 'Fixture model', description: '', selectable: true, contextWindow: 100_000,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
};
const limits = new ModelLimitsService({ cachePath: '/unused/session-context-limits.json' });
function registry(getCurrentModel: () => ModelDefinition = () => model) {
  return {
    getCurrentModel,
    getContextWindowForModel: (entry: ModelDefinition) => limits.getContextWindowForModel(entry),
    getKnownContextWindowForModel: (entry: ModelDefinition) => limits.getKnownContextWindowForModel(entry),
  };
}

// ── vocabulary mapping ───────────────────────────────────────────────────────

describe('permission mode vocabulary', () => {
  test('config -> operator vocabulary', () => {
    expect(toOperatorPermissionMode('prompt')).toBe('normal');
    expect(toOperatorPermissionMode('allow-all')).toBe('auto');
    expect(toOperatorPermissionMode('plan')).toBe('plan');
    expect(toOperatorPermissionMode('accept-edits')).toBe('accept-edits');
    expect(toOperatorPermissionMode('custom')).toBe('custom');
  });

  test('operator -> config vocabulary (settable only)', () => {
    expect(toConfigPermissionMode('normal')).toBe('prompt');
    expect(toConfigPermissionMode('auto')).toBe('allow-all');
    expect(toConfigPermissionMode('plan')).toBe('plan');
    expect(toConfigPermissionMode('accept-edits')).toBe('accept-edits');
  });

  test('an unknown or non-settable mode is a 400', () => {
    expect(() => toConfigPermissionMode('custom')).toThrow(GatewayVerbError);
    expect(() => toConfigPermissionMode('nope')).toThrow(GatewayVerbError);
  });
});

// ── get / set handlers ───────────────────────────────────────────────────────

describe('sessions.permissionMode get/set', () => {
  test('get returns the operator-vocabulary mode for the local runtime', () => {
    const config = makeConfig('prompt');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'sess-1' }));
    expect(out).toEqual({ sessionId: 'sess-1', mode: 'normal' });
  });

  test('the stable "runtime" alias always resolves the local runtime', () => {
    const config = makeConfig('plan');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'runtime' }));
    expect(out).toEqual({ sessionId: 'runtime', mode: 'plan' });
  });

  test('set writes config and reports the previous mode', () => {
    const config = makeConfig('prompt');
    const controls = createSessionRuntimeControls({ config, store: makeStore('sess-1', 0, 0) });
    const out = createSessionPermissionModeSetHandler(controls)(invoke({ sessionId: 'sess-1', mode: 'plan' }));
    expect(out).toEqual({ sessionId: 'sess-1', mode: 'plan', previousMode: 'normal' });
    expect(config.current).toBe('plan'); // config actually mutated (fires the wire event via the binding)
  });

  test('a non-local session id is an honest 404, never a fabricated answer', () => {
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('sess-1', 0, 0) });
    let thrown: unknown;
    try {
      createSessionPermissionModeGetHandler(controls)(invoke({ sessionId: 'other-session' }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GatewayVerbError);
    expect((thrown as GatewayVerbError).code).toBe('SESSION_NOT_LOCAL');
  });

  test('a missing sessionId is a 400', () => {
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('sess-1', 0, 0) });
    expect(() => createSessionPermissionModeGetHandler(controls)(invoke({}))).toThrow(GatewayVerbError);
  });
});

// ── context usage ─────────────────────────────────────────────────────────────

describe('sessions.contextUsage.get', () => {
  test('reports estimated tokens + derived pct/remaining, flagged estimated', () => {
    const controls = createSessionRuntimeControls({
      config: makeConfig('prompt'),
      store: makeStore('sess-1', 40_000, 200_000),
      providerRegistry: registry(),
    });
    const out = createSessionContextUsageGetHandler(controls)(invoke({ sessionId: 'sess-1' }));
    expect(out).toEqual({
      sessionId: 'sess-1',
      estimatedContextTokens: 40_000,
      contextWindow: 100_000,
      contextWindowSource: 'registry',
      contextUsagePct: 40,
      contextRemainingTokens: 60_000,
      estimated: true,
    });
  });

  test('missing registry stays unknown despite a positive store budget', () => {
    const controls = createSessionRuntimeControls({
      config: makeConfig('prompt'),
      store: makeStore('sess-1', 1234, 200_000),
    });
    const out = createSessionContextUsageGetHandler(controls)(invoke({ sessionId: 'sess-1' })) as {
      contextUsagePct: number | null;
      contextRemainingTokens: number | null;
    };
    expect(out.contextUsagePct).toBeNull();
    expect(out.contextRemainingTokens).toBeNull();
  });
});

// ── descriptor + handler register together (the 501 defect class) ────────────

describe('session-runtime gateway registration', () => {
  const IDS = ['sessions.permissionMode.get', 'sessions.permissionMode.set', 'sessions.contextUsage.get'];

  function makeCatalog() {
    const catalog = new GatewayMethodCatalog();
    const controls = createSessionRuntimeControls({
      config: makeConfig('prompt'),
      store: makeStore('sess-1', 40_000, 200_000),
      providerRegistry: registry(),
    });
    registerSessionRuntimeGatewayMethods(catalog, controls);
    return catalog;
  }

  test('all three verbs are cataloged with handlers attached', () => {
    const catalog = makeCatalog();
    for (const id of IDS) {
      expect(catalog.get(id)).not.toBeNull();
      expect(catalog.hasHandler(id)).toBe(true);
    }
  });

  test('the verbs round-trip through catalog.invoke', async () => {
    const catalog = makeCatalog();
    const ctx = { context: { admin: true } } as const;
    const got = await catalog.invoke('sessions.permissionMode.get', { ...ctx, body: { sessionId: 'sess-1' } }) as { mode: string };
    expect(got.mode).toBe('normal');
    const set = await catalog.invoke('sessions.permissionMode.set', { ...ctx, body: { sessionId: 'sess-1', mode: 'auto' } }) as { mode: string; previousMode: string };
    expect(set).toMatchObject({ mode: 'auto', previousMode: 'normal' });
    const usage = await catalog.invoke('sessions.contextUsage.get', { ...ctx, body: { sessionId: 'sess-1' } }) as { contextUsagePct: number; estimated: boolean };
    expect(usage.contextUsagePct).toBe(40);
    expect(usage.estimated).toBe(true);
  });
});


describe('session context provenance and identity', () => {
  test.each(['provider_api', 'configured_cap', 'observed_limit', 'catalog'] as const)('%s supplies a known denominator', source => {
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(() => ({ ...model, contextWindowProvenance: source })) });
    expect(controls.getContextUsage('local')).toMatchObject({ contextWindow: 100_000, contextUsagePct: 40,
      contextRemainingTokens: 60_000, contextWindowSource: source });
  });

  test.each(['fallback', 'accepted_floor'] as const)('%s keeps numeric estimates and accepted floors out of capacity', source => {
    const definition: ModelDefinition = { ...model, contextWindow: 128_000, contextWindowProvenance: source,
      contextWindowAcceptedFloor: 24_000, contextWindowOrigin: { kind: 'family_default' } };
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(() => definition) });
    expect(controls.getContextUsage('runtime')).toEqual({ estimatedContextTokens: 40_000, contextWindow: null,
      contextUsagePct: null, contextRemainingTokens: null, contextWindowSource: source,
      contextWindowAcceptedFloor: 24_000, contextWindowOrigin: { kind: 'family_default' } });
  });

  test('consensus retains its origin without claiming a ceiling', () => {
    const origin = { kind: 'consensus' as const, providers: 4, agreeing: 3 };
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(() => ({ ...model, contextWindowProvenance: 'catalog', contextWindowOrigin: origin })) });
    expect(controls.getContextUsage('local')).toMatchObject({ contextWindow: null, contextUsagePct: null,
      contextRemainingTokens: null, contextWindowSource: 'catalog', contextWindowOrigin: origin });
  });

  test('each read follows known, unknown, unresolvable and known-again model changes', () => {
    let current: ModelDefinition | null = model;
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(() => { if (!current) throw new Error('No current model'); return current; }) });
    expect(controls.getContextUsage('local').contextWindow).toBe(100_000);
    current = { ...model, contextWindowProvenance: 'fallback' };
    expect(controls.getContextUsage('local').contextWindow).toBeNull();
    current = null;
    expect(controls.getContextUsage('local')).toEqual({ estimatedContextTokens: 40_000, contextWindow: null,
      contextUsagePct: null, contextRemainingTokens: null });
    current = { ...model, contextWindow: 80_000, contextWindowProvenance: 'configured_cap' };
    expect(controls.getContextUsage('local')).toMatchObject({ contextWindow: 80_000, contextUsagePct: 50 });
  });

  test('hosted-only controls stay usable but cannot borrow the store context snapshot', () => {
    const holder = new SessionLiveTurnControlsHolder();
    const hosted = { cancelToolCall: () => true, listQueuedMessages: () => [], editQueuedMessage: () => true, deleteQueuedMessage: () => true };
    holder.bindSession('hosted', hosted);
    const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000),
      providerRegistry: registry(), liveTurnHolder: holder });
    expect(controls.isLocalSession('hosted')).toBe(true);
    expect(controls.getLiveTurnControls('hosted')).toBe(hosted);
    for (const id of ['hosted', 'absent']) {
      expect(() => createSessionContextUsageGetHandler(controls)(invoke({ sessionId: id }))).toThrow(GatewayVerbError);
      try { controls.getContextUsage(id); } catch (error) { expect(error).toMatchObject({ code: 'SESSION_NOT_LOCAL', status: 404 }); }
    }
    expect(controls.getContextUsage('runtime')).toEqual(controls.getContextUsage('local'));
    expect(() => createSessionContextUsageGetHandler(controls)(invoke({}))).toThrow(GatewayVerbError);
  });

  test('actual nullable responses obey the canonical typed schema', () => {
    const schema = new GatewayMethodCatalog().get('sessions.contextUsage.get')!.outputSchema!;
    for (const definition of [model, { ...model, contextWindowProvenance: 'fallback' as const, contextWindowAcceptedFloor: 24_000 },
      { ...model, contextWindowProvenance: 'catalog' as const, contextWindowOrigin: { kind: 'consensus' as const, providers: 4, agreeing: 3 } }]) {
      const controls = createSessionRuntimeControls({ config: makeConfig('prompt'), store: makeStore('local', 40_000, 200_000), providerRegistry: registry(() => definition) });
      const output = createSessionContextUsageGetHandler(controls)(invoke({ sessionId: 'local' }));
      expect(firstJsonSchemaFailure(schema, output)).toBeUndefined();
    }
    const base = { sessionId: 'local', estimatedContextTokens: 0, contextWindow: null, contextUsagePct: null, contextRemainingTokens: null, estimated: true };
    expect(firstJsonSchemaFailure(schema, { ...base, contextWindowSource: 'guessed' })).toBeDefined();
    expect(firstJsonSchemaFailure(schema, { ...base, contextWindowOrigin: { kind: 'consensus' } })).toBeDefined();
  });
});

describe('nullable context arithmetic', () => {
  test.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])('unknown %s stays distinct from exhausted', window => {
    expect(deriveContextUsage(100_000, window)).toEqual({ contextUsagePct: null, contextRemainingTokens: null });
  });
  test('known windows keep rounding, clamping and remaining semantics', () => {
    expect(deriveContextUsage(40_400, 100_000)).toEqual({ contextUsagePct: 40, contextRemainingTokens: 59_600 });
    expect(deriveContextUsage(120_000, 100_000)).toEqual({ contextUsagePct: 100, contextRemainingTokens: 0 });
    expect(deriveContextUsage(0, 100_000)).toEqual({ contextUsagePct: 0, contextRemainingTokens: 100_000 });
  });
});
