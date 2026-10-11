import { afterEach, expect, test } from 'bun:test';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { validateCurrentKnowledgeSchema } from '../sdk/src/platform/knowledge/store-current-schema-validation.js';
import { createEmptyWorkLedgerState } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { validateNativeKnowledgeReadSchema } from '../sdk/src/platform/state/knowledge-schema-read-plan.js';
import { loadSqlJsEngine, type SqlDatabase } from '../sdk/src/platform/state/sqlite-store.js';

const databases: SqlDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

async function database() {
  const SQL = await loadSqlJsEngine();
  const db = new SQL.Database();
  databases.push(db);
  createSchema(db);
  return db;
}

function observe(db: SqlDatabase) {
  const queries: string[] = [];
  const reader: Pick<SqlDatabase, 'exec'> = {
    exec(sql, params, config) {
      queries.push(sql);
      return db.exec(sql, params, config);
    },
  };
  return { reader, queries };
}

test('native packets preserve the full validator and all original statements with six exec entries', async () => {
  const db = await database();
  const before = Buffer.from(db.export());
  expect(() => validateCurrentKnowledgeSchema(db)).not.toThrow();
  const { reader, queries } = observe(db);
  expect(validateNativeKnowledgeReadSchema(reader)).toBe(true);
  expect(queries).toHaveLength(6);
  const statements = queries.flatMap(query => query.split(';'));
  expect(statements).toHaveLength(18);
  expect(statements.filter(query => query.startsWith('PRAGMA table_info('))).toHaveLength(7);
  expect(statements.filter(query => query.startsWith('PRAGMA index_list('))).toHaveLength(2);
  expect(statements.filter(query => query.startsWith('PRAGMA index_info('))).toHaveLength(2);
  expect(statements.filter(query => query.startsWith('SELECT 1 FROM '))).toEqual([
    'SELECT 1 FROM work_ledgers LIMIT 1',
    'SELECT 1 FROM native_work_executions LIMIT 1',
    'SELECT 1 FROM native_work_execution_intents LIMIT 1',
    'SELECT 1 FROM native_conversation_captures LIMIT 1',
    'SELECT 1 FROM native_work_execution_settlements LIMIT 1',
    'SELECT 1 FROM native_ci_continuations LIMIT 1',
  ]);
  expect(Buffer.from(db.export())).toEqual(before);
});

test.each(['work_ledgers', 'native_conversation_captures', 'knowledge_edge_changes'] as const)(
  'a missing first, middle, or last layout (%s) refuses before shifted attribution', async table => {
    const db = await database();
    db.run(`DROP TABLE ${table}`);
    const { reader, queries } = observe(db);
    expect(validateNativeKnowledgeReadSchema(reader)).toBe(false);
    expect(queries).toHaveLength(1);
    expect(db.exec(queries[0]!)).toHaveLength(6);
    expect(() => validateCurrentKnowledgeSchema(db)).toThrow();
  },
);

test('the actual adapter omits empty index results rather than leaving positional placeholders', async () => {
  const db = await database();
  db.run('CREATE TABLE no_indexes(value TEXT)');
  const firstMissing = db.exec('PRAGMA index_list(no_indexes);PRAGMA index_list(native_work_executions)');
  const lastMissing = db.exec('PRAGMA index_list(native_work_executions);PRAGMA index_list(no_indexes)');
  expect(firstMissing).toHaveLength(1);
  expect(lastMissing).toEqual(firstMissing);
  expect(firstMissing[0]?.columns).toContain('unique');
  expect(db.exec('SELECT 1 WHERE 0;SELECT 2 AS surviving')).toEqual([{ columns: ['surviving'], values: [[2]] }]);
});

test.each(['type', 'missing-column', 'extra-column', 'nullable', 'primary-key'] as const)(
  'a malformed native layout (%s) remains refused by both validators', async mode => {
    const db = await database();
    db.run('DROP TABLE work_ledgers');
    db.run(`CREATE TABLE work_ledgers(project_id ${mode === 'type' ? 'INTEGER' : 'TEXT'} ${mode === 'nullable' ? '' : 'NOT NULL'}
      ${mode === 'primary-key' ? '' : 'PRIMARY KEY'},format_version INTEGER NOT NULL,revision INTEGER NOT NULL
      ${mode === 'missing-column' ? '' : ',state_json TEXT NOT NULL'}${mode === 'extra-column' ? ',extra_meaning TEXT' : ''})`);
    expect(validateNativeKnowledgeReadSchema(db)).toBe(false);
    expect(() => validateCurrentKnowledgeSchema(db)).toThrow();
  },
);

