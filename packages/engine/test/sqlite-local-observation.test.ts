import { afterEach, expect, spyOn, test } from 'bun:test';
import { loadSqlJsEngine, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';
import { sqliteLocalObservation } from '../sdk/src/platform/state/sqlite-local-observation.js';

const databases: SqlDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function database(sql = 'CREATE TABLE evidence (value)') {
  const SQL = await loadSqlJsEngine(), db = new SQL.Database();
  databases.push(db); db.run(sql); return db;
}
async function digest(value: string) {
  const db = await database(); db.run(`INSERT INTO evidence VALUES (${value})`);
  return sqliteLocalObservation(db);
}

test('unchanged logical observations leave an active transaction and savepoint rollbackable', async () => {
  const db = await database(); db.run('BEGIN'); db.run("INSERT INTO evidence VALUES ('original')");
  db.run('SAVEPOINT retained');
  const current = sqliteLocalObservation(db);
  expect(sqliteLocalObservation(db)).toBe(current);
  db.run("UPDATE evidence SET value = 'transient'");
  expect(sqliteLocalObservation(db)).not.toBe(current);
  db.run('ROLLBACK TO retained'); db.run('RELEASE retained'); db.run('ROLLBACK');
  expect(db.exec('SELECT * FROM evidence')).toEqual([]);
});

test('DML rollback ABA changes the local observation while preserving restored rows', async () => {
  const db = await database(); db.run("INSERT INTO evidence VALUES ('original')");
  const before = sqliteLocalObservation(db);
  db.run('BEGIN'); db.run("UPDATE evidence SET value = 'transient'"); db.run('ROLLBACK');
  expect(db.exec('SELECT value FROM evidence')[0]?.values).toEqual([['original']]);
  expect(sqliteLocalObservation(db)).not.toBe(before);
});

test('logical values preserve integer precision, storage class and raw text bytes', async () => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['9007199254740992', '9007199254740993'], ['9223372036854775806', '9223372036854775807'],
    ['1', '1.0'], ['NULL', "''"], ["X'610062'", "CAST(X'610062' AS TEXT)"],
    ["CAST(X'80' AS TEXT)", "CAST(X'81' AS TEXT)"], ['9e999', '-9e999'], ['0.0', '9e999'],
  ];
  for (const [left, right] of pairs) expect(await digest(left)).not.toBe(await digest(right));
});

test('duplicate multiplicity and hidden row identities are observed', async () => {
  const one = await database(), two = await database();
  one.run("INSERT INTO evidence VALUES ('same')");
  two.run("INSERT INTO evidence VALUES ('same'), ('same')");
  expect(sqliteLocalObservation(one)).not.toBe(sqliteLocalObservation(two));
  const before = sqliteLocalObservation(one); one.run('UPDATE evidence SET rowid = 17');
  expect(sqliteLocalObservation(one)).not.toBe(before);
});

test('schema, temp, attached data and header values participate in the observation', async () => {
  const db = await database();
  for (const sql of [
    'CREATE INDEX evidence_index ON evidence(value)',
    'CREATE TEMP TABLE transient (value)', "INSERT INTO transient VALUES ('temp')",
    "ATTACH DATABASE ':memory:' AS auxiliary", 'CREATE TABLE auxiliary.extra (value)',
    "INSERT INTO auxiliary.extra VALUES ('attached')", 'PRAGMA user_version = 19', 'PRAGMA application_id = 27',
  ]) { const before = sqliteLocalObservation(db); db.run(sql); expect(sqliteLocalObservation(db)).not.toBe(before); }
});

test('schema views and triggers are observed without executing their expressions', async () => {
  const db = await database();
  db.run('CREATE VIEW forbidden AS SELECT absent_function(value) FROM evidence');
  db.run('CREATE TRIGGER forbidden_trigger AFTER INSERT ON evidence BEGIN SELECT absent_function(new.value); END');
  expect(sqliteLocalObservation(db)).toBe(sqliteLocalObservation(db));
});

test('stored generated and WITHOUT ROWID tables are readable without virtual expression evaluation', async () => {
  const db = await database('CREATE TABLE evidence (id TEXT PRIMARY KEY, value TEXT, stored TEXT GENERATED ALWAYS AS (value || value) STORED) WITHOUT ROWID');
  db.run("INSERT INTO evidence (id, value) VALUES ('a', 'b')");
  expect(sqliteLocalObservation(db)).toBe(sqliteLocalObservation(db));
});

test('unsupported virtual generated columns and inaccessible rowid fail closed', async () => {
  const generated = await database('CREATE TABLE evidence (value, computed GENERATED ALWAYS AS (value || value) VIRTUAL)');
  const shadowed = await database('CREATE TABLE evidence (rowid, _rowid_, oid)');
  expect(() => sqliteLocalObservation(generated)).toThrow('unsupported local observation shape');
  expect(() => sqliteLocalObservation(shadowed)).toThrow('unsupported local observation shape');
});

