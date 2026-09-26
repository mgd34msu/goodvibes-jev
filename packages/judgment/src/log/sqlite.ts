import type { Database, Statement } from 'bun:sqlite';
import type { JsonValue } from '../port/types.ts';
import type { DecisionEntry, DecisionId, DecisionLog, DecisionNote, DecisionQuery, NewDecisionEntry } from './types.ts';
import { COLUMNS, TABLE, openLog, rowsOf, type Params } from './sqlite-schema.ts';

/** What reading an entry back needs from its row. */
interface Row {
  readonly id: string;
  readonly entry: string;
  readonly readings: string | null;
  readonly action: string | null;
}

/** Each note kind is stored, as text, in the column of the same name. */
type NoteColumn = DecisionNote['kind'];
/** How a note of one kind is written to its column and read back. */
interface NoteCodec<N extends DecisionNote> {
  write(note: N): string;
  read(text: string): N;
}
const NOTE_CODECS: { readonly [K in NoteColumn]: NoteCodec<Extract<DecisionNote, { kind: K }>> } = {
  readings: { write: (note) => JSON.stringify(note.readings), read: (text) => ({ kind: 'readings', readings: JSON.parse(text) as JsonValue }) },
  action: { write: (note) => note.action, read: (text) => ({ kind: 'action', action: text }) },
};
const NOTE_COLUMNS = Object.keys(NOTE_CODECS) as NoteColumn[];
/** A new row stores its id and the entry; SQLite derives the rest, and notes attach later. */
const INSERT_COLUMNS = ['id', 'entry'] as const satisfies readonly (keyof typeof COLUMNS)[];
type InsertParams = Readonly<Record<(typeof INSERT_COLUMNS)[number], string>>;
const codecFor = (column: NoteColumn): NoteCodec<DecisionNote> => NOTE_CODECS[column] as NoteCodec<DecisionNote>;

const toParams = (id: DecisionId, entry: NewDecisionEntry): InsertParams => ({ id, entry: JSON.stringify(entry) });

function toEntry(row: Row): DecisionEntry {
  const entry = { ...(JSON.parse(row.entry) as NewDecisionEntry), id: row.id as DecisionId };
  if (entry.status === 'failed') return entry;
  const notes = NOTE_COLUMNS.flatMap((column) => {
    const text = row[column];
    return text === null ? [] : [codecFor(column).read(text)];
  });
  return { ...entry, notes };
}

/** Every value is bound under its column's name. */
const param = (column: keyof typeof COLUMNS): string => `$${column}`;
const equals = (column: keyof typeof COLUMNS): string => `${column} = ${param(column)}`;
const ID_IS = equals('id');
/** Every statement the log runs. */
const SQL = {
  insert: `INSERT INTO ${TABLE} (${INSERT_COLUMNS.join(', ')}) VALUES (${INSERT_COLUMNS.map(param).join(', ')})`,
  attach: (column: NoteColumn) => `UPDATE ${TABLE} SET ${equals(column)} WHERE ${ID_IS} AND status = 'answered'`,
  /** Newest first, up to $limit, meeting every condition given. */
  matching: (conditions: readonly string[]) =>
    `SELECT * FROM ${TABLE} WHERE ${['TRUE', ...conditions].join(' AND ')} ORDER BY at DESC, id DESC LIMIT $limit`,
};

const OUTCOME_FILTER =
  `EXISTS (SELECT 1 FROM json_each(${TABLE}.readings) WHERE json_extract(json_each.value, '$.outcome') = $outcome)`;

/** The condition each query filter puts on a row; the filter's value is bound under the filter's own name. */
const FILTERS: Readonly<Record<Exclude<keyof DecisionQuery, 'limit'>, string>> = {
  battery: equals('battery'),
  site: equals('site'),
  since: 'at >= $since',
  until: 'at < $until',
  outcome: OUTCOME_FILTER,
  status: equals('status'),
};

/** The WHERE clauses and parameters for a query. */
function filterFor(query: DecisionQuery): { where: string[]; params: Params } {
  const active = (Object.keys(FILTERS) as (keyof typeof FILTERS)[]).flatMap((name) => {
    const value = query[name];
    return value === undefined ? [] : [{ name, value }];
  });
  return { where: active.map(({ name }) => FILTERS[name]), params: Object.fromEntries(active.map(({ name, value }) => [name, value])) };
}

/** A decision log in a SQLite file (or `:memory:`), created on first use. */
export class SqliteDecisionLog implements DecisionLog, Disposable {
  readonly #db: Database;
  /** The writing statements, prepared once. */
  readonly #insert: Statement;
  readonly #attach: Readonly<Record<NoteColumn, Statement>>;

  constructor(path: string) {
    this.#db = openLog(path);
    this.#insert = this.#db.prepare(SQL.insert);
    this.#attach = Object.fromEntries(NOTE_COLUMNS.map((column) => [column, this.#db.prepare(SQL.attach(column))])) as Record<NoteColumn, Statement>;
  }

  record(entry: NewDecisionEntry): DecisionId {
    const id = Bun.randomUUIDv7() as DecisionId;
    this.#insert.run(toParams(id, entry));
    return id;
  }

  attach(id: string, note: DecisionNote): void {
    const column = note.kind;
    const { changes } = this.#attach[column].run({ id, [column]: codecFor(column).write(note) });
    if (changes !== 1) throw new RangeError(`decision ${id} cannot take a ${column} note`);
  }

  get(id: string): DecisionEntry | undefined {
    return this.#entries(SQL.matching([ID_IS]), { id, limit: 1 })[0];
  }

  query(query: DecisionQuery = {}): readonly DecisionEntry[] {
    const { where, params } = filterFor(query);
    return this.#entries(SQL.matching(where), { ...params, limit: query.limit ?? 1000 });
  }

  #entries(sql: string, params: Params): DecisionEntry[] {
    return rowsOf<Row>(this.#db, sql, params).map(toEntry);
  }

  [Symbol.dispose](): void {
    this.#db.close();
  }
}
