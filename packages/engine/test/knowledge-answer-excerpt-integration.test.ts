import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { collectAnswerEvidence, includeOfficialLinkedEvidence, answerExcerptProvenance, assertAnswerEvidenceCurrent } from '../sdk/src/platform/knowledge/semantic/answer-evidence.js';
import { reviewKnowledgeNodeRecord } from '../sdk/src/platform/knowledge/service-node-admin.js';
import { answerKnowledgeQuery } from '../sdk/src/platform/knowledge/semantic/answer.js';
import { rankAnswerSources, readAnswerSourceRanking, sourceRankingContent } from '../sdk/src/platform/knowledge/semantic/answer-source-ranking.js';
import type { KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';
const spaceId = 'wiki:excerpts';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const query = 'How do I reset the router?';
const recovery = 'Hold the recessed switch for ten seconds to restore factory network settings.';
function port(excerpts: readonly string[] = [recovery], options: { rejected?: readonly string[]; rejectedFacts?: readonly string[]; enough?: number } = {}) {
  const fake = fakePort((name, question, state) => {
    const candidate = (state as { candidate?: { title?: string; text?: string; sourceType?: string } }).candidate;
    if (name === 'excerptUseful') return noulAnswer(excerpts.includes(candidate?.text ?? '') ? 0.99 : 0.01);
    if (name === 'useful') return noulAnswer(options.rejected?.includes(candidate?.title ?? '') ? 0.01 : 0.99);
    if (name === 'match') return noulAnswer(!candidate?.sourceType && options.rejectedFacts?.includes(candidate?.title ?? '') ? 0.01 : 0.99);
    if (name === 'serve') return noulAnswer(0.99);
    if (name === 'fidelity') return choiceAnswer(question, 'supported', 0.99);
    if (name === 'preferred') return choiceAnswer(question, 'generated', 0.99);
    if (name === 'enough' || name === 'complete') return noulAnswer(options.enough ?? 0.99);
    throw new Error(`Unscripted excerpt integration reading: ${name}`);
  }); installJudgmentPort(fake.port); return fake;
}
async function fixture(text = recovery) {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-excerpts-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const source = await store.upsertSource({ id: 'private-source-key', connectorId: 'synthetic', sourceType: 'manual', title: 'AC-7 reference', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const extraction = await store.upsertExtraction({ id: 'private-extraction-key', sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: text, metadata: { knowledgeSpaceId: spaceId } });
  return { store, source, extraction };
}
async function link(store: KnowledgeStore, source: KnowledgeSourceRecord) {
  const node = await store.upsertNode({ id: 'private-subject-key', kind: 'knowledge_entity', slug: 'router', title: 'AC-7', status: 'active', metadata: { knowledgeSpaceId: spaceId } });
  const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id, relation: 'source_for', metadata: { knowledgeSpaceId: spaceId } });
  return { node, edge };
}
function collect(store: KnowledgeStore, actualQuery = query) { return collectAnswerEvidence(store, { query: actualQuery }, spaceId, 10, []); }
function answer(store: KnowledgeStore, source: KnowledgeSourceRecord, onGenerate = () => {}, signal?: AbortSignal) {
  return answerKnowledgeQuery({ store, llm: { async completeText() { onGenerate(); return recovery; }, async completeJson() { throw new Error('Wrong generation API'); } } },
    { query, knowledgeSpaceId: spaceId, candidateSourceIds: [source.id], strictCandidates: true, includeLinkedObjects: false, autoRepairGaps: false, signal });
}
function snapshot(store: KnowledgeStore) { return JSON.stringify({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues(), extractions: store.listExtractions() }); }

describe('answer excerpts on real initial and linked ranking paths', () => {
  test('a contrary-to-token-overlap span reaches initial source ranking with exact local provenance', async () => {
    const { store, source, extraction } = await fixture(`Router reset manual support. Buy now.\n\n${recovery}`);
    const fake = port(); const evidence = await collect(store); await rankAnswerSources(evidence, [], query);
    expect(evidence[0]!.excerpt).toBe(recovery);
    const provenance = answerExcerptProvenance(evidence[0]!);
    expect(provenance).toEqual([{ sourceId: source.id, extractionId: extraction.id, field: 'extraction.excerpt', start: extraction.excerpt!.indexOf(recovery), end: extraction.excerpt!.length, text: recovery }]);
    const request = fake.requests.find((request) => 'match' in request.questions)!;
    expect((request.state as { candidate: { excerpts: string[] } }).candidate.excerpts).toEqual([recovery]);
    const excerptRequests = fake.requests.filter((request) => 'excerptUseful' in request.questions);
    expect(excerptRequests.length).toBeGreaterThan(1);
    expect(JSON.stringify(excerptRequests)).not.toContain(source.id); expect(JSON.stringify(excerptRequests)).not.toContain(extraction.id);
  });
  test('a linked-only source uses the exact span reader before its own source rank', async () => {
    const { store, source } = await fixture(recovery); const { node } = await link(store, source); const fake = port();
    const evidence = await includeOfficialLinkedEvidence(store, spaceId, query, [], [node], 10);
    expect(evidence[0]!.excerpt).toBe(recovery); expect(evidence[0]!.source?.id).toBe(source.id);
    expect((fake.requests.find((request) => 'match' in request.questions)!.state as { candidate: { excerpts: string[] } }).candidate.excerpts).toEqual([recovery]);
    expect(fake.requests.findIndex((request) => 'excerptUseful' in request.questions)).toBeLessThan(fake.requests.findIndex((request) => 'match' in request.questions));
    expect(JSON.stringify(fake.requests.filter((request) => 'excerptUseful' in request.questions))).not.toContain(node.id);
  });
  test('short negatives, tables, variant/accessory distinctions, URLs and non-Latin original text survive selection', async () => {
    for (const selected of ['AC-7: No Bluetooth.', 'AC-7 不支持蓝牙。', 'Model | Inputs\nAC-7 | 4\nAC-8 | 8', 'Open https://example.test/config for AC-7.']) {
      const text = `AC-8 has eight connectors.\n\nOptional accessory pack: four cables.\n\n${selected}`;
      const { store } = await fixture(text); port([selected]); const evidence = await collect(store, 'What does AC-7 provide?');
      expect(evidence[0]!.excerpt).toBe(selected);
      for (const span of answerExcerptProvenance(evidence[0]!)) expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });
  test('table labels and a later exception stored in separate extraction fields can be selected together', async () => {
    const { store, source, extraction } = await fixture('');
    const sections = ['Model | HDMI inputs', 'AC-7 | 4', 'AC-8 | 8', 'AC-7 Mini is excluded; it has two inputs.'];
    await store.upsertExtraction({ ...extraction, sections });
    port([sections.join('\n\n')]);
    const evidence = await collect(store, 'How many AC-7 HDMI inputs?');
    expect(evidence[0]!.excerpt).toBe(sections.join('\n\n'));
    expect(answerExcerptProvenance(evidence[0]!).map((span) => span.field)).toEqual(sections.map((_section, index) => `extraction.sections[${index}]`));
    expect(answerExcerptProvenance(evidence[0]!).every((span) => span.sourceId === source.id && span.extractionId === extraction.id)).toBe(true);
  });
  test('a neighboring operating-mode exception remains in the selected original excerpt', async () => {
    const text = 'AC-7 lasts twelve hours.\n\nOnly in standby; active use lasts two hours.';
    const { store } = await fixture(text); port([text]);
    const evidence = await collect(store, 'How long does AC-7 run?'); expect(evidence[0]!.excerpt).toBe(text);
  });
  test('an empty settled selection has no unconditional prefix or token backup on either path', async () => {
    const { store, source } = await fixture('Router reset manual. Buy now.'); const { node } = await link(store, source); port([]);
    const initial = await collect(store); expect(initial.find((item) => item.source)?.excerpt).toBe('');
    const linked = await includeOfficialLinkedEvidence(store, spaceId, query, [], [node], 10);
    expect(linked[0]!.excerpt).toBe(''); expect(answerExcerptProvenance(linked[0]!)).toEqual([]);
  });
  test('rejected nonempty summary and description cannot reappear as rank support on either prepared path', async () => {
    for (const linked of [false, true]) {
      const { store, source } = await fixture('Unrelated extracted prose.');
      const summary = 'Rejected summary says reset the router immediately.';
      const description = 'Rejected description claims the router has every reset option.';
      const current = await store.upsertSource({ ...source, summary, description });
      const { node } = await link(store, current); const fake = port([]);
      const evidence = linked ? await includeOfficialLinkedEvidence(store, spaceId, query, [], [node], 10) : await collect(store);
      if (!linked) await rankAnswerSources(evidence, [], query);
      const candidate = (fake.requests.find((request) => 'match' in request.questions)!.state as { candidate: Record<string, unknown> }).candidate;
      expect(candidate.evidenceScope).toBe('selected-excerpts'); expect(candidate.excerpts).toEqual([]); expect(candidate.facts).toEqual([]);
      expect(candidate.summary).toBeUndefined(); expect(candidate.description).toBeUndefined(); expect(JSON.stringify(candidate)).not.toContain(summary);
      expect(candidate.title).toBe(current.title); expect(candidate.sourceType).toBe(current.sourceType);
      expect(store.getSource(current.id)?.summary).toBe(summary); expect(store.getSource(current.id)?.description).toBe(description);
      expect(sourceRankingContent(current).summary).toBe(summary);
      // An independent legacy caller still explicitly supplies its complete body.
      const legacy = port([]); await readAnswerSourceRanking([{ source: current, score: 0 }], [], query);
      const legacyCandidate = (legacy.requests[0]!.state as { candidate: Record<string, unknown> }).candidate;
      expect(legacyCandidate.summary).toBe(summary); expect(legacyCandidate.description).toBe(description); expect(legacyCandidate.evidenceScope).toBeUndefined();
    }
  });
  test('a linked empty reread replaces an older excerpt even when linked source ranking rejects it', async () => {
    const { store, source } = await fixture(); const { node } = await link(store, source); const fake = port();
    let linkedPass = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if (linkedPass && ('excerptUseful' in request.questions || 'match' in request.questions)) {
        return { ...result, answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, noulAnswer(0.01)])) } as typeof result;
      }
      return result;
    } });
    const initial = await collect(store); expect(initial.find((item) => item.source)?.excerpt).toBe(recovery);
    linkedPass = true;
    const linked = await includeOfficialLinkedEvidence(store, spaceId, query, initial, [node], 10);
    expect(linked.find((item) => item.source)?.excerpt).toBe('');
    expect(answerExcerptProvenance(linked.find((item) => item.source)!)).toEqual([]);
    await rankAnswerSources(linked, [], query);
    const finalRank = fake.requests.filter((request) => 'match' in request.questions).at(-1)!;
    expect((finalRank.state as { candidate: { excerpts: string[] } }).candidate.excerpts).toEqual([]);
    expect(JSON.stringify(finalRank.state)).not.toContain(recovery);
  });
  test('an initial rejected source never receives an excerpt read or reappears through linkage', async () => {
    const { store, source } = await fixture(); const { node } = await link(store, source); const fake = port([recovery], { rejected: [source.title!] });
    const initial = await collect(store); const linked = await includeOfficialLinkedEvidence(store, spaceId, query, initial, [node], 10);
    expect(linked.some((item) => item.source?.id === source.id)).toBe(false);
    expect(fake.requests.filter((request) => 'excerptUseful' in request.questions || 'match' in request.questions)).toEqual([]);
  });
  test('settled facts are retained without lexical veto and identical positive/negative facts are not reread', async () => {
    const { store, source } = await fixture(); const { node } = await link(store, source); port();
    const fact = await store.upsertNode({ id: 'private-fact-key', kind: 'fact', slug: 'recovery', title: 'Recovery procedure', summary: recovery,
      sourceId: source.id, status: 'active', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact' } });
    await store.upsertNode({ id: 'irrelevant-fact-key', kind: 'fact', slug: 'packaging', title: 'Packaging', summary: 'The carton is blue.',
      sourceId: source.id, status: 'active', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact' } });
    const fake = port([], { rejectedFacts: ['Packaging'] }); const initial = await collect(store);
    const linked = await includeOfficialLinkedEvidence(store, spaceId, query, initial, [node], 10);
    expect(linked.find((item) => item.source)?.excerpt).toContain(recovery);
    expect(linked.find((item) => item.source)?.facts.map((item) => item.id)).toEqual([fact.id]);
    const factRequests = fake.requests.filter((request) => 'match' in request.questions && !(request.state as { candidate: { sourceType?: string } }).candidate.sourceType);
    expect(factRequests).toHaveLength(2);
  });
  test('the real answer reuses selected facts and still runs final generation and fidelity', async () => {
    const { store, source } = await fixture(); port();
    await store.upsertNode({ id: 'answer-fact', kind: 'fact', slug: 'recovery', title: 'Recovery procedure', summary: recovery, sourceId: source.id,
      status: 'active', metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact' } });
    const fake = port(); let generations = 0; const result = await answer(store, source, () => generations++);
    expect(result.answer.quality?.status).toBe('verified'); expect(generations).toBe(1);
    expect(fake.requests.filter((request) => 'match' in request.questions && !(request.state as { candidate: { sourceType?: string } }).candidate.sourceType)).toHaveLength(1);
    expect(fake.requests.some((request) => 'fidelity' in request.questions)).toBe(true);
  });
  test('late protected data in initial and linked-only selected content produces zero requests', async () => {
    for (const linked of [false, true]) for (const protectedText of ['Authorization: Bearer synthetic', '4111 1111 1111 1111']) {
      const { store, source } = await fixture(`${recovery}\n\n${'Ordinary context. '.repeat(10_000)}${protectedText}`);
      const { node } = await link(store, source); const fake = port(); const before = snapshot(store);
      await expect(linked ? includeOfficialLinkedEvidence(store, spaceId, query, [], [node], 10) : collect(store)).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
    }
  });
  test('linked-only preflight inspects later sources before any earlier source or fact reading', async () => {
    const { store, source } = await fixture(); const { node } = await link(store, source);
    const late = await store.upsertSource({ id: 'late-source', connectorId: 'synthetic', sourceType: 'manual', status: 'indexed', title: 'Late source',
      metadata: { knowledgeSpaceId: spaceId, sourceDiscovery: { linkedObjectIds: [node.id] } } });
    await store.upsertExtraction({ sourceId: late.id, extractorId: 'synthetic', format: 'text', excerpt: 'Authorization: Bearer synthetic', metadata: { knowledgeSpaceId: spaceId } });
    const fake = port(); await expect(includeOfficialLinkedEvidence(store, spaceId, query, [], [node], 10)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  for (const linked of [false, true]) for (const mutation of ['source', 'extraction', 'node', 'operator', 'edge'] as const) {
    test(`${linked ? 'linked-only' : 'initial'} ${mutation} change across excerpt awaits holds before ranking`, async () => {
      const { store, source, extraction } = await fixture(); const { node, edge } = await link(store, source); const fake = port(); let changed = false;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if (!changed && 'excerptUseful' in request.questions) {
          changed = true;
          if (mutation === 'source') await store.upsertSource({ ...source, summary: 'Concurrent correction.' });
          if (mutation === 'extraction') await store.upsertExtraction({ ...extraction, excerpt: 'The procedure has been withdrawn.' });
          if (mutation === 'node') await store.upsertNode({ ...node, aliases: ['Changed identity'] });
          if (mutation === 'operator') await reviewKnowledgeNodeRecord(store, { id: node.id, decision: 'reject', reviewer: 'excerpt-fixture' });
          if (mutation === 'edge') await store.upsertEdge({ ...edge, metadata: { ...edge.metadata, deleted: true } });
        }
        return result;
      } });
      await expect(linked ? includeOfficialLinkedEvidence(store, spaceId, query, [], [node], 10) : collect(store)).rejects.toMatchObject({ reason: 'stale' });
      expect(changed).toBe(true); expect(fake.requests.some((request) => 'match' in request.questions)).toBe(false); expect(store.listIssues()).toEqual([]);
    });
  }
  test('completed linked passes retain their own guard even without an initial pass', async () => {
    const { store, source, extraction } = await fixture(); const { node } = await link(store, source); port();
    const evidence = await includeOfficialLinkedEvidence(store, spaceId, query, [], [node], 10);
    await store.upsertExtraction({ ...extraction, excerpt: 'Changed after selection.' });
    expect(() => assertAnswerEvidenceCurrent(evidence)).toThrow();
  });
  test('final ranking and final fidelity cannot outlive the excerpt read-set or write gaps', async () => {
    for (const stage of ['match', 'enough'] as const) {
      const { store, source } = await fixture(); const { node, edge } = await link(store, source); const fake = port([recovery], { enough: 0.01 });
      let changed = false, generations = 0;
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if (!changed && stage in request.questions) { changed = true; await store.upsertEdge({ ...edge, metadata: { ...edge.metadata, deleted: true } }); }
        return result;
      } });
      await expect(answer(store, source, () => generations++)).rejects.toMatchObject({ reason: 'stale' });
      expect(changed).toBe(true); expect(generations).toBe(stage === 'match' ? 0 : 1);
      expect(store.listNodes().map((row) => row.id)).toEqual([node.id]); expect(store.listIssues()).toEqual([]);
    }
  });
  test('query changes after final ranking cannot reuse excerpts when object alignment is disabled', async () => {
    const { store, source } = await fixture(); const fake = port(); let generations = 0;
    const input = { query, knowledgeSpaceId: spaceId, candidateSourceIds: [source.id], strictCandidates: true, includeLinkedObjects: false };
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if ('match' in request.questions) input.query = 'What does a different product support?';
      return result;
    } });
    await expect(answerKnowledgeQuery({ store, llm: { async completeText() { generations++; return recovery; }, async completeJson() { return null; } } }, input)).rejects.toMatchObject({ reason: 'stale' });
    expect(generations).toBe(0); expect(store.listIssues()).toEqual([]);
  });
  test('uncertain, unavailable, malformed, aborted and over-budget excerpt passes spend no generation or gap writes', async () => {
    for (const mode of ['uncertain', 'unavailable', 'malformed', 'aborted', 'budget'] as const) {
      const { store, source } = await fixture(mode === 'budget' ? Array.from({ length: 101 }, (_, index) => `Paragraph ${index}`).join('\n\n') : recovery);
      const fake = port(); const controller = new AbortController(); const before = snapshot(store); let generations = 0;
      installJudgmentPort({ ...fake.port, async ask(request) {
        if ('excerptUseful' in request.questions) {
          if (mode === 'unavailable') throw new Error('Synthetic unavailable reader');
          if (mode === 'aborted') controller.abort();
          const result = await fake.port.ask(request);
          return { ...result, answers: { excerptUseful: noulAnswer(mode === 'malformed' ? NaN : mode === 'uncertain' ? 0.6 : 0.99) } } as typeof result;
        }
        return fake.port.ask(request);
      } });
      await expect(answer(store, source, () => generations++, controller.signal)).rejects.toMatchObject({ reason: mode });
      expect(generations).toBe(0); expect(snapshot(store)).toBe(before);
      expect(fake.requests.some((request) => 'match' in request.questions)).toBe(false);
    }
  });
});
