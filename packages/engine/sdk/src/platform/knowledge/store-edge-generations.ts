import { knowledgeSchemaColumns, knowledgeEdgeChangeTriggers as triggers } from './store-schema-validation-data.js';
import type { SqlDatabase } from '../state/sqlite-store.js';
import { createHash } from 'node:crypto';

/** Content fingerprints cannot distinguish a persisted replacement and restore.
 * Keep actual endpoint changes so fixed read windows also retain absence. */
export function createKnowledgeEdgeChanges(db: Pick<SqlDatabase, 'run'>): void {
  db.run(`CREATE TABLE IF NOT EXISTS knowledge_edge_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    edge_id TEXT NOT NULL,
    from_kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_kind TEXT NOT NULL,
    to_id TEXT NOT NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_knowledge_edge_changes_endpoints ON knowledge_edge_changes(from_kind,from_id,to_kind,to_id,sequence)');
  for (const [, sql] of triggers) db.run(sql);
  // Establish original rows once for a legacy database. This creates no edge.
  db.run(`INSERT INTO knowledge_edge_changes(edge_id,from_kind,from_id,to_kind,to_id)
    SELECT id,from_kind,from_id,to_kind,to_id FROM knowledge_edges
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_edge_changes)`);
}

export function validateKnowledgeEdgeChanges(db: Pick<SqlDatabase, 'exec'>): void {
  const columns = db.exec('PRAGMA table_info(knowledge_edge_changes)')[0]?.values;
  const expected = knowledgeSchemaColumns.edgeChange;
  if (!columns || columns.length !== expected.length || expected.some(([name, type, required, primary]) => {
    const row = columns.find(value => value[1] === name);
    return !row || row[2] !== type || row[3] !== required || row[5] !== primary;
  })) throw new Error('Invalid knowledge edge change table');
  const installed = db.exec("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='knowledge_edges'")[0]?.values ?? [];
  for (const [name, sql] of triggers) {
    const actual = installed.find(row => row[0] === name)?.[1];
    if (actual !== sql.replace('IF NOT EXISTS ', '')) throw new Error('Invalid knowledge edge change trigger');
  }
}

export interface KnowledgeEdgeChangeSnapshot {
  readonly generation: string;
  readonly fromKind: string;
  readonly fromId: string;
  readonly toKind: string;
  readonly toId: string;
}

export interface KnowledgeEdgeGenerationSnapshot {
  readonly id: string;
  readonly fromKind: string;
  readonly fromId: string;
  readonly toKind: string;
  readonly toId: string;
  readonly generation: string;
}

export function knowledgeEdgeGeneration(rowGeneration: string | null, incarnation: string): string | null {
  if (!/^(0|[1-9][0-9]*)$/.test(incarnation)) throw new Error('Invalid knowledge edge incarnation');
  return rowGeneration === null ? null : createHash('sha256').update(JSON.stringify([rowGeneration, incarnation])).digest('hex');
}

export function knowledgeEdgeChangesFromRows(rows: ReturnType<SqlDatabase['exec']>): readonly KnowledgeEdgeChangeSnapshot[] {
  return (rows[0]?.values ?? []).map(values => {
    const [generation, fromKind, fromId, toKind, toId] = values;
    if (typeof generation !== 'string' || !/^[1-9][0-9]*$/.test(generation)
      || typeof fromKind !== 'string' || typeof fromId !== 'string' || typeof toKind !== 'string' || typeof toId !== 'string') {
      throw new Error('Invalid knowledge edge change row');
    }
    return { generation, fromKind, fromId, toKind, toId };
  });
}
