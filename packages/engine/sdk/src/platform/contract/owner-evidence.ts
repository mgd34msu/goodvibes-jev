import type { JsonValue } from '@goodvibes-jev/judgment';
import type { ContractView } from './types.js';

/** Registered host reads of the original owner's recorded work; never caller prose. */
export type OwnerEvidenceReader = (contract: ContractView, citationText: string) => JsonValue | undefined;

/** Session save bookkeeping is not a change to the observed source work. */
export function ownerEvidenceIdentity(evidence: JsonValue | undefined): JsonValue | undefined {
  return evidence && typeof evidence === 'object' && !Array.isArray(evidence)
    ? Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'sources')) : evidence;
}
