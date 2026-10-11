import { randomUUID } from 'node:crypto';
import type { SQLiteStore } from '../state/sqlite-store.js';
import type { KnowledgeEdgeRecord, KnowledgeEdgeUpsertInput } from './types.js';
import { nowMs } from './store-schema.js';

const guardedEdgeInputs = new WeakMap<KnowledgeEdgeUpsertInput, () => void>();
/** Local commit authority does not survive copying or serialization. */
export function guardKnowledgeEdgeInput(input: KnowledgeEdgeUpsertInput, assertCurrent: () => void): KnowledgeEdgeUpsertInput {
  guardedEdgeInputs.set(input, assertCurrent); return input;
}

export function findKnowledgeEdge(edges: ReadonlyMap<string, KnowledgeEdgeRecord>, input: KnowledgeEdgeUpsertInput): KnowledgeEdgeRecord | undefined {
    return [...edges.values()].find((edge) => (
      edge.fromKind === input.fromKind
      && edge.fromId === input.fromId
      && edge.toKind === input.toKind
      && edge.toId === input.toId
      && edge.relation === input.relation
    ));
}

export function prepareKnowledgeEdgeRecord(input: KnowledgeEdgeUpsertInput, existing: KnowledgeEdgeRecord | undefined): KnowledgeEdgeRecord {
    guardedEdgeInputs.get(input)?.();
    const now = nowMs();
    const record: KnowledgeEdgeRecord = {
      id: existing?.id ?? `edge-${randomUUID().slice(0, 8)}`,
      fromKind: input.fromKind,
      fromId: input.fromId,
      toKind: input.toKind,
      toId: input.toId,
      relation: input.relation,
      weight: Number.isFinite(input.weight) ? Number(input.weight) : existing?.weight ?? 1,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return record;
}

export function writeKnowledgeEdgeRow(sqlite: SQLiteStore, record: KnowledgeEdgeRecord): void {
    sqlite.run(`
      INSERT OR REPLACE INTO knowledge_edges (
        id, from_kind, from_id, to_kind, to_id, relation, weight, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.id,
      record.fromKind,
      record.fromId,
      record.toKind,
      record.toId,
      record.relation,
      record.weight,
      JSON.stringify(record.metadata),
      record.createdAt,
      record.updatedAt,
    ]);
}
