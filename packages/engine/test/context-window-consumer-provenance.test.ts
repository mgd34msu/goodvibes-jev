import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { compactionQualityPort } from './_helpers/compaction-quality.ts';
import { CompactionManager } from '../sdk/src/platform/runtime/compaction/manager.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { createFeatureFlagManager } from '../sdk/src/platform/runtime/feature-flags/manager.js';
import { createSessionCompactionManager } from '../sdk/src/platform/core/compaction-lifecycle-route.js';
import { ModelLimitsService } from '../sdk/src/platform/providers/model-limits.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';
import type { ProviderMessage } from '../sdk/src/platform/providers/interface.js';
import type { BoundaryCommit } from '../sdk/src/platform/runtime/compaction/types.js';
import { enrichModelEntries } from '../sdk/src/platform/runtime/ui/model-picker/health-enrichment.js';
import { createInitialModelState } from '../sdk/src/platform/runtime/store/domains/model.js';
import { createInitialProviderHealthState } from '../sdk/src/platform/runtime/store/domains/provider-health.js';

const model: ModelDefinition = { id: 'm', provider: 'p', registryKey: 'p:m', displayName: 'm', description: '', selectable: true,
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 8192 };
const limits = new ModelLimitsService({ cachePath: '/unused/consumer-context-limits.json' });
const messages: ProviderMessage[] = Array.from({ length: 14 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `retain fact ${i}: ${'context '.repeat(50)}` }));
let previous: ReturnType<typeof installJudgmentPort>;
afterEach(() => { installJudgmentPort(previous); });

function picker(definition: ModelDefinition) {
  return enrichModelEntries([definition], createInitialProviderHealthState(), createInitialModelState(), new Set(),
    { getBenchmarks: () => undefined }, {
      getSyntheticModelInfoFromCatalog: () => null,
      getContextWindowForModel: (entry) => limits.getContextWindowForModel(entry),
      getKnownContextWindowForModel: (entry) => limits.getKnownContextWindowForModel(entry),
    }, () => undefined)[0]!;
}

describe('picker carries numeric budget separately from known capacity', () => {
  test('consensus retains estimate origin and a null known ceiling', () => {
    const origin = { kind: 'consensus' as const, providers: 4, agreeing: 3 };
    const entry = picker({ ...model, contextWindowProvenance: 'catalog', contextWindowOrigin: origin });
    expect(entry.contextWindow).toBe(8192);
    expect(entry.knownContextWindow).toBeNull();
    expect(entry.contextWindowOrigin).toEqual(origin);
    expect(entry.contextWindowSource).toBe('catalog');
  });
  test('accepted lower bounds survive a larger display estimate', () => {
    const entry = picker({ ...model, contextWindow: 128000, contextWindowProvenance: 'fallback', contextWindowAcceptedFloor: 24000 });
    expect(entry.contextWindow).toBe(128000);
    expect(entry.knownContextWindow).toBeNull();
    expect(entry.contextWindowAcceptedFloor).toBe(24000);
  });
  test('own-provider catalog origin remains known', () => {
    const origin = { kind: 'catalog' as const, catalogProviderId: 'p' };
    const entry = picker({ ...model, contextWindowProvenance: 'catalog', contextWindowOrigin: origin });
    expect(entry.knownContextWindow).toBe(8192);
    expect(entry.contextWindowOrigin).toEqual(origin);
  });
  test('invalid raw window gets a numeric fallback without falsely labeling OpenRouter', () => {
    const entry = picker({ ...model, contextWindow: Number.NaN });
    expect(Number.isFinite(entry.contextWindow)).toBe(true);
    expect(entry.knownContextWindow).toBeNull();
    expect(entry.contextWindowSource).toBe('fallback');
  });
  test.each(['fallback', 'accepted_floor'] as const)('%s stays nullable in the UI output', (source) => {
    const entry = picker({ ...model, contextWindowProvenance: source });
    expect(entry.knownContextWindow).toBeNull();
    expect(entry.contextWindowSource).toBe(source);
  });
});

