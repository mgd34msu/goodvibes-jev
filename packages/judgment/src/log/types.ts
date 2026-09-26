import type { DecisionContext, EntryType, JsonValue } from '../port/types.ts';
import type { JudgmentErrorKind } from '../port/errors.ts';

/** A decision log entry's id. */
export type DecisionId = string & { readonly __decisionId: true };
/** An ISO 8601 timestamp. */
export type IsoTime = string & { readonly __isoTime: true };
/** SHA-256 of a state's canonical JSON, in hex. */
export type StateHash = string & { readonly __stateHash: true };

export const isoTime = (date: Date): IsoTime => date.toISOString() as IsoTime;

/** Token counts for one answered call. */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** What every entry records about the call it describes. */
interface CallRecord {
  readonly id: DecisionId;
  /** When the call was made. */
  readonly at: IsoTime;
  readonly context: DecisionContext;
  readonly requestedModel: string;
  /** The state itself is not stored. */
  readonly stateHash: StateHash;
  readonly questions: JsonValue;
  readonly latencyMs: number;
  readonly requestId: string | undefined;
}

/** Something recorded about a call after it answered: what the decision concluded, or what code did with it. */
export type DecisionNote =
  | { readonly kind: 'readings'; readonly readings: JsonValue }
  | { readonly kind: 'action'; readonly action: string };

/** A call the endpoint answered. */
export interface AnsweredEntry extends CallRecord {
  readonly status: 'answered';
  /** The versioned model that answered. */
  readonly model: string;
  /** Raw answers as the endpoint returned them. */
  readonly answers: JsonValue;
  readonly usage: TokenUsage;
  /** Notes attached after the call, in the order they were recorded. */
  readonly notes: readonly DecisionNote[];
}

/** What the decision concluded from an entry's answers, when it has said. */
export function readingsOf(entry: DecisionEntry): JsonValue | undefined {
  if (entry.status !== 'answered') return undefined;
  const note = entry.notes.find((candidate) => candidate.kind === 'readings');
  return note?.kind === 'readings' ? note.readings : undefined;
}

/** What code did with an entry's decision, when it has said. */
export function actionOf(entry: DecisionEntry): string | undefined {
  if (entry.status !== 'answered') return undefined;
  const note = entry.notes.find((candidate) => candidate.kind === 'action');
  return note?.kind === 'action' ? note.action : undefined;
}

/** A call that failed; nothing was read from it. */
export interface FailedEntry extends CallRecord {
  readonly status: 'failed';
  readonly error: { readonly kind: JudgmentErrorKind; readonly message: string };
}

export type DecisionEntry = AnsweredEntry | FailedEntry;

/** What a caller supplies to record an entry; the log assigns the id. */
export type NewDecisionEntry = Omit<AnsweredEntry, 'id' | 'notes'> | Omit<FailedEntry, 'id'>;

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
  Object.prototype.toString.call(value) === '[object Object]';

const sortKeys = (value: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

/** Canonical JSON: object keys sorted, so equal states hash equally. */
export function canonicalJson(value: EntryType | JsonValue | undefined): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value, (_key, inner: unknown) => (isPlainObject(inner) ? sortKeys(inner) : inner));
}

export function hashState(state: EntryType): StateHash {
  return Bun.CryptoHasher.hash('sha256', canonicalJson(state), 'hex') as StateHash;
}
