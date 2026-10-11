import { createHash } from 'node:crypto';
import type { SqlDatabase } from './sqlite-store.js';

interface ObservationTable { readonly label: string; readonly sql: string; readonly columns: string; }

/** A live sql.js export closes/reopens the connection, ending transactions.
 * Observe only stored logical state instead. This deliberately fails closed for
 * shapes whose complete contents cannot be read without executing user code. */
export function sqliteLocalObservation(db: SqlDatabase, mode: 'observation' | 'clean-content' = 'observation'): string {
  const unsupported = (): never => { throw new Error('SQLiteStore: unsupported local observation shape'); };
  const bytes = (input: Uint8Array): Buffer => Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const real = Buffer.allocUnsafe(8);
  const query = (sql: string): unknown[][] => db.exec(sql, undefined, { useBigInt: true })[0]?.values ?? [];
  const quote = (name: unknown): string => {
    if (typeof name !== 'string' || (name.includes('\0') || name.includes('\ufffd')) || Buffer.from(name).toString('utf8') !== name) return unsupported();
    return `"${name.replaceAll('"', '""')}"`;
  };
  // JSON frames already-typed strings only. No SQLite value passes through
  // JSON's lossy Number/NaN/-0 conversion. Text payloads below arrive as blobs.
  const value = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'bigint') return `integer:${input}`;
    if (typeof input === 'number') {
      real.writeDoubleBE(input); return `real:${real.toString('hex')}`;
    }
    if (typeof input === 'string') return `text:${Buffer.from(input).toString('hex')}`;
    if (input instanceof Uint8Array) return `blob:${bytes(input).toString('hex')}`;
    return unsupported();
  };
  const rows = (input: unknown[][]): string[] => input.map(row => JSON.stringify(row.map(value))).sort();
  const hash = createHash('sha256');
  const include = (label: string, input: unknown[][]): void => { hash.update(JSON.stringify([label, rows(input)])); };
  const databases = query('PRAGMA database_list');
  include('databases', databases);
  // Inspect every schema before any table metadata/data query: even asking a
  // virtual table for metadata can connect its module. rootpage=0 table entries
  // identify virtual tables; views/triggers are observed as schema bytes only.
  const schemas = databases.map(database => {
    const name = database[1], schema = quote(name);
    const rawEntries = query(`SELECT CAST(type AS BLOB), CAST(name AS BLOB), CAST(tbl_name AS BLOB), rootpage, CAST(sql AS BLOB) FROM ${schema}.sqlite_schema`);
    const encoded = JSON.stringify([String(name), rows(rawEntries)]);
    hash.update(encoded);
    for (const pragma of ['schema_version', 'user_version', 'application_id', 'encoding']) {
      include(`${String(name)}:${pragma}`, query(`PRAGMA ${schema}.${pragma}`));
    }
    return { name: String(name), schema, rawEntries };
  });
  // Fresh column metadata is necessary even when raw sqlite_schema bytes match:
  // writable_schema can leave SQLite's parsed schema different until reopen.
  // Never cache a projection on schema cookies or raw schema bytes alone.
  const tables: ObservationTable[] = [];
  const decodedSchemas = schemas.map(({ name, schema, rawEntries }) => ({ name, schema, entries: rawEntries.map(raw => {
    const entry = [...raw];
    for (const field of [0, 1, 2, 4]) {
      if (raw[field] === null) continue;
      if (!(raw[field] instanceof Uint8Array)) unsupported();
      const rawBytes = bytes(raw[field] as Uint8Array), text = rawBytes.toString('utf8');
      if (!Buffer.from(text).equals(rawBytes)) unsupported();
      entry[field] = text;
    }
    quote(entry[0]); quote(entry[1]); quote(entry[2]);
    if (entry[0] === 'table' && (typeof entry[3] !== 'bigint' || entry[3] <= 0n)) unsupported();
    return entry;
  }) }));
  // Retained sql.js handles can register replacements for built-in functions.
  // Do not invoke an overridden typeof/total_changes during observation.
  const functions = query('PRAGMA function_list');
  if (functions.length === 0 || functions.some(row => row[1] === 0n
    && ['typeof', 'total_changes'].includes(String(row[0]).toLowerCase()))) unsupported();
  // Clean/dirty comparison concerns stored content: rolled-back DML must not
  // become a pending write solely because total_changes cannot roll back.
  if (mode === 'observation') include('changes', query('SELECT total_changes()'));
  for (const { name, schema, entries } of decodedSchemas) {
    const metadataRows = query(`PRAGMA ${schema}.table_list`);
    for (const entry of entries.filter(entry => entry[0] === 'table').sort((a, b) => String(a[1]) < String(b[1]) ? -1 : String(a[1]) > String(b[1]) ? 1 : 0)) {
      const table = quote(entry[1]);
      const metadata = metadataRows.find(row => row[0] === name && row[1] === entry[1]);
      if (!metadata) return unsupported();
      if (metadata[2] !== 'table' || (metadata[4] !== 0n && metadata[4] !== 1n)) unsupported();
      const columns = query(`PRAGMA ${schema}.table_xinfo(${table})`);
      if (columns.length === 0 || columns.some(column => column[6] !== 0n && column[6] !== 3n)) unsupported();
      const selected = columns.map(column => quote(column[1]));
      if (metadata[4] === 0n) {
        const names = new Set(columns.map(column => String(column[1]).toLowerCase()));
        const rowid = ['_rowid_', 'rowid', 'oid'].find(alias => !names.has(alias));
        if (!rowid) unsupported();
        selected.unshift(quote(rowid));
      }
      // NOT INDEXED and no ORDER BY keep caller collations/expressions out of
      // observation. Text payloads retain their exact SQLite bytes.
      const projection = selected.flatMap(column => [
        `typeof(${column})`, `CASE WHEN typeof(${column}) = 'text' THEN CAST(${column} AS BLOB) ELSE ${column} END`,
      ]);
      projection[0] += ` AS "__observation_${tables.length}"`;
      tables.push({ label: JSON.stringify([name, entry[1]]), columns: JSON.stringify(rows(columns)),
        sql: `SELECT ${projection.join(', ')} FROM ${schema}.${table} NOT INDEXED` });
    }
  }
  // One sql.js invocation prepares/steps each complete table query. Empty
  // tables have no result set in sql.js and are included explicitly below.
  const results = tables.length ? db.exec(tables.map(table => table.sql).join(';'), undefined, { useBigInt: true }) : [];
  const contents = new Map<string, unknown[][]>();
  for (const result of results) contents.set(result.columns[0]!, result.values);
  for (const [index, table] of tables.entries()) {
    hash.update(JSON.stringify([table.label, table.columns]));
    const encoded = (contents.get(`__observation_${index}`) ?? []).map(row => {
      const cells: string[] = [];
      for (let column = 0; column < row.length; column += 2) {
        const type = row[column], input = row[column + 1];
        if (type === 'integer' && typeof input === 'bigint') cells.push(`i:${input}`);
        else if (type === 'real' && typeof input === 'number') {
          real.writeDoubleBE(input); cells.push(`r:${real.toString('hex')}`);
        } else if ((type === 'text' || type === 'blob') && input instanceof Uint8Array) {
          cells.push(`${type === 'text' ? 't' : 'b'}:${bytes(input).toString('hex')}`);
        } else if (type === 'null' && input === null) cells.push('n');
        else unsupported();
      }
      return JSON.stringify(cells);
    }).sort();
    hash.update(JSON.stringify(encoded));
  }
  return hash.digest('hex');
}
