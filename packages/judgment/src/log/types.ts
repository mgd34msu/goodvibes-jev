import type { DecisionContext, EntryType, JsonValue } from '../port/types.ts';
import type { JudgmentErrorKind } from '../port/errors.ts';

/** One judgment call as the log records it. */
export interface DecisionEntry {
  readonly id: string;
  /** ISO 8601 time the call was made. */
  readonly at: string;
  readonly context: DecisionContext;
  readonly requestedModel: string;
  /** The versioned model that answered; absent when the call failed. */
  readonly model: string | undefined;
  /** SHA-256 of the canonical state JSON; the state itself is not stored. */
  readonly stateHash: string;
  readonly questions: JsonValue;
  /** Raw answers as the endpoint returned them; absent when the call failed. */
  readonly answers: JsonValue | undefined;
  /** Banded readings drawn from the answers, when a battery read them. */
  readonly readings: JsonValue | undefined;
  /** What code did with the readings, when it said. */
  readonly action: string | undefined;
  readonly latencyMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
  readonly requestId: string | undefined;
  readonly error: { readonly kind: JudgmentErrorKind; readonly message: string } | undefined;
}

export type NewDecisionEntry = Omit<DecisionEntry, 'id' | 'readings' | 'action'>;

export interface DecisionQuery {
  readonly battery?: string;
  readonly site?: string;
  /** Inclusive lower bound on `at`. */
  readonly since?: string;
  /** Exclusive upper bound on `at`. */
  readonly until?: string;
  /** Entries where at least one reading has this outcome. */
  readonly outcome?: 'act' | 'confirm' | 'escalate';
  /** true: failed calls only; false: answered calls only. */
  readonly failed?: boolean;
  /** Newest first; default 1000. */
  readonly limit?: number;
}

/**
 * Durable record of every reading. The engine state layer hosts an
 * implementation; this package ships the SQLite one.
 */
export interface DecisionLog {
  /** Appends an entry and returns its id. Throws when the write fails. */
  record(entry: NewDecisionEntry): string;
  recordReadings(id: string, readings: JsonValue): void;
  recordAction(id: string, action: string): void;
  get(id: string): DecisionEntry | undefined;
  query(query?: DecisionQuery): readonly DecisionEntry[];
}

/** Canonical JSON: object keys sorted, so equal states hash equally. */
export function canonicalJson(value: EntryType | JsonValue | undefined): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

export function hashState(state: EntryType): string {
  return new Bun.CryptoHasher('sha256').update(canonicalJson(state)).digest('hex');
}
