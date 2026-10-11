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
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { nodeServingWithoutReview } from '../sdk/src/platform/knowledge/activation/battery.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';

const readings = useKnowledgeAnswerReadings();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(linked = true) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-linked-evidence-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const identity = 'Router is a network router.';
  const source = await store.upsertSource({ id: 'manual', connectorId: 'manual', sourceType: 'manual', title: 'Router manual', summary: 'Reset by holding the switch for ten seconds.', status: 'indexed' });
  const identitySource = await store.upsertSource({ id: 'identity-source', connectorId: 'manual', sourceType: 'manual', title: 'Router identity', status: 'pending' });
  await store.upsertExtraction({ sourceId: identitySource.id, extractorId: 'synthetic', format: 'text', excerpt: identity });
  const seed = fakePort((name, question, state) => {
    if (name !== 'serve' || question.type !== 'noul' || question.instructions !== nodeServingWithoutReview.items.serve.question.instructions)
      throw new Error('Unknown linked subject activation contract');
    expect(state).toEqual({ candidate: { kind: 'knowledge_entity', title: 'Router', summary: identity, aliases: [], content: {},
      producerConfidence: { value: 0, units: '0-100 descriptive producer score, never activation authority' }, claimedTrust: {}, trust: 'untrusted synthesized reference material' },
      evidence: [{ reference: 'source-1', primaryReference: true, sourceType: 'manual', title: 'Router identity', claimedTrust: {},
        trust: 'untrusted source reference; only actual extraction supplies evidence', extraction: { excerpt: identity, sections: [], texts: {} } }], subjects: [] });
    return noulAnswer(0.99);
  });
  const previous = installJudgmentPort(seed.port);
  let device: KnowledgeNodeRecord;
  try { device = await store.upsertNode({ id: 'device', kind: 'knowledge_entity', slug: 'device', title: 'Router', summary: identity,
    sourceId: identitySource.id, status: 'active' }); }
  finally { installJudgmentPort(previous); }
  expect(device.status).toBe('active');
  if (linked) await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: device.id, relation: 'source_for' });
  return { store, device, source };
}

describe('linked evidence probability and retrieval compatibility', () => {
  test('an untrusted linkage hint cannot turn unrelated source text into settled evidence or invent a native association', async () => {
    const { store, device, source } = await fixture(false);
    const unrelated = 'The cardboard packaging has a blue stripe.';
    await store.upsertSource({ ...source, summary: 'The carton is blue.', metadata: { ...source.metadata, sourceDiscovery: { linkedObjectIds: [device.id] } } });
    await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: unrelated });
    readings.set({ sources: [['Router manual', 0.01]], excerpts: [[unrelated, 0.01]] });
    const before = { sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), extractions: store.listExtractions(), issues: store.listIssues() };
    const result = await includeOfficialLinkedEvidence(store, 'default', 'Reset the router', [], [device], 1);
    expect(result).toEqual([]);
    expect(readings.requests.some(request => 'match' in request.questions)).toBe(true);
    expect(readings.requests.some(request => 'serve' in request.questions)).toBe(false);
    expect(JSON.stringify(readings.requests)).toContain(unrelated);
    expect(store.listEdges()).toEqual([]);
    expect(store.getNode(device.id)).toBe(device);
    expect({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), extractions: store.listExtractions(), issues: store.listIssues() }).toEqual(before);
  });
  test('settled linked evidence leads the union without comparing probabilities against retrieval points', async () => {
    const { store, device, source } = await fixture();
    readings.set({ sources: [['Router manual', 0.99]] });
    const original: EvidenceItem = { kind: 'source', id: source.id, title: source.title!, source, score: 160, facts: [] };
    const unrelated: EvidenceItem = { kind: 'node', id: device.id, title: device.title, node: device, score: 900, facts: [] };
    const result = await includeOfficialLinkedEvidence(store, 'default', 'Reset the router', [unrelated, original], [device], 1);
    expect(result.map((item) => item.id)).toEqual([source.id, device.id]);
    expect(result[0]?.score).toBe(160);
    expect(result[1]?.score).toBe(900);
    expect(answerConfidence(null)).toBe(0);
  });
  test('a newly found source has no invented retrieval score or synthesized confidence', async () => {
    const { store, device, source } = await fixture();
    readings.set({ sources: [['Router manual', 0.99]] });
    const result = await includeOfficialLinkedEvidence(store, 'default', 'Reset the router', [], [device], 1);
    expect(result.map((item) => item.id)).toEqual([source.id]);
    expect(result[0]?.score).toBe(0);
    // Retrieval probabilities/points cannot invent measured answer fidelity.
    expect(answerConfidence(null)).toBe(0);
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
