import type { KnowledgeStore } from '../../sdk/src/platform/knowledge/store.js';
import type { KnowledgeNodeUpsertInput } from '../../sdk/src/platform/knowledge/types.js';
import { upsertObservedKnowledgeNode } from '../../sdk/src/platform/knowledge/store-node-observation.js';

/** A declared synthetic Home Assistant observation, never a synthesized fact or operator review. */
export function seedHomeAssistantObservation(store: KnowledgeStore, input: KnowledgeNodeUpsertInput) {
  if (!['ha_home', 'ha_area', 'ha_device', 'ha_entity', 'ha_automation', 'ha_script', 'ha_scene', 'ha_label', 'ha_integration'].includes(input.kind)
    || ['semanticKind', 'factKind', 'review', 'reviewedAt', 'reviewer', 'generatedKnowledgePage'].some((key) => key in (input.metadata ?? {}))) {
    throw new Error('Home Assistant fixture requires a raw observation, not a synthesized or reviewed claim');
  }
  const evidence = structuredClone(input);
  return upsertObservedKnowledgeNode(store, input, 'home-assistant-snapshot', evidence, () => evidence);
}
