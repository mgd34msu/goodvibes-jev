import type { DecisionContext, EntryType, JsonValue } from '../port/types.ts';
import type { JudgmentErrorKind } from '../port/errors.ts';

/** A decision log entry's id. */
export type DecisionId = string & { readonly __decisionId: true };

/** Token counts for one answered call. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** What every entry records about the call it describes. */
interface CallRecord {
  readonly id: DecisionId;
  /** ISO 8601 time the call was made. */
  readonly at: string;
  readonly context: DecisionContext;
  readonly requestedModel: string;
  /** SHA-256 of the canonical state JSON; the state itself is not stored. */
  readonly stateHash: string;
  readonly questions: JsonValue;
  readonly latencyMs: number;
  readonly requestId: string | undefined;
}

/** A call the endpoint answered. Readings and the action are attached afterwards, when a decision draws them. */
export interface AnsweredEntry extends CallRecord {
  readonly status: 'answered';
  /** The versioned model that answered. */
  readonly model: string;
  /** Raw answers as the endpoint returned them. */
  readonly answers: JsonValue;
  readonly usage: TokenUsage;
  readonly readings?: JsonValue;
  readonly action?: string;
}

/** A call that failed; nothing was read from it. */
export interface FailedEntry extends CallRecord {
  readonly status: 'failed';
  readonly error: { readonly kind: JudgmentErrorKind; readonly message: string };
}

export type DecisionEntry = AnsweredEntry | FailedEntry;

/** What a caller supplies to record an entry; the log assigns the id. */
export type NewDecisionEntry = Omit<AnsweredEntry, 'id' | 'readings' | 'action'> | Omit<FailedEntry, 'id'>;

export interface DecisionQuery {
  readonly battery?: string;
  readonly site?: string;
  /** Inclusive lower bound on `at`. */
  readonly since?: string;
  /** Exclusive upper bound on `at`. */
  readonly until?: string;
  /** Entries where at least one reading has this outcome. */
  readonly outcome?: 'act' | 'confirm' | 'escalate';
  readonly status?: DecisionEntry['status'];
  /** Newest first; default 1000. */
  readonly limit?: number;
}

/**
 * Durable record of every reading. The engine state layer hosts an
 * implementation; this package ships the SQLite one.
 */
export interface DecisionLog {
  /** Appends an entry and returns its id. Throws when the write fails. */
  record(entry: NewDecisionEntry): DecisionId;
  recordReadings(id: string, readings: JsonValue): void;
  recordAction(id: string, action: string): void;
  get(id: string): DecisionEntry | undefined;
  query(query?: DecisionQuery): readonly DecisionEntry[];
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sortKeys = (value: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Canonical JSON: object keys sorted, so equal states hash equally. */
export function canonicalJson(value: EntryType | JsonValue | undefined): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value, (_key, inner: unknown) => (isPlainObject(inner) ? sortKeys(inner) : inner));
}

export function hashState(state: EntryType): string {
  return Bun.CryptoHasher.hash('sha256', canonicalJson(state), 'hex');
}
