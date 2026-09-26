import { Database } from 'bun:sqlite';
import type { DecisionContext, JsonValue } from '../port/types.ts';
import type { AnsweredEntry, CallRecord, DecisionEntry, DecisionId, DecisionLog, DecisionNote, DecisionQuery, FailedEntry, NewDecisionEntry } from './types.ts';

/** The one table the log keeps. */
const TABLE = 'decisions';

/** Bumped whenever the table shape changes; an older file is refused rather than misread. */
const SCHEMA_VERSION = 1;

/** Every column and its SQL declaration, in table order. */
const COLUMNS = {
  id: 'TEXT PRIMARY KEY',
  at: 'TEXT NOT NULL',
  status: 'TEXT NOT NULL',
  battery: 'TEXT',
  battery_version: 'INTEGER',
  pattern: 'TEXT',
  site: 'TEXT',
  requested_model: 'TEXT NOT NULL',
  model: 'TEXT',
  state_hash: 'TEXT NOT NULL',
  questions: 'TEXT NOT NULL',
  answers: 'TEXT',
  readings: 'TEXT',
  action: 'TEXT',
  latency_ms: 'REAL NOT NULL',
  input_tokens: 'INTEGER',
  output_tokens: 'INTEGER',
  request_id: 'TEXT',
  error_kind: 'TEXT',
  error_message: 'TEXT',
} as const;
type Column = keyof typeof COLUMNS;

