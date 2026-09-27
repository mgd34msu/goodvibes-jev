import { createRequire } from 'node:module';
import type { Database } from 'bun:sqlite';

/**
 * bun:sqlite is a Bun-only builtin, and a static import of it makes the whole
 * package root unloadable under Node, whose ESM loader rejects the `bun:`
 * scheme at link time. Engine code that runs under Node imports this root for
 * batteries and patterns, so the constructor is resolved only when a log is
 * opened, which stays a Bun-only path.
 */
let databaseCtor: typeof Database | null = null;
function bunDatabase(): typeof Database {
  return (databaseCtor ??= (createRequire(import.meta.url)('bun:sqlite') as typeof import('bun:sqlite')).Database);
}

/*
 * The decision log's storage layout: its one table, the columns, and opening
 * a log file with the schema this build writes.
 */

/** The one table the log keeps. */
export const TABLE = 'decisions';

/** Bumped whenever the table shape changes; an older file is refused rather than misread. */
const SCHEMA_VERSION = 2;

/**
 * What a column holds. Every column is text: the row's key, a value the log
 * writes (always, or only once a note attaches), or a field SQLite derives
 * from the stored entry so queries can filter and index on it.
 */
type ColumnRole =
  | { readonly kind: 'key' }
  | { readonly kind: 'written'; readonly always: boolean }
  | { readonly kind: 'derived'; readonly entryField: readonly string[] };

const KEY: ColumnRole = { kind: 'key' };
const written = (always: boolean): ColumnRole => ({ kind: 'written', always });
const derived = (...entryField: string[]): ColumnRole => ({ kind: 'derived', entryField });

/** How each role is declared in CREATE TABLE. */
function declaration(role: ColumnRole): string {
  if (role.kind === 'key') return 'TEXT PRIMARY KEY';
  if (role.kind === 'written') return role.always ? 'TEXT NOT NULL' : 'TEXT';
  return `TEXT GENERATED ALWAYS AS (json_extract(entry, '$.${role.entryField.join('.')}')) VIRTUAL`;
}

/** Each row holds the whole entry as JSON; the fields queries filter on are derived from it, and notes attach in columns named for their kind. */
export const COLUMNS = {
  id: KEY,
  entry: written(true),
  at: derived('at'),
  status: derived('status'),
  battery: derived('context', 'battery'),
  site: derived('context', 'site'),
  readings: written(false),
  action: written(false),
} as const satisfies Readonly<Record<string, ColumnRole>>;

const SCHEMA = `
CREATE TABLE ${TABLE} (
${Object.entries(COLUMNS).map(([column, role]) => `  ${column} ${declaration(role)}`).join(',\n')}
);
CREATE INDEX ${TABLE}_battery_at ON ${TABLE} (battery, at);
CREATE INDEX ${TABLE}_site_at ON ${TABLE} (site, at);
CREATE INDEX ${TABLE}_at ON ${TABLE} (at);
`;

/** A value bound into a statement. */
type SqlValue = string | number | null;
/** Statement parameters by name. */
export type Params = Readonly<Record<string, SqlValue>>;

/** Every row one statement yields. */
export const rowsOf = <T>(db: Database, sql: string, params: Params = {}): T[] => db.query(sql).all(params) as T[];

/** Opens the log file. A file with no tables yet is new and gets the schema; any other file must carry this schema version. */
export function openLog(path: string): Database {
  const Ctor = bunDatabase();
  const db = new Ctor(path, { create: true, strict: true });
  db.exec('PRAGMA journal_mode = WAL;');
  if (rowsOf(db, 'SELECT 1 FROM sqlite_master').length === 0) {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    return db;
  }
  const [{ user_version: version }] = rowsOf<{ user_version: number }>(db, 'PRAGMA user_version') as [{ user_version: number }];
  if (version === SCHEMA_VERSION) return db;
  db.close();
  throw new RangeError(`decision log ${path} has schema version ${version}; this build writes version ${SCHEMA_VERSION}`);
}