test('registered replacements for observer built-ins are rejected without invoking them', async () => {
  const db = await database(); let invoked = 0;
  (db as SqlDatabase & { create_function(name: string, callback: (...args: unknown[]) => unknown): void })
    .create_function('typeof', () => { invoked++; return 'text'; });
  expect(() => sqliteLocalObservation(db)).toThrow('unsupported local observation shape');
  expect(invoked).toBe(0);
});

// SQLite may normalize signed zero on storage. Exercise the exact REAL result
// encoding separately so normalization cannot conceal a serializer regression.
test('REAL result encoding keeps positive and negative zero distinct', async () => {
  const db = await database(); db.run('INSERT INTO evidence VALUES (0.0)');
  const exec = db.exec.bind(db); let number = 0;
  spyOn(db, 'exec').mockImplementation((sql, params, config) => {
    const result = exec(sql, params, config);
    if (sql.startsWith('SELECT typeof(') && result[0]?.values[0]) result[0].values[0][3] = number;
    return result;
  });
  const positive = sqliteLocalObservation(db); number = -0;
  expect(sqliteLocalObservation(db)).not.toBe(positive);
});

test('observations reread row data after a retained export resets counters', async () => {
  const db = await database(); db.run("INSERT INTO evidence VALUES ('original')"); db.export();
  const before = sqliteLocalObservation(db), exec = db.exec.bind(db); let metadataQueries = 0;
  spyOn(db, 'exec').mockImplementation((sql, params, config) => {
    if (sql.includes('.table_xinfo(')) metadataQueries++;
    return exec(sql, params, config);
  });
  expect(sqliteLocalObservation(db)).toBe(before);
  expect(metadataQueries).toBeGreaterThan(0);
  db.run("UPDATE evidence SET value = 'changed'"); db.export();
  expect(sqliteLocalObservation(db)).not.toBe(before);
  expect(metadataQueries).toBeGreaterThan(0);
});

test('complete schema bytes invalidate projections even when schema counters are restored', async () => {
  const db = await database(); db.run("INSERT INTO evidence VALUES ('original')"); db.export();
  const before = sqliteLocalObservation(db), version = db.exec('PRAGMA schema_version')[0]!.values[0]![0];
  db.run('ALTER TABLE evidence ADD COLUMN additional');
  db.run(`PRAGMA schema_version = ${String(version)}`); db.export();
  expect(sqliteLocalObservation(db)).not.toBe(before);
  const changedSchema = sqliteLocalObservation(db);
  db.run("UPDATE evidence SET additional = 'new stored field'"); db.export();
  expect(sqliteLocalObservation(db)).not.toBe(changedSchema);
});


test('fresh metadata preserves quoted table, column and attached-schema names', async () => {
  const db = await database();
  db.run(`ATTACH DATABASE ':memory:' AS "odd'db"`);
  db.run(`CREATE TABLE "odd'db"."strange'table" ("odd""column")`);
  db.run(`INSERT INTO "odd'db"."strange'table" VALUES ('original')`);
  const before = sqliteLocalObservation(db);
  db.run(`UPDATE "odd'db"."strange'table" SET "odd""column" = 'changed'`);
  expect(sqliteLocalObservation(db)).not.toBe(before);
});


test('uppercase and mixed-case observer function overrides are rejected without invocation', async () => {
  for (const name of ['TYPEOF', 'TyPeOf', 'TOTAL_CHANGES', 'ToTaL_ChAnGeS']) {
    const db = await database(); let invoked = 0;
    (db as SqlDatabase & { create_function(name: string, callback: (...args: unknown[]) => unknown): void })
      .create_function(name, name.toLowerCase() === 'typeof'
        ? (_value: unknown) => { invoked++; return 'text'; }
        : () => { invoked++; return 0; });
    expect(() => sqliteLocalObservation(db)).toThrow('unsupported local observation shape');
    expect(invoked).toBe(0);
  }
});

test('full fresh parsed column types detect writable_schema divergence across export and counter reset', async () => {
  const db = await database('CREATE TABLE evidence (value TEXT)');
  db.run('PRAGMA writable_schema = ON');
  db.run("UPDATE sqlite_schema SET sql = 'CREATE TABLE evidence (value BLOB)' WHERE name = 'evidence'");
  db.run('PRAGMA writable_schema = OFF');
  expect(db.exec('PRAGMA table_xinfo(evidence)')[0]!.values[0]![2]).toBe('TEXT');
  const before = sqliteLocalObservation(db);
  db.export();
  // Restore the old total_changes count without changing the raw schema bytes.
  db.run('PRAGMA writable_schema = ON');
  db.run("UPDATE sqlite_schema SET sql = sql WHERE name = 'evidence'");
  db.run('PRAGMA writable_schema = OFF');
  expect(db.exec('PRAGMA table_xinfo(evidence)')[0]!.values[0]![2]).toBe('BLOB');
  expect(sqliteLocalObservation(db)).not.toBe(before);
});
