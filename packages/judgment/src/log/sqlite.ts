import { Database } from 'bun:sqlite';
import type { JudgmentErrorKind } from '../port/errors.ts';
import type { DecisionContext, JsonValue } from '../port/types.ts';
import type { DecisionEntry, DecisionId, DecisionLog, DecisionQuery, IsoTime, NewDecisionEntry, StateHash } from './types.ts';

/** Bumped whenever the table shape changes; an older file is refused rather than misread. */
const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  status TEXT NOT NULL,
  battery TEXT,
  battery_version INTEGER,
  pattern TEXT,
  site TEXT,
  requested_model TEXT NOT NULL,
  model TEXT,
  state_hash TEXT NOT NULL,
  questions TEXT NOT NULL,
  answers TEXT,
  readings TEXT,
  action TEXT,
  latency_ms REAL NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  request_id TEXT,
  error_kind TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS decisions_battery_at ON decisions (battery, at);
CREATE INDEX IF NOT EXISTS decisions_site_at ON decisions (site, at);
CREATE INDEX IF NOT EXISTS decisions_at ON decisions (at);
`;

interface Row {
  id: string;
  at: string;
  status: DecisionEntry['status'];
  battery: string | null;
  battery_version: number | null;
  pattern: string | null;
  site: string | null;
  requested_model: string;
  model: string | null;
  state_hash: string;
  questions: string;
  answers: string | null;
  readings: string | null;
  action: string | null;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  request_id: string | null;
  error_kind: string | null;
  error_message: string | null;
}

type Params = Record<string, string | number | null>;

/** The same record without its null entries. */
function presentOnly<T extends Record<string, unknown>>(record: T): { [K in keyof T]?: NonNullable<T[K]> } {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null)) as { [K in keyof T]?: NonNullable<T[K]> };
}

function contextOf(row: Row): DecisionContext {
  return presentOnly({ battery: row.battery, batteryVersion: row.battery_version, pattern: row.pattern, site: row.site });
}

const parseJson = (text: string | null): JsonValue | null => (text === null ? null : (JSON.parse(text) as JsonValue));

function toEntry(row: Row): DecisionEntry {
  const call = {
    id: row.id as DecisionId,
    at: row.at as IsoTime,
    context: contextOf(row),
    requestedModel: row.requested_model,
    stateHash: row.state_hash as StateHash,
    questions: JSON.parse(row.questions) as JsonValue,
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
    readings: parseJson(row.readings),
    action: row.action,
  };
}

function toParams(id: DecisionId, entry: NewDecisionEntry): Params {
  const answered = entry.status === 'answered' ? entry : undefined;
  const failed = entry.status === 'failed' ? entry : undefined;
  return {
    id,
    at: entry.at,
    status: entry.status,
    battery: entry.context.battery ?? null,
    batteryVersion: entry.context.batteryVersion ?? null,
    pattern: entry.context.pattern ?? null,
    site: entry.context.site ?? null,
    requestedModel: entry.requestedModel,
    model: answered?.model ?? null,
    stateHash: entry.stateHash,
    questions: JSON.stringify(entry.questions),
    answers: answered === undefined ? null : JSON.stringify(answered.answers),
    latencyMs: entry.latencyMs,
    inputTokens: answered?.usage.inputTokens ?? null,
    outputTokens: answered?.usage.outputTokens ?? null,
    requestId: entry.requestId ?? null,
    errorKind: failed?.error.kind ?? null,
    errorMessage: failed?.error.message ?? null,
  };
}

const INSERT = `INSERT INTO decisions (id, at, status, battery, battery_version, pattern, site, requested_model, model, state_hash,
  questions, answers, latency_ms, input_tokens, output_tokens, request_id, error_kind, error_message)
  VALUES ($id, $at, $status, $battery, $batteryVersion, $pattern, $site, $requestedModel, $model, $stateHash,
  $questions, $answers, $latencyMs, $inputTokens, $outputTokens, $requestId, $errorKind, $errorMessage)`;

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

  #update(id: string, column: 'readings' | 'action', value: string): void {
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
