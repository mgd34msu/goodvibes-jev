import type { RepairProfileSubject } from '../repair-profile/types.js';

export type RepairSourceAuthority = 'official-vendor' | 'vendor' | 'secondary';
export interface RepairSourceAuthorityInput {
  readonly reference: string;
  readonly query: string;
  readonly subjects: readonly RepairProfileSubject[];
  readonly source: {
    readonly sourceType: string;
    readonly title?: string | undefined;
    readonly summary?: string | undefined;
    readonly description?: string | undefined;
    readonly url?: string | undefined;
    readonly sourceUri?: string | undefined;
    readonly canonicalUri?: string | undefined;
  };
  readonly extraction: { readonly format: string; readonly title?: string | undefined; readonly links: readonly string[] };
  readonly text: string;
  /** Discovery labels are claims from upstream discovery, never independently verified ownership. */
  readonly claimedProvenance: { readonly trustReason?: string | undefined; readonly sourceDomain?: string | undefined };
}
export interface RepairSourceAuthorityReading {
  readonly reference: string;
  readonly authority: RepairSourceAuthority;
  readonly probability: number;
}
export interface RepairSourceAuthorityOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export type RepairSourceAuthorityHoldReason = 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale' | 'foreign-space';
export class KnowledgeRepairSourceAuthorityHeldError extends Error {
  override readonly name = 'KnowledgeRepairSourceAuthorityHeldError';
  constructor(readonly reason: RepairSourceAuthorityHoldReason) {
    super(`Knowledge repair source authority held (${reason}); no source tier was authorized.`);
  }
}
export const REPAIR_SOURCE_AUTHORITY_LIMITS = Object.freeze({ inputs: Number.POSITIVE_INFINITY, characters: Number.POSITIVE_INFINITY,
  requests: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY, concurrency: 4, defaultTimeoutMs: 0, timeoutMs: 2_147_483_647 });
