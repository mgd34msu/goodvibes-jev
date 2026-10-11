import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { collectAnswerEvidence, includeOfficialLinkedEvidence, toSearchResult } from '../sdk/src/platform/knowledge/semantic/answer-evidence.js';
import { answerKnowledgeQuery } from '../sdk/src/platform/knowledge/semantic/answer.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { writeKnowledgeNodeRow } from '../sdk/src/platform/knowledge/store-node-history.js';

const spaceId = 'wiki:fixture';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function readings(values: Readonly<Record<string, number>>) {
  const fake = fakePort((name, question, state) => {
    if (name === 'fidelity') return choiceAnswer(question, 'supported', 0.99);
    if (name === 'enough' || name === 'complete') return noulAnswer(0.99);
    if (name === 'excerptUseful') return noulAnswer(0.01); // Unselected spans cannot bypass the barrier under test.
    if (name === 'features') return noulAnswer(0.01);
    if (name === 'match') return noulAnswer(0.99);
    const candidate = (state as { candidate?: { title?: string; reference?: string } }).candidate;
    if (name === 'serve' && ['AC-7 packaging', 'AC-7 connections'].includes(candidate?.title ?? '')) return noulAnswer(0.99);
    if (name !== 'useful' || !candidate?.reference || candidate.title === undefined || values[candidate.title] === undefined) {
      throw new Error(`Unexpected evidence-selection fixture reading: ${name}/${candidate?.title}`);
    }
    return noulAnswer(values[candidate.title]!);
  });
  installJudgmentPort(fake.port); return fake;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-evidence-selection-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init(); return store;
}
async function source(store: KnowledgeStore, id: string, title: string, text: string, space = spaceId) {
  const record = await store.upsertSource({ id, connectorId: 'synthetic', sourceType: 'manual', title,
    status: 'indexed', metadata: { knowledgeSpaceId: space } });
  await store.upsertExtraction({ sourceId: id, extractorId: 'synthetic', format: 'text', excerpt: text,
    metadata: { knowledgeSpaceId: space } });
  return record;
}
function collect(store: KnowledgeStore, query: string, signal?: AbortSignal) {
  return collectAnswerEvidence(store, { query }, spaceId, 10, [], signal);
}
describe('initial answer evidence selection callers', () => {
  test('keeps a semantic paraphrase with no literal query hit and rejects keyword stuffing', async () => {
    const store = await fixture();
    const useful = await source(store, 'recovery', 'Recovery procedure', 'Hold the recessed switch for ten seconds to restore factory network settings.');
    await source(store, 'stuffed', 'Official router reset support manual', 'Buy this product. Operating instructions are not provided here.');
    const fake = readings({ 'Recovery procedure': 0.99, 'Official router reset support manual': 0.01 });
    const result = await collect(store, 'How do I reset the router?');
    expect(result.map((item) => item.id)).toEqual([useful.id]);
    expect(result[0]!.score).toBe(0.99);
    expect(toSearchResult(result[0]!).reason).toBe('semantic evidence relevance probability (0–1)');
    expect(fake.requests.filter((request) => 'useful' in request.questions)).toHaveLength(2);
  });
  test('record kind and explicit candidate membership cannot override an actual relevance reading', async () => {
    const store = await fixture();
    const doc = await source(store, 'ac-reference', 'AC-7 data', 'AC-7 has blue packaging and four wired network ports.');
    readings({ 'AC-7 packaging': 0.01, 'AC-7 connections': 0.97 });
    const fact = await store.upsertNode({ id: 'fixture-fact', kind: 'fact', slug: 'ac-box', title: 'AC-7 packaging', summary: 'AC-7 has blue packaging.',
      sourceId: doc.id, status: 'active', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'note' } });
    const entity = await store.upsertNode({ id: 'fixture-entity', kind: 'knowledge_entity', slug: 'ac-ports', title: 'AC-7 connections', summary: 'AC-7 has four wired network ports.',
      sourceId: doc.id, status: 'active', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'entity' } });
    const result = await collectAnswerEvidence(store, { query: 'How many network ports does AC-7 have?', strictCandidates: true,
      candidateNodeIds: [fact.id, entity.id] }, spaceId, 10, []);
    expect(result.map((item) => item.id)).toEqual([entity.id]); expect(result[0]!.score).toBe(0.97);
  });
  test('a winning fact retains its accepted backing source under a one-result display limit', async () => {
    const store = await fixture(); const doc = await source(store, 'limited-reference', 'AC-7 manual', 'AC-7 has four wired network ports.');
    readings({ 'AC-7 manual': 0.9, 'AC-7 connections': 0.99 });
    const fact = await store.upsertNode({ id: 'limited-fact', kind: 'fact', slug: 'limited-ports', title: 'AC-7 connections',
      summary: 'AC-7 has four wired network ports.', sourceId: doc.id, status: 'active', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact' } });
    const result = await answerKnowledgeQuery({ store }, { query: 'How many AC-7 network ports?', knowledgeSpaceId: spaceId,
      strictCandidates: true, candidateSourceIds: [doc.id], limit: 1, includeLinkedObjects: false, autoRepairGaps: false });
    expect(result.answer.sources.map((entry) => entry.id)).toEqual([doc.id]);
    expect(result.answer.facts.map((entry) => entry.id)).toEqual([fact.id]);
    expect(result.results).toHaveLength(1); expect(result.results[0]!.id).toBe(fact.id); expect(result.results[0]!.score).toBe(0.99);
  });
  test('later linked-source inclusion cannot revive an explicitly rejected initial source', async () => {
    const store = await fixture(); const doc = await source(store, 'denied-reference', 'AC-7 manual', 'AC-7 is a network controller with four wired ports.');
    const fake = readings({ 'AC-7 manual': 0.01, 'AC-7 connections': 0.99 });
    const subject = await store.upsertNode({ id: 'linked-subject', kind: 'ha_device', slug: 'linked-subject', title: 'AC-7 connections',
      summary: 'AC-7 network controller.', sourceId: doc.id, metadata: { knowledgeSpaceId: spaceId, model: 'AC-7' } });
    await store.upsertEdge({ fromKind: 'source', fromId: doc.id, toKind: 'node', toId: subject.id, relation: 'source_for', metadata: { knowledgeSpaceId: spaceId } });
    const query = 'How many AC-7 ports?';
    const selected = await collectAnswerEvidence(store, { query, strictCandidates: true, candidateSourceIds: [doc.id], linkedObjects: [subject] }, spaceId, 1, []);
    const linked = await includeOfficialLinkedEvidence(store, spaceId, query, selected, [subject], 1);
    const repeated = await includeOfficialLinkedEvidence(store, spaceId, query, linked, [subject], 1);
    expect(repeated.some((item) => item.source?.id === doc.id)).toBe(false);
    expect(fake.requests.filter((request) => 'match' in request.questions)).toHaveLength(0);
  });
  test('settled rejection yields no evidence; a later uncertain reading holds the complete pass', async () => {
    const store = await fixture();
    await source(store, 'first', 'AC-7 first manual', 'AC-7 uses four ports.');
    await source(store, 'second', 'AC-7 second manual', 'AC-7 uses four ports.');
    readings({ 'AC-7 first manual': 0.01, 'AC-7 second manual': 0.01 });
    expect(await collect(store, 'How many AC-7 ports?')).toEqual([]);
    readings({ 'AC-7 first manual': 0.99, 'AC-7 second manual': 0.6 });
    await expect(collect(store, 'How many AC-7 ports?')).rejects.toMatchObject({ reason: 'unsettled' });
  });
  test('foreign protected content is excluded structurally before any ranking request', async () => {
    const store = await fixture();
    const local = await source(store, 'local', 'AC-7 local', 'AC-7 uses four ports.');
    await source(store, 'foreign', 'AC-7 foreign', 'Authorization: Bearer synthetic', 'wiki:other');
    const fake = readings({ 'AC-7 local': 0.99 });
    expect((await collect(store, 'How many AC-7 ports?')).map((item) => item.id)).toEqual([local.id]);
    expect(JSON.stringify(fake.requests)).not.toContain('synthetic');
    expect(JSON.stringify(fake.requests)).not.toContain('AC-7 foreign');
  });
  test('preflights the complete selected source before excerpt clipping or any semantic request', async () => {
    const store = await fixture();
    await source(store, 'ordinary', 'AC-7 ordinary', 'AC-7 uses four ports.');
    await source(store, 'protected-tail', 'AC-7 selected manual', `${'Ordinary context. '.repeat(1_000)} Authorization: Bearer synthetic`);
    const fake = readings({ 'AC-7 ordinary': 0.99, 'AC-7 selected manual': 0.99 });
    await expect(collect(store, 'How many AC-7 ports?')).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('a mismatched extraction cannot transmit another concrete space through a broad alias', async () => {
    for (const broad of [false, true]) {
      const store = await fixture(); const concreteSpace = broad ? 'homeassistant:first' : spaceId;
      const record = await source(store, `cross-space-${broad}`, 'AC-7 manual', 'Ordinary local data.', concreteSpace);
      const extraction = store.getExtractionBySourceId(record.id)!;
      await store.upsertExtraction({ ...extraction, excerpt: 'FOREIGN_PRIVATE_MEANING', metadata: { knowledgeSpaceId: broad ? 'homeassistant:second' : 'wiki:other' } });
      const fake = readings({ 'AC-7 manual': 0.99 });
      await expect(collectAnswerEvidence(store, { query: 'How many AC-7 ports?' }, broad ? 'homeassistant' : spaceId, 10, []))
        .rejects.toMatchObject({ reason: 'malformed' });
      expect(fake.requests).toHaveLength(0);
    }
  });
  test('both established metadata content paths retain full meaning and protected-input preflight', async () => {
    for (const nested of [false, true]) {
      const store = await fixture(); const record = await source(store, `metadata-${nested}`, 'AC-7 manual', '');
      const extraction = store.getExtractionBySourceId(record.id)!;
      const content = 'AC-7 has four ports and no Bluetooth support.';
      await store.upsertExtraction({ ...extraction, ...(nested ? { structure: { metadata: { content } } } : { metadata: { knowledgeSpaceId: spaceId, content } }) });
      const fake = readings({ 'AC-7 manual': 0.99 }); await collect(store, 'How many AC-7 ports?');
      expect(JSON.stringify(fake.requests[0]!.state)).toContain(content);
      const protectedContent = 'Authorization: Bearer synthetic';
      await store.upsertExtraction({ ...store.getExtractionBySourceId(record.id)!, ...(nested ? { structure: { metadata: { content: protectedContent } } } : { metadata: { knowledgeSpaceId: spaceId, content: protectedContent } }) });
      const next = readings({ 'AC-7 manual': 0.99 });
      await expect(collect(store, 'How many AC-7 ports?')).rejects.toBeInstanceOf(JudgmentInputError); expect(next.requests).toHaveLength(0);
    }
  });
  test('source-associated fact kinds are preflighted before initial selection, including legacy rows', async () => {
    const initial = await fixture(); const record = await source(initial, 'kind-reference', 'AC-7 manual', 'AC-7 has four ports.');
    const draft = await initial.upsertNode({ id: 'legacy-kind', kind: 'fact', slug: 'legacy-kind', title: 'AC-7 connections',
      status: 'draft', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', sourceIds: [record.id], factKind: 'Authorization: Bearer synthetic' } });
    const sqlite = new SQLiteStore(initial.storagePath); await sqlite.init(createSchema, { schemaVersion: 9 });
    writeKnowledgeNodeRow(sqlite, { ...draft, status: 'active' }); await sqlite.save();
    const store = new KnowledgeStore({ dbPath: initial.storagePath }); await store.init();
    const fake = readings({ 'AC-7 manual': 0.99 });
    await expect(collectAnswerEvidence(store, { query: 'AC-7 ports?', strictCandidates: true, candidateSourceIds: [record.id] }, spaceId, 10, []))
      .rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('all final fidelity claim fields share the initial complete-pass preflight', async () => {
    const protectedText = 'Authorization: Bearer synthetic';
    for (const extra of [
      { aliases: [protectedText] }, { metadata: { labels: [protectedText] } },
      { metadata: { subject: protectedText } }, { metadata: { targetHints: [protectedText] } },
      { metadata: { targetHints: [{ title: 'AC-7', description: protectedText }] } },
      { metadata: { targetHints: [{ title: 'AC-7', model: protectedText }] } },
      { metadata: { subject: { password: 'synthetic-structured-secret' } } },
    ]) {
      const initial = await fixture(); const record = await source(initial, 'claim-reference', 'AC-7 manual', 'AC-7 has four ports.');
      const draft = await initial.upsertNode({ id: 'legacy-claim', kind: 'fact', slug: 'legacy-claim', title: 'AC-7 connections',
        status: 'draft', aliases: extra.aliases, metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', sourceIds: [record.id], ...extra.metadata } });
      const sqlite = new SQLiteStore(initial.storagePath); await sqlite.init(createSchema, { schemaVersion: 9 });
      writeKnowledgeNodeRow(sqlite, { ...draft, status: 'active' }); await sqlite.save();
      const store = new KnowledgeStore({ dbPath: initial.storagePath }); await store.init();
      const fake = readings({ 'AC-7 manual': 0.99 });
      await expect(collectAnswerEvidence(store, { query: 'AC-7 ports?', strictCandidates: true, candidateSourceIds: [record.id] }, spaceId, 10, []))
        .rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    }
  });
  test('graph-only subject descriptions are preflighted with source-associated facts', async () => {
    const initial = await fixture(); const record = await source(initial, 'graph-reference', 'AC-7 manual', 'AC-7 has four ports.');
    const fact = await initial.upsertNode({ id: 'graph-fact', kind: 'fact', slug: 'graph-fact', title: 'AC-7 connections', status: 'draft',
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', sourceIds: [record.id] } });
    const subject = await initial.upsertNode({ id: 'graph-subject', kind: 'ha_device', slug: 'graph-subject', title: 'AC-7', status: 'draft',
      summary: 'Authorization: Bearer synthetic', metadata: { knowledgeSpaceId: spaceId } });
    await initial.upsertEdge({ fromKind: 'node', fromId: fact.id, toKind: 'node', toId: subject.id, relation: 'describes', metadata: { knowledgeSpaceId: spaceId } });
    const sqlite = new SQLiteStore(initial.storagePath); await sqlite.init(createSchema, { schemaVersion: 9 });
    writeKnowledgeNodeRow(sqlite, { ...fact, status: 'active' }); writeKnowledgeNodeRow(sqlite, { ...subject, status: 'active' }); await sqlite.save();
    const store = new KnowledgeStore({ dbPath: initial.storagePath }); await store.init();
    const fake = readings({ 'AC-7 manual': 0.99 });
    await expect(collectAnswerEvidence(store, { query: 'AC-7 ports?', strictCandidates: true, candidateSourceIds: [record.id] }, spaceId, 1, []))
      .rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('an explicit candidate ID cannot make a draft factual claim eligible for serving', async () => {
    const store = await fixture();
    const doc = await source(store, 'draft-reference', 'AC-7 data', 'AC-7 has four wired network ports.');
    const draft = await store.upsertNode({ id: 'pending-claim', kind: 'fact', slug: 'pending-ports', title: 'AC-7 pending ports',
      summary: 'AC-7 has four wired network ports.', sourceId: doc.id, status: 'draft', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact' } });
    const fake = readings({ 'AC-7 pending ports': 0.99 });
    const result = await collectAnswerEvidence(store, { query: 'How many network ports does AC-7 have?', strictCandidates: true,
      candidateNodeIds: [draft.id] }, spaceId, 10, []);
    expect(result).toEqual([]); expect(fake.requests).toHaveLength(0); expect(store.getNode(draft.id)?.status).toBe('draft');
  });
  test('a source or extraction change during ranking invalidates the selected evidence', async () => {
    for (const changed of ['source', 'extraction'] as const) {
      const store = await fixture(); const record = await source(store, `reference-${changed}`, 'AC-7 manual', 'AC-7 uses four ports.');
      const fake = readings({ 'AC-7 manual': 0.99 }); let edited = false;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if (!edited && 'useful' in request.questions) {
          edited = true;
          if (changed === 'source') await store.upsertSource({ ...record, summary: 'Concurrent correction.' });
          else await store.upsertExtraction({ ...store.getExtractionBySourceId(record.id)!, excerpt: 'AC-7 has two ports, not four.' });
        }
        return result;
      } });
      await expect(collect(store, 'How many AC-7 ports?')).rejects.toMatchObject({ reason: 'stale' });
      expect(edited).toBe(true);
    }
  });
  test('answer callers preserve uncertain versus unavailable and perform no generation or repair writes', async () => {
    for (const unavailable of [false, true]) {
      const store = await fixture(); const record = await source(store, `held-${unavailable}`, 'AC-7 manual', 'AC-7 uses four ports.');
      readings({ 'AC-7 manual': 0.6 }); if (unavailable) installJudgmentPort(undefined);
      let generations = 0;
      await expect(answerKnowledgeQuery({ store, llm: {
        async completeJson() { throw new Error('Unused generation path'); },
        async completeText() { generations++; return 'Four ports.'; },
      } }, { query: 'How many AC-7 ports?', knowledgeSpaceId: spaceId, strictCandidates: true,
        candidateSourceIds: [record.id], autoRepairGaps: false })).rejects.toMatchObject({ reason: unavailable ? 'unavailable' : 'uncertain' });
      expect(generations).toBe(0); expect(store.listNodes()).toEqual([]); expect(store.listIssues()).toEqual([]);
    }
  });
});