/** Each note kind is stored in the column of the same name, attached after the call is recorded. */
type NoteColumn = DecisionNote['kind'];
/** How a note of one kind is written to its column and read back. */
interface NoteCodec<N extends DecisionNote> {
  write(note: N): string;
  read(text: string): N;
}
const NOTE_CODECS: { readonly [K in NoteColumn]: NoteCodec<Extract<DecisionNote, { kind: K }>> } = {
  readings: { write: (note) => JSON.stringify(note.readings), read: (text) => ({ kind: 'readings', readings: parseJson(text) }) },
  action: { write: (note) => note.action, read: (text) => ({ kind: 'action', action: text }) },
};
const NOTE_COLUMNS = Object.keys(NOTE_CODECS) as NoteColumn[];
const codecFor = (column: NoteColumn): NoteCodec<DecisionNote> => NOTE_CODECS[column] as NoteCodec<DecisionNote>;
type InsertColumn = Exclude<Column, NoteColumn>;
const INSERT_COLUMNS = (Object.keys(COLUMNS) as Column[]).filter((column): column is InsertColumn => !(NOTE_COLUMNS as readonly Column[]).includes(column));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
${Object.entries(COLUMNS).map(([column, declaration]) => `  ${column} ${declaration}`).join(',\n')}
);
CREATE INDEX IF NOT EXISTS ${TABLE}_battery_at ON ${TABLE} (battery, at);
CREATE INDEX IF NOT EXISTS ${TABLE}_site_at ON ${TABLE} (site, at);
CREATE INDEX IF NOT EXISTS ${TABLE}_at ON ${TABLE} (at);
`;

/** A column's value as bun:sqlite returns it: numbers for INTEGER and REAL, strings for TEXT, null unless declared NOT NULL or PRIMARY KEY. */
type ValueOf<D extends string> =
  | (D extends `INTEGER${string}` | `REAL${string}` ? number : string)
  | (D extends `${string}NOT NULL` | `${string}PRIMARY KEY` ? never : null);
type Row = { readonly [C in Column]: ValueOf<(typeof COLUMNS)[C]> };

type Params = Record<string, string | number | null>;

/** The same record without its null entries. */
function presentOnly<T extends Record<string, unknown>>(record: T): { [K in keyof T]?: NonNullable<T[K]> } {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null)) as { [K in keyof T]?: NonNullable<T[K]> };
}

/** Fields stored one to one, each with the column it is stored in. */
type FieldColumns = Readonly<Record<string, Column>>;

/** The fields every entry stores as they are, answered or failed. */
const CALL_COLUMNS = {
  at: 'at',
  status: 'status',
  requestedModel: 'requested_model',
  stateHash: 'state_hash',
  latencyMs: 'latency_ms',
  requestId: 'request_id',
} as const satisfies FieldColumns;
const CONTEXT_COLUMNS = { battery: 'battery', batteryVersion: 'battery_version', pattern: 'pattern', site: 'site' } as const satisfies Record<keyof DecisionContext, Column>;
/** An answered entry's model and token usage. */
const ANSWERED_COLUMNS = { model: 'model' } as const satisfies FieldColumns;
const USAGE_COLUMNS = { inputTokens: 'input_tokens', outputTokens: 'output_tokens' } as const satisfies FieldColumns;
/** A failed entry's error. */
const ERROR_COLUMNS = { kind: 'error_kind', message: 'error_message' } as const satisfies FieldColumns;

/** Copies fields into their columns; an absent field stores null. */
function writeFields(map: FieldColumns, source: object): Partial<Row> {
  return Object.fromEntries(Object.entries(map).map(([field, column]) => [column, (source as Record<string, unknown>)[field] ?? null]));
}

/** Copies columns back into their fields, as the shape `T` those fields make up; a null column leaves its field out. */
function readFields<T extends object>(map: FieldColumns, row: Row): T {
  return presentOnly(Object.fromEntries(Object.entries(map).map(([field, column]) => [field, row[column]]))) as T;
}

const parseJson = (text: string | null): JsonValue => (text === null ? null : (JSON.parse(text) as JsonValue));

function notesOf(row: Row): DecisionNote[] {
  return NOTE_COLUMNS.flatMap((column) => {
    const text = row[column];
    return text === null ? [] : [codecFor(column).read(text)];
  });
}

function toEntry(row: Row): DecisionEntry {
  const call = {
    id: row.id as DecisionId,
    ...readFields<Pick<CallRecord, 'at' | 'requestedModel' | 'stateHash' | 'latencyMs' | 'requestId'>>(CALL_COLUMNS, row),
    context: readFields<DecisionContext>(CONTEXT_COLUMNS, row),
    questions: parseJson(row.questions),
  };
  if (row.status === 'failed') return { ...call, status: 'failed', error: readFields<FailedEntry['error']>(ERROR_COLUMNS, row) };
  return {
    ...call,
    ...readFields<Pick<AnsweredEntry, 'model'>>(ANSWERED_COLUMNS, row),
    status: 'answered',
    answers: parseJson(row.answers),
    usage: readFields<AnsweredEntry['usage']>(USAGE_COLUMNS, row),
    notes: notesOf(row),
  };
}

/** Parameter names match column names. */
type InsertParams = Pick<Row, InsertColumn>;

const INSERT = `INSERT INTO ${TABLE} (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map((column) => `$${column}`).join(', ')})`;

function toParams(id: DecisionId, entry: NewDecisionEntry): InsertParams {
  const answered = entry.status === 'answered' ? entry : undefined;
  const failed = entry.status === 'failed' ? entry : undefined;
  return {
    id,
    ...writeFields(CALL_COLUMNS, entry),
    ...writeFields(CONTEXT_COLUMNS, entry.context),
    ...writeFields(ANSWERED_COLUMNS, answered ?? {}),
    ...writeFields(USAGE_COLUMNS, answered?.usage ?? {}),
    ...writeFields(ERROR_COLUMNS, failed?.error ?? {}),
    questions: JSON.stringify(entry.questions),
    answers: answered === undefined ? null : JSON.stringify(answered.answers),
  } as InsertParams;
}

const OUTCOME_FILTER =
  `EXISTS (SELECT 1 FROM json_each(${TABLE}.readings) WHERE json_extract(json_each.value, '$.outcome') = $outcome)`;

/** The WHERE clauses and parameters for a query. */
function filterFor(query: DecisionQuery): { where: string[]; params: Params } {
  const filters: [string | undefined, string, string][] = [
    [query.battery, 'battery = $battery', 'battery'],
    [query.site, 'site = $site', 'site'],
    [query.since, 'at >= $since', 'since'],
    [query.until, 'at < $until', 'until'],
    [query.outcome, OUTCOME_FILTER, 'outcome'],
    [query.status, 'status = $status', 'status'],
  ];
  const active = filters.filter(([value]) => value !== undefined);
  return {
    where: active.map(([, clause]) => clause),
    params: Object.fromEntries(active.map(([value, , param]) => [param, value!])),
  };
}

/** A decision log in a SQLite file (or `:memory:`), created on first use. */
export class SqliteDecisionLog implements DecisionLog, Disposable {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#useSchema(path);
  }

  /** Creates the table in a new file, or refuses a file written with another schema version. */
  #useSchema(path: string): void {
    const { user_version: version } = this.#db.query('PRAGMA user_version').get() as { user_version: number };
    const existing = this.#db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $table").get({ table: TABLE }) !== null;
    if (existing && version !== SCHEMA_VERSION) {
      throw new RangeError(`decision log ${path} has schema version ${version}; this build writes version ${SCHEMA_VERSION}`);
    }
    this.#db.exec(SCHEMA);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  record(entry: NewDecisionEntry): DecisionId {
    const id = Bun.randomUUIDv7() as DecisionId;
    this.#db.query(INSERT).run(toParams(id, entry));
    return id;
  }

  attach(id: string, note: DecisionNote): void {
    const column = note.kind;
    const value = codecFor(column).write(note);
    const { changes } = this.#db.query(`UPDATE ${TABLE} SET ${column} = $value WHERE id = $id AND status = 'answered'`).run({ id, value });
    if (changes !== 1) throw new RangeError(`no answered decision ${id} to attach ${column} to`);
  }

  get(id: string): DecisionEntry | undefined {
    return this.#entries('WHERE id = $id', { id })[0];
  }

  query(query: DecisionQuery = {}): readonly DecisionEntry[] {
    const { where, params } = filterFor(query);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    return this.#entries(`${clause} ORDER BY at DESC, id DESC LIMIT $limit`, { ...params, limit: query.limit ?? 1000 });
  }

  /** The entries a SELECT over every column returns with `tail` appended. */
  #entries(tail: string, params: Params): DecisionEntry[] {
    return (this.#db.query(`SELECT * FROM ${TABLE} ${tail}`).all(params) as Row[]).map(toEntry);
  }

  [Symbol.dispose](): void {
    this.#db.close();
  }
}
