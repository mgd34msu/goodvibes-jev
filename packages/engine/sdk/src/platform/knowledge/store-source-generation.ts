import { createHash } from 'node:crypto';
import type { SQLiteStore } from '../state/sqlite-store.js';
import { mapSourceRow } from './store-schema.js';
import type { KnowledgeSourceRecord } from './types.js';

/** A detached read of the stored row, including all persisted source values. */
export interface KnowledgeSourceSnapshot {
  readonly source: KnowledgeSourceRecord | null;
  readonly generation: string | null;
}

export type KnowledgeSourceWriteResult =
  | { readonly kind: 'written'; readonly source: KnowledgeSourceRecord; readonly generation: string }
  | { readonly kind: 'held'; readonly reason: 'source-changed' | 'pending-local-changes'; readonly current: KnowledgeSourceRecord | null; readonly generation: string | null };

/** Read SQLite directly: cached records are mutable and cannot grant a write. */
export function readKnowledgeSourceSnapshot(
  sqlite: Pick<SQLiteStore, 'exec'>,
  selector: { readonly id: string } | { readonly canonicalUri: string },
): KnowledgeSourceSnapshot {
  const result = 'id' in selector
    ? sqlite.exec('SELECT * FROM knowledge_sources WHERE id = ? LIMIT 1', [selector.id])
    : sqlite.exec('SELECT * FROM knowledge_sources WHERE canonical_uri = ? LIMIT 1', [selector.canonicalUri]);
  const row = result[0];
  const values = row?.values[0];
  if (!row || !values) return { source: null, generation: null };
  // Column names and every raw stored value participate, including raw JSON.
  // This is an entity fingerprint, not a wall-clock timestamp or an authority.
  const entries = row.columns.map((column, index) => [column, values[index]] as const)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const generation = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { source: mapSourceRow(row.columns, values), generation };
}
