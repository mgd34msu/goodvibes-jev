import type { JudgmentRetryProgress } from '@goodvibes-jev/judgment';

/** Trusted composition input, never a flag accepted from the source being screened. */
export interface LocalSourceScreeningAuthority {
  readonly ownerId: string;
  readonly revision: string;
  /** The host has established that BOTH local services keep no prompts/responses. */
  readonly retention: 'ephemeral-no-log';
  readonly signal: AbortSignal;
  /** Synchronous live capability/revision check; structural scanning is not authority. */
  readonly assertCurrent: () => void;
}
export interface ProtectedSourceOwnerOptions {
  readonly authority: LocalSourceScreeningAuthority;
  readonly proposal: { readonly endpoint: string; readonly model: string };
  readonly judgment: { readonly endpoint: string; readonly model: 'jev-1.13.0' };
  readonly timeoutMs?: number;
  /** Only value-free shared transport progress, never source or response metadata. */
  readonly onRetry?: (progress: JudgmentRetryProgress) => void;
}
declare const sourceBrand: unique symbol;
declare const receiptBrand: unique symbol;
/** Opaque process-local identity; the immutable original remains privately owned. */
export interface ProtectedSource { readonly [sourceBrand]: true; }
export interface SourceScreeningReceipt { readonly [receiptBrand]: true; }
export type SourceScreeningHold = 'route-unavailable' | 'protected-input' | 'malformed' | 'unsettled' | 'cancelled' | 'stale' | 'capacity' | 'busy';
export type SourceScreeningResult =
  | { readonly status: 'settled'; readonly receipt: SourceScreeningReceipt }
  | { readonly status: 'held'; readonly reason: SourceScreeningHold };
export interface ProtectedSourceOwner {
  capture(parts: readonly string[]): ProtectedSource;
  screen(source: ProtectedSource): Promise<SourceScreeningResult>;
  /** Only this owner's genuine, current receipt can release projected source text. */
  project(receipt: SourceScreeningReceipt): readonly string[];
  release(source: ProtectedSource): Promise<void>;
  close(): Promise<void>;
}
export const SOURCE_SCREENING_LIMITS = Object.freeze({ parts: 8, characters: 40_000, spans: 100, proposalBytes: 32_768,
  sources: 128, unsettledRevisions: 1_024 });
