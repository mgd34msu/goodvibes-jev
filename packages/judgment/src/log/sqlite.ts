import { Database } from 'bun:sqlite';
import type { JsonValue } from '../port/types.ts';
import type { DecisionEntry, DecisionLog, DecisionQuery, NewDecisionEntry } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
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

const parse = (text: string | null): JsonValue | undefined => (text === null ? undefined : (JSON.parse(text) as JsonValue));

function toEntry(row: Row): DecisionEntry {
  return {
    id: row.id,
    at: row.at,
    context: {
      ...(row.battery === null ? {} : { battery: row.battery }),
      ...(row.battery_version === null ? {} : { batteryVersion: row.battery_version }),
      ...(row.pattern === null ? {} : { pattern: row.pattern }),
      ...(row.site === null ? {} : { site: row.site }),
    },
    requestedModel: row.requested_model,
    model: row.model ?? undefined,
    stateHash: row.state_hash,
    questions: JSON.parse(row.questions) as JsonValue,
    answers: parse(row.answers),
    readings: parse(row.readings),
    action: row.action ?? undefined,
    latencyMs: row.latency_ms,
    usage:
      row.input_tokens === null || row.output_tokens === null
        ? undefined
        : { inputTokens: row.input_tokens, outputTokens: row.output_tokens },
    requestId: row.request_id ?? undefined,
    error:
      row.error_kind === null
        ? undefined
        : { kind: row.error_kind as NonNullable<DecisionEntry['error']>['kind'], message: row.error_message ?? '' },
  };
}

/** A decision log in a SQLite file (or `:memory:`), created on first use. */
export class SqliteDecisionLog implements DecisionLog, Disposable {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.#db.exec(SCHEMA);
  }

  record(entry: NewDecisionEntry): string {
    const id = Bun.randomUUIDv7();
    this.#db
      .query(
        `INSERT INTO decisions (id, at, battery, battery_version, pattern, site, requested_model, model, state_hash,
           questions, answers, latency_ms, input_tokens, output_tokens, request_id, error_kind, error_message)
         VALUES ($id, $at, $battery, $batteryVersion, $pattern, $site, $requestedModel, $model, $stateHash,
           $questions, $answers, $latencyMs, $inputTokens, $outputTokens, $requestId, $errorKind, $errorMessage)`,
      )
      .run({
        id,
        at: entry.at,
        battery: entry.context.battery ?? null,
        batteryVersion: entry.context.batteryVersion ?? null,
        pattern: entry.context.pattern ?? null,
        site: entry.context.site ?? null,
        requestedModel: entry.requestedModel,
        model: entry.model ?? null,
        stateHash: entry.stateHash,
        questions: JSON.stringify(entry.questions),
        answers: entry.answers === undefined ? null : JSON.stringify(entry.answers),
        latencyMs: entry.latencyMs,
        inputTokens: entry.usage?.inputTokens ?? null,
        outputTokens: entry.usage?.outputTokens ?? null,
        requestId: entry.requestId ?? null,
        errorKind: entry.error?.kind ?? null,
        errorMessage: entry.error?.message ?? null,
      });
    return id;
  }

  recordReadings(id: string, readings: JsonValue): void {
    this.#update(id, 'readings', JSON.stringify(readings));
  }

  recordAction(id: string, action: string): void {
    this.#update(id, 'action', action);
  }

  #update(id: string, column: 'readings' | 'action', value: string): void {
    const { changes } = this.#db.query(`UPDATE decisions SET ${column} = $value WHERE id = $id`).run({ id, value });
    if (changes !== 1) throw new RangeError(`no decision ${id} to attach ${column} to`);
  }

  get(id: string): DecisionEntry | undefined {
    const row = this.#db.query('SELECT * FROM decisions WHERE id = $id').get({ id }) as Row | null;
    return row === null ? undefined : toEntry(row);
  }

  query(query: DecisionQuery = {}): readonly DecisionEntry[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    if (query.battery !== undefined) {
      where.push('battery = $battery');
      params['battery'] = query.battery;
    }
    if (query.site !== undefined) {
      where.push('site = $site');
      params['site'] = query.site;
    }
    if (query.since !== undefined) {
      where.push('at >= $since');
      params['since'] = query.since;
    }
    if (query.until !== undefined) {
      where.push('at < $until');
      params['until'] = query.until;
    }
    if (query.outcome !== undefined) {
      where.push(
        "EXISTS (SELECT 1 FROM json_each(decisions.readings) WHERE json_extract(json_each.value, '$.outcome') = $outcome)",
      );
      params['outcome'] = query.outcome;
    }
    if (query.failed !== undefined) where.push(query.failed ? 'error_kind IS NOT NULL' : 'error_kind IS NULL');
    params['limit'] = query.limit ?? 1000;
    const sql = `SELECT * FROM decisions ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $limit`;
    return (this.#db.query(sql).all(params) as Row[]).map(toEntry);
  }

  [Symbol.dispose](): void {
    this.#db.close();
  }

  close(): void {
    this.#db.close();
  }
}
