import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { includeOfficialLinkedEvidence } from '../sdk/src/platform/knowledge/semantic/answer-evidence.js';
import { answerConfidence } from '../sdk/src/platform/knowledge/semantic/answer-llm.js';
import { KnowledgeSourceRankingHeldError } from '../sdk/src/platform/knowledge/semantic/answer-source-ranking.js';
import type { EvidenceItem } from '../sdk/src/platform/knowledge/semantic/answer-common.js';
import { useKnowledgeAnswerReadings } from './_helpers/knowledge-answer-readings.js';

const readings = useKnowledgeAnswerReadings();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-linked-evidence-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const device = await store.upsertNode({ id: 'device', kind: 'knowledge_entity', slug: 'device', title: 'Router', status: 'active' });
  const source = await store.upsertSource({ id: 'manual', connectorId: 'manual', sourceType: 'manual', title: 'Router manual', summary: 'Reset by holding the switch for ten seconds.', status: 'indexed', metadata: { sourceDiscovery: { linkedObjectIds: [device.id] } } });
  return { store, device, source };
}

describe('linked evidence probability and retrieval compatibility', () => {
  test('settled linked evidence leads the union without comparing probabilities against retrieval points', async () => {
    const { store, device, source } = await fixture();
    readings.set({ sources: [['Router manual', 0.99]] });
    const original: EvidenceItem = { kind: 'source', id: source.id, title: source.title!, source, score: 160, facts: [] };
    const unrelated: EvidenceItem = { kind: 'node', id: device.id, title: device.title, node: device, score: 900, facts: [] };
    const result = await includeOfficialLinkedEvidence(store, 'default', 'Reset the router', [unrelated, original], [device], 1);
    expect(result.map((item) => item.id)).toEqual([source.id, device.id]);
    expect(result[0]?.score).toBe(160);
    expect(result[1]?.score).toBe(900);
    expect(answerConfidence(null, result)).toBe(answerConfidence(null, [original]));
  });
  test('a newly found source has no invented retrieval score or synthesized confidence', async () => {
    const { store, device, source } = await fixture();
    readings.set({ sources: [['Router manual', 0.99]] });
    const result = await includeOfficialLinkedEvidence(store, 'default', 'Reset the router', [], [device], 1);
    expect(result.map((item) => item.id)).toEqual([source.id]);
    expect(result[0]?.score).toBe(0);
    // Legacy answer confidence remains a separate pending K4 conversion.
    expect(answerConfidence(null, result)).toBe(10);
  });
  test('an uncertain relevance reading cannot recover an original high retrieval score', async () => {
    const { store, device, source } = await fixture();
    readings.set({ sources: [['Router manual', 0.5]] });
    const original: EvidenceItem = { kind: 'source', id: source.id, title: source.title!, source, score: 900, facts: [] };
    const before = { nodes: store.listNodes(), sources: store.listSources(), edges: store.listEdges() };
    await expect(includeOfficialLinkedEvidence(store, 'default', 'Reset the router', [original], [device], 1)).rejects.toBeInstanceOf(KnowledgeSourceRankingHeldError);
    expect(original.score).toBe(900);
    expect({ nodes: store.listNodes(), sources: store.listSources(), edges: store.listEdges() }).toEqual(before);
  });
});
