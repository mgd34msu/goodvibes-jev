import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { prepareAnswerEvidence } from '../sdk/src/platform/knowledge/semantic/answer-verification/evidence.js';
import { withAnswerVerificationBudget } from '../sdk/src/platform/knowledge/semantic/answer-verification/budget.js';
import { KnowledgeAnswerQualityHeldError } from '../sdk/src/platform/knowledge/semantic/answer-verification/types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-evidence-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const source = await store.upsertSource({ id: 'local-source-reference', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 manual',
    summary: 'Metadata summary is not extracted truth.', status: 'indexed', metadata: { knowledgeSpaceId: 'fixture-space', privateInternal: 'DO_NOT_TRANSMIT_METADATA' } });
  const extraction = await store.upsertExtraction({ id: 'local-extraction-reference', sourceId: source.id, extractorId: 'synthetic', format: 'text',
    excerpt: 'AC-7 has four HDMI ports and does not support Bluetooth.', metadata: { knowledgeSpaceId: 'fixture-space' } });
  const fact = await store.upsertNode({ id: 'local-fact-reference', kind: 'fact', slug: 'hdmi', title: 'HDMI ports', sourceId: source.id,
    summary: 'AC-7 has four HDMI ports.', metadata: { knowledgeSpaceId: 'fixture-space', value: 'four HDMI ports' } });
  return { store, source, extraction, fact, input: { store, spaceId: 'fixture-space', query: 'How many ports?', sources: [source], facts: [fact], subjects: [] } };
}

describe('answer extraction evidence and local provenance', () => {
  test('projects actual extraction with opaque local references and omits arbitrary metadata', async () => {
    const { input, source, extraction } = await fixture(); const prepared = prepareAnswerEvidence(input);
    const transmitted = JSON.stringify(prepared.evidence);
    expect(transmitted).toContain('does not support Bluetooth');
    for (const hidden of ['DO_NOT_TRANSMIT_METADATA', source.id, extraction.id, 'local-fact-reference', 'Metadata summary']) expect(transmitted).not.toContain(hidden);
    expect(prepared.references).toEqual([{ reference: 'evidence-1', sourceId: source.id, extractionId: extraction.id }]);
    expect(Object.isFrozen(prepared.evidence)).toBe(true); prepared.assertCurrent();
  });
  test('source summaries do not become evidence when extraction is missing', async () => {
    const { input, store, source } = await fixture(); const missing = await store.upsertSource({ ...source, id: 'summary-only' });
    const prepared = prepareAnswerEvidence({ ...input, sources: [missing] });
    expect(prepared.evidence).toEqual([]); expect(prepared.references).toEqual([]);
  });
  test('foreign protected sources are excluded before projection or input scanning', async () => {
    const { input, store, source } = await fixture();
    const foreign = await store.upsertSource({ ...source, id: 'foreign', metadata: { knowledgeSpaceId: 'foreign-space' } });
    await store.upsertExtraction({ sourceId: foreign.id, extractorId: 'synthetic', format: 'text', excerpt: 'Authorization: Bearer synthetic-foreign', metadata: { knowledgeSpaceId: 'foreign-space' } });
    const prepared = prepareAnswerEvidence({ ...input, sources: [foreign, source] });
    expect(prepared.evidence).toHaveLength(1); expect(JSON.stringify(prepared.evidence)).not.toContain('synthetic-foreign');
  });
  test('complete selected text receives privacy preflight without clipping a late protected value', async () => {
    const { input, store, source, extraction } = await fixture();
    await store.upsertExtraction({ ...extraction, excerpt: `${'ordinary evidence '.repeat(3000)} Authorization: Bearer synthetic-late` });
    expect(() => prepareAnswerEvidence({ ...input, sources: [store.getSource(source.id)!] })).toThrow(JudgmentInputError);
  });
  test('source, extraction and operator content changes invalidate a prepared read set', async () => {
    const { input, store, fact, extraction } = await fixture();
    const prepared = prepareAnswerEvidence(input);
    await store.upsertNode({ ...fact, summary: 'Concurrent corrected claim.' });
    expect(() => prepared.assertCurrent()).toThrow(KnowledgeAnswerQualityHeldError);
    const next = prepareAnswerEvidence({ ...input, facts: [store.getNode(fact.id)!] });
    await store.upsertExtraction({ ...extraction, excerpt: 'AC-7 has two ports.' });
    expect(() => next.assertCurrent()).toThrow(KnowledgeAnswerQualityHeldError);
  });
  test('accessors cannot run while selecting or snapshotting records', async () => {
    const { input, source } = await fixture(); let calls = 0;
    const candidate = { ...source }; Object.defineProperty(candidate, 'metadata', { enumerable: true, get() { calls++; return source.metadata; } });
    expect(() => prepareAnswerEvidence({ ...input, sources: [candidate] })).toThrow(JudgmentInputError); expect(calls).toBe(0);
  });
  test('one total deadline aborts an ignored-signal operation before late continuation can write', async () => {
    const released = Promise.withResolvers<void>(); let writes = 0;
    await expect(withAnswerVerificationBudget(async (signal) => { await released.promise; if (!signal.aborted) writes++; }, 5)).rejects.toBeInstanceOf(KnowledgeAnswerQualityHeldError);
    released.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 5)); expect(writes).toBe(0);
  });
});