describe('independent session compaction respects unknown ceilings', () => {
  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('automatic path with %s emits nothing and changes nothing', async (window) => {
    const bus = new RuntimeEventBus(); const events: string[] = [];
    const off = bus.onDomain('compaction', (event) => { events.push(event.payload.type); });
    const flags = createFeatureFlagManager(); flags.enable('session-compaction');
    const manager = new CompactionManager({ sessionId: 'unknown', bus, flags, contextWindow: window });
    const original = structuredClone(messages);
    expect(await manager.compact({ messages, tokenCount: 999999, trigger: 'auto' })).toBeNull();
    expect(events).toEqual([]);
    expect(manager.lastCommit).toBeNull();
    expect(manager.state).toBe('idle');
    expect(messages).toEqual(original);
    manager.dispose(); off();
  });

  test('factory re-reads knowledge after a model change and skips again if it becomes unknown', async () => {
    previous = installJudgmentPort(compactionQualityPort({ substance: 3, relation: 'supports' }).port);
    const bus = new RuntimeEventBus(); const events: string[] = [];
    const off = bus.onDomain('compaction', (event) => { events.push(event.payload.type); });
    const flags = createFeatureFlagManager(); flags.enable('session-compaction');
    let current: ModelDefinition = { ...model, contextWindowProvenance: 'fallback' };
    const manager = createSessionCompactionManager('switching', bus, flags, () => ({
      getCurrentModel: () => current,
      getKnownContextWindowForModel: (entry) => limits.getKnownContextWindowForModel(entry),
    }))!;
    expect(await manager.compact({ messages, tokenCount: 7000, trigger: 'auto' })).toBeNull();
    expect(events).toEqual([]);
    current = { ...model, contextWindowProvenance: 'provider_api' };
    expect(await manager.compact({ messages, tokenCount: 7000, trigger: 'auto' })).not.toBeNull();
    expect(events).toContain('COMPACTION_BOUNDARY_COMMIT');
    const saved = manager.lastCommit;
    events.length = 0;
    current = { ...model, contextWindowProvenance: 'accepted_floor' };
    expect(await manager.compact({ messages, tokenCount: 7000, trigger: 'auto' })).toBeNull();
    expect(events).toEqual([]);
    expect(manager.lastCommit).toBe(saved);
    manager.dispose(); off();
  });

  test.each(['manual', 'prompt_too_long', 'auto-warning'] as const)('%s still performs explicitly requested recovery with unknown capacity', async (kind) => {
    previous = installJudgmentPort(compactionQualityPort({ substance: 3, relation: 'supports' }).port);
    const flags = createFeatureFlagManager(); flags.enable('session-compaction');
    const manager = new CompactionManager({ sessionId: 'recovery', bus: new RuntimeEventBus(), flags, contextWindow: 0 });
    const result = await manager.compact({ messages, tokenCount: 10000,
      trigger: kind === 'auto-warning' ? 'auto' : kind, ...(kind === 'auto-warning' ? { isPromptTooLong: true } : {}) });
    expect(result).not.toBeNull();
    expect(manager.lastCommit).not.toBeNull();
    manager.dispose();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('resume repair with %s preserves every message without a guessed trim ceiling', (window) => {
    const flags = createFeatureFlagManager(); flags.enable('session-compaction');
    const manager = new CompactionManager({ sessionId: 'repair', bus: new RuntimeEventBus(), flags, contextWindow: window });
    const commit: BoundaryCommit = { checkpointId: 'cpt-1', sessionId: 'repair', createdAt: 1, strategy: 'autocompact', parentCheckpointId: null, lineage: [], messages, tokenCount: 10000, tokensBefore: 20000, summary: 'kept facts' };
    const repaired = manager.repair(commit);
    expect(repaired.messages).toEqual(messages);
    expect(repaired.actions).toEqual([]);
    expect(JSON.stringify(repaired)).not.toContain('maxTokens');
    expect(commit.messages).toBe(messages);
    manager.dispose();
  });
});
