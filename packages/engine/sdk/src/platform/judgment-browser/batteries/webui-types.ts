import type { Outcome } from '@goodvibes-jev/judgment';

/** Server reader results. Non-ready results deliberately contain no selected value. */
export type WebuiReadResult<T> =
  | { readonly status: 'ready'; readonly value: T; readonly basis: 'structured' | 'judgment'; readonly decisionIds?: readonly string[] }
  | { readonly status: 'uncertain'; readonly reason: 'unsettled' | 'conflicting-evidence'; readonly outcome: Exclude<Outcome, 'act'> }
  | { readonly status: 'held'; readonly reason: 'private-input' | 'unsafe-input' | 'unsupported-input' | 'budget' }
  | { readonly status: 'unavailable'; readonly reason: 'unconfigured' | 'offline' | 'timeout' | 'aborted' | 'stale' | 'invalid-response' };

export interface WebuiReaderOptions { readonly signal?: AbortSignal }

export const WEBUI_READER_LIMITS = Object.freeze({
  errorBytes: 4096, statusChars: 256, queryChars: 256,
  candidateCount: 64, titleChars: 256, groupChars: 128,
  keywordCount: 16, keywordChars: 64, concurrency: 4,
});

export const REFUSAL_ITEMS = ['session_not_found', 'session_closed', 'session_active', 'session_not_local', 'method_unknown'] as const;
export type DaemonRefusalItem = typeof REFUSAL_ITEMS[number];
export type DaemonRefusalValue = Readonly<Record<DaemonRefusalItem, boolean>>;

/** Already resolved by the server. Never accept this as the browser request schema. */
export interface ResolvedDaemonRefusal {
  readonly methodId: string;
  readonly status?: number;
  readonly code?: string;
  readonly category?: 'network' | 'authentication';
  readonly message: string;
}

export const BADGE_TONES = ['ok', 'warning', 'bad', 'neutral'] as const;
export const LIBRARY_DOT_TONES = ['ok', 'warn', 'bad', 'info', 'idle'] as const;
export type StatusValue =
  | { readonly vocabulary: 'badge'; readonly tone: typeof BADGE_TONES[number] }
  | { readonly vocabulary: 'library-dot'; readonly tone: typeof LIBRARY_DOT_TONES[number] };
export const STATUS_DOMAINS = ['provider-auth', 'session', 'knowledge-job', 'candidate', 'account-auth'] as const;
export type StatusDomain = typeof STATUS_DOMAINS[number];

/**
 * `structured` is produced only by an authoritative catalog/closed-enum adapter.
 * It is not a browser-provided tone, permission, or privacy clearance.
 */
export type ResolvedStatus =
  | ({ readonly kind: 'structured' } & StatusValue)
  | { readonly kind: 'text'; readonly vocabulary: StatusValue['vocabulary']; readonly status: string; readonly domain: StatusDomain };

/** Descriptors only: identities remain in the authenticated resolver's index map. */
export interface ResolvedCommandCandidate {
  readonly title: string;
  readonly group?: string;
  readonly keywords?: readonly string[];
}
export interface ResolvedCommandRank {
  readonly query: string;
  readonly registryVersion: string;
  readonly candidates: readonly ResolvedCommandCandidate[];
}
export interface CommandRankValue {
  readonly registryVersion: string;
  readonly accepted: readonly { readonly candidateIndex: number; readonly probability: number }[];
  readonly rejected: readonly number[];
}
