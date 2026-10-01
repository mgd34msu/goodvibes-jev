/**
 * memory-provenance.ts, reads the memory-injection ids a chat turn's message
 * metadata carries, when it carries any.
 *
 * There is no dedicated wire field for this yet: CompanionChatMessage carries
 * only a generic `metadata?: Record<string, unknown>` bag (companion-chat-types.ts),
 * the same open-ended shape every message metadata field in this codebase already
 * is (see channels.profiles.*'s metadata, principals.*'s metadata). The convention
 * this module reads, `metadata.memory.recordIds: string[]`, mirrors the SDK's own
 * real per-turn injection accounting (TurnInjectionRecord.injectedIds,
 * platform/agents/turn-knowledge-injection.ts, "appended verbatim to the agent's
 * session transcript"), scoped down to just the ids a companion chat turn actually
 * used. A daemon that does not yet stamp this renders nothing here, never
 * fabricated, matching this codebase's honest-absence idiom everywhere else
 * (empty `reasons`, `checkpointCount: 0`, etc.).
 *
 * Reading is fully defensive: a malformed or absent `metadata.memory` yields an
 * empty array, never a thrown error, the chip (MemoryProvenanceChip.tsx) treats
 * an empty array as "nothing to show", not a degraded state.
 */

export function readMemoryProvenanceIds(metadata: unknown): readonly string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const memory = (metadata as Record<string, unknown>).memory;
  if (!memory || typeof memory !== 'object') return [];
  const recordIds = (memory as Record<string, unknown>).recordIds;
  if (!Array.isArray(recordIds)) return [];
  return recordIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
}
