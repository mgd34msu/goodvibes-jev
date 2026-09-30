import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeUpsertInput } from '../types.js';
import { semanticHash } from './utils.js';

/** Generated IDs are source/subject scoped; their human-readable slugs must not replace another identity. */
export function createSemanticNodeSlugPlanner(store: KnowledgeStore) {
  const reserved = new Map<string, string>();
  return <T extends KnowledgeNodeUpsertInput>(input: T): T => {
    if (!input.id) return input;
    const key = `${input.kind}:${input.slug}`;
    const occupant = reserved.get(key) ?? store.getNodeByKindAndSlug(input.kind, input.slug)?.id;
    const suffixed = `${input.slug}-${semanticHash(input.id)}`;
    const existing = store.getNode(input.id);
    // Keep a previously disambiguated URL stable even after the older collision disappears.
    const slug = existing?.slug === suffixed || (occupant && occupant !== input.id) ? suffixed : input.slug;
    reserved.set(`${input.kind}:${slug}`, input.id);
    return slug === input.slug ? input : { ...input, slug };
  };
}