test.each(['missing', 'reversed', 'partial', 'nonunique'] as const)(
  'a missing or invalid execution attempt index (%s) cannot authorize the native plan', async mode => {
    const db = await database();
    db.run('DROP TABLE native_work_executions');
    db.run(`CREATE TABLE native_work_executions(project_id TEXT NOT NULL,key_hash TEXT NOT NULL,
      format_version INTEGER NOT NULL,state_json TEXT NOT NULL,attempt_id TEXT NOT NULL,PRIMARY KEY(project_id,key_hash)
      ${mode === 'reversed' ? ',UNIQUE(attempt_id,project_id)' : ''})`);
    if (mode === 'partial') db.run("CREATE UNIQUE INDEX partial_attempt ON native_work_executions(project_id,attempt_id) WHERE attempt_id <> ''");
    if (mode === 'nonunique') db.run('CREATE INDEX ordinary_attempt ON native_work_executions(project_id,attempt_id)');
    expect(validateNativeKnowledgeReadSchema(db)).toBe(false);
    expect(() => validateCurrentKnowledgeSchema(db)).toThrow();
  },
);

test('a missing conversation request index is refused after the execution index settles', async () => {
  const db = await database();
  db.run('DROP TABLE native_conversation_captures');
  db.run(`CREATE TABLE native_conversation_captures(project_id TEXT NOT NULL,principal_id TEXT NOT NULL,
    input_id TEXT NOT NULL,request_id TEXT NOT NULL,format_version INTEGER NOT NULL,state_json TEXT NOT NULL,
    PRIMARY KEY(project_id,principal_id,input_id))`);
  expect(validateNativeKnowledgeReadSchema(db)).toBe(false);
  expect(() => validateCurrentKnowledgeSchema(db)).toThrow();
});

test('an earlier unrelated unique index cannot hide the original required index', async () => {
  const db = await database();
  db.run('CREATE UNIQUE INDEX unrelated_attempt ON native_work_executions(attempt_id,project_id)');
  expect(validateNativeKnowledgeReadSchema(db)).toBe(true);
  expect(() => validateCurrentKnowledgeSchema(db)).not.toThrow();
});

test.each(['missing', 'changed'] as const)('a %s edge trigger still requires the full validator', async mode => {
  const db = await database();
  db.run('DROP TRIGGER knowledge_edge_change_insert');
  if (mode === 'changed') db.run('CREATE TRIGGER knowledge_edge_change_insert AFTER INSERT ON knowledge_edges BEGIN SELECT 1; END');
  expect(validateNativeKnowledgeReadSchema(db)).toBe(false);
  expect(() => validateCurrentKnowledgeSchema(db)).toThrow();
});

const populatedCases = [
  // These two schema validators defer row parsing to their typed consumers.
  ['work_ledgers', "INSERT INTO work_ledgers VALUES('synthetic',2,0,'{}')", false],
  ['native_work_executions', "INSERT INTO native_work_executions VALUES('synthetic','key',1,'{}','attempt')", false],
  ['native_work_execution_intents', "INSERT INTO native_work_execution_intents VALUES('synthetic','attempt',1,'{}')", true],
  ['native_conversation_captures', "INSERT INTO native_conversation_captures VALUES('synthetic','principal','input','request',1,'{}')", true],
  ['native_work_execution_settlements', "INSERT INTO native_work_execution_settlements VALUES('synthetic','key',1,'{}')", true],
  ['native_ci_continuations', "INSERT INTO native_ci_continuations VALUES('synthetic','continuation',1,'{}')", true],
] as const;
test.each(populatedCases)('a nonempty %s always refuses the empty-authority plan', async (_table, insert, rejectsMalformedRow) => {
  const db = await database();
  db.run(insert);
  const { reader, queries } = observe(db);
  expect(validateNativeKnowledgeReadSchema(reader)).toBe(false);
  const packet = queries.at(-1);
  if (!packet) throw new Error('No native authority packet');
  expect(packet.split(';')).toHaveLength(6);
  expect(db.exec(packet)).toEqual([{ columns: ['1'], values: [[1]] }]);
  if (rejectsMalformedRow) expect(() => validateCurrentKnowledgeSchema(db)).toThrow();
  else expect(() => validateCurrentKnowledgeSchema(db)).not.toThrow();
});

test('valid populated authority remains the full validator responsibility and is reread after mutation', async () => {
  const db = await database();
  expect(validateNativeKnowledgeReadSchema(db)).toBe(true);
  const ledger = createEmptyWorkLedgerState('synthetic');
  db.run('INSERT INTO work_ledgers VALUES(?,?,?,?)', [ledger.projectId, ledger.version, ledger.revision, JSON.stringify(ledger)]);
  expect(validateNativeKnowledgeReadSchema(db)).toBe(false);
  expect(() => validateCurrentKnowledgeSchema(db)).not.toThrow();
  db.run("DELETE FROM work_ledgers WHERE project_id='synthetic'");
  expect(validateNativeKnowledgeReadSchema(db)).toBe(true);
});
