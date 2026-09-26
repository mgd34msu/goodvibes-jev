import { Database } from 'bun:sqlite';
import type { JudgmentErrorKind } from '../port/errors.ts';
import type { DecisionContext, JsonValue } from '../port/types.ts';
import type { DecisionEntry, DecisionId, DecisionLog, DecisionNote, DecisionQuery, IsoTime, NewDecisionEntry, StateHash } from './types.ts';

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
const NOTE_FROM_COLUMN: { readonly [K in NoteColumn]: (text: string) => Extract<DecisionNote, { kind: K }> } = {
  readings: (text) => ({ kind: 'readings', readings: parseJson(text) }),
  action: (text) => ({ kind: 'action', action: text }),
};
const NOTE_COLUMNS = Object.keys(NOTE_FROM_COLUMN) as NoteColumn[];
type InsertColumn = Exclude<Column, NoteColumn>;
const INSERT_COLUMNS = (Object.keys(COLUMNS) as Column[]).filter((column): column is InsertColumn => !(NOTE_COLUMNS as readonly Column[]).includes(column));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
${Object.entries(COLUMNS).map(([column, declaration]) => `  ${column} ${declaration}`).join(',\n')}
);
CREATE INDEX IF NOT EXISTS decisions_battery_at ON decisions (battery, at);
CREATE INDEX IF NOT EXISTS decisions_site_at ON decisions (site, at);
CREATE INDEX IF NOT EXISTS decisions_at ON decisions (at);
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

function contextOf(row: Row): DecisionContext {
  return presentOnly({ battery: row.battery, batteryVersion: row.battery_version, pattern: row.pattern, site: row.site });
}

const parseJson = (text: string | null): JsonValue => (text === null ? null : (JSON.parse(text) as JsonValue));

function notesOf(row: Row): DecisionNote[] {
  return NOTE_COLUMNS.flatMap((column) => {
    const text = row[column];
    return text === null ? [] : [NOTE_FROM_COLUMN[column](text)];
  });
}

function toEntry(row: Row): DecisionEntry {
  const call = {
    id: row.id as DecisionId,
    at: row.at as IsoTime,
    context: contextOf(row),
    requestedModel: row.requested_model,
    stateHash: row.state_hash as StateHash,
    questions: parseJson(row.questions),
    latencyMs: row.latency_ms,
    requestId: row.request_id ?? undefined,
  };
  if (row.status === 'failed') {
    return { ...call, status: 'failed', error: { kind: row.error_kind as JudgmentErrorKind, message: row.error_message ?? '' } };
  }
  return {
    ...call,
    status: 'answered',
    model: row.model ?? '',
    answers: parseJson(row.answers),
    usage: { inputTokens: row.input_tokens ?? 0, outputTokens: row.output_tokens ?? 0 },
    notes: notesOf(row),
  };
}

/** Parameter names match column names. */
type InsertParams = Pick<Row, InsertColumn>;

const INSERT = `INSERT INTO decisions (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map((column) => `$${column}`).join(', ')})`;

function toParams(id: DecisionId, entry: NewDecisionEntry): InsertParams {
  const answered = entry.status === 'answered' ? entry : undefined;
  const failed = entry.status === 'failed' ? entry : undefined;
  const { context } = entry;
  return {
    id,
    at: entry.at,
    status: entry.status,
    battery: context.battery ?? null,
    battery_version: context.batteryVersion ?? null,
    pattern: context.pattern ?? null,
    site: context.site ?? null,
    requested_model: entry.requestedModel,
    model: answered?.model ?? null,
    state_hash: entry.stateHash,
    questions: JSON.stringify(entry.questions),
    answers: answered === undefined ? null : JSON.stringify(answered.answers),
    latency_ms: entry.latencyMs,
    input_tokens: answered?.usage.inputTokens ?? null,
    output_tokens: answered?.usage.outputTokens ?? null,
    request_id: entry.requestId ?? null,
    error_kind: failed?.error.kind ?? null,
    error_message: failed?.error.message ?? null,
  };
}

const OUTCOME_FILTER =
  "EXISTS (SELECT 1 FROM json_each(decisions.readings) WHERE json_extract(json_each.value, '$.outcome') = $outcome)";

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
    this.#assertSchemaVersion(path);
    this.#db.exec(SCHEMA);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  #assertSchemaVersion(path: string): void {
    const { user_version: version } = this.#db.query('PRAGMA user_version').get() as { user_version: number };
    const tables = this.#db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'decisions'").get() as { n: number };
    if (tables.n > 0 && version !== SCHEMA_VERSION) {
      throw new RangeError(`decision log ${path} has schema version ${version}; this build writes version ${SCHEMA_VERSION}`);
    }
  }

  record(entry: NewDecisionEntry): DecisionId {
    const id = Bun.randomUUIDv7() as DecisionId;
    this.#db.query(INSERT).run(toParams(id, entry));
    return id;
  }

  recordReadings(id: string, readings: JsonValue): void {
    this.#update(id, 'readings', JSON.stringify(readings));
  }

  recordAction(id: string, action: string): void {
    this.#update(id, 'action', action);
  }

  #update(id: string, column: NoteColumn, value: string): void {
    const { changes } = this.#db.query(`UPDATE decisions SET ${column} = $value WHERE id = $id AND status = 'answered'`).run({ id, value });
    if (changes !== 1) throw new RangeError(`no answered decision ${id} to attach ${column} to`);
  }

  get(id: string): DecisionEntry | undefined {
    const row = this.#db.query('SELECT * FROM decisions WHERE id = $id').get({ id }) as Row | null;
    return row === null ? undefined : toEntry(row);
  }

  query(query: DecisionQuery = {}): readonly DecisionEntry[] {
    const { where, params } = filterFor(query);
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM decisions ${clause} ORDER BY at DESC, id DESC LIMIT $limit`;
    return (this.#db.query(sql).all({ ...params, limit: query.limit ?? 1000 }) as Row[]).map(toEntry);
  }

  [Symbol.dispose](): void {
    this.#db.close();
  }
}
