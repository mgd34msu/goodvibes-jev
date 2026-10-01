import { describe, expect, test } from 'bun:test';
import { describeContextWindowSource } from '../sdk/src/platform/providers/context-window-catalog.js';
import type { ModelDefinition } from '../sdk/src/platform/providers/registry-types.js';

function definition(fields: Pick<ModelDefinition, 'contextWindowProvenance' | 'contextWindowOrigin'>): ModelDefinition {
  return { id: 'm', provider: 'p', registryKey: 'p:m', displayName: 'm', description: '', contextWindow: 8192, selectable: true,
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, ...fields };
}
describe('context-window source labels', () => {
  test.each([
    [{ contextWindowProvenance: 'configured_cap', contextWindowOrigin: { kind: 'user_override' } }, 'user override'],
    [{ contextWindowProvenance: 'configured_cap', contextWindowOrigin: { kind: 'provider_file' } }, 'provider file'],
    [{ contextWindowProvenance: 'provider_api' }, 'reported by the provider'],
    [{ contextWindowProvenance: 'observed_limit' }, 'learned from a provider rejection'],
    [{ contextWindowProvenance: 'accepted_floor' }, 'the provider accepted a larger request than the stated window'],
    [{ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'catalog', catalogProviderId: 'openai' } }, 'catalog: openai'],
    [{ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'consensus', providers: 3, agreeing: 2 } }, 'estimate from 3 providers (2 agree)'],
    [{ contextWindowProvenance: 'catalog', contextWindowOrigin: { kind: 'consensus', providers: 1, agreeing: 1 } }, 'estimate from 1 provider'],
    [{ contextWindowProvenance: 'fallback', contextWindowOrigin: { kind: 'family_default' } }, 'family default (estimate)'],
    [{ contextWindowProvenance: 'fallback' }, 'default (nothing states it)'],
  ] satisfies [Pick<ModelDefinition, 'contextWindowProvenance' | 'contextWindowOrigin'>, string][])('%j has an honest source label', (fields, expected) => {
    expect(describeContextWindowSource(definition(fields))).toBe(expected);
  });
});
