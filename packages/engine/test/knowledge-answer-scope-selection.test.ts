import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { assertAnswerEvidenceCurrent, collectAnswerEvidence, includeOfficialLinkedEvidence } from '../sdk/src/platform/knowledge/semantic/answer-evidence.js';
import { bindAnswerCandidateWindow } from '../sdk/src/platform/knowledge/semantic/answer-candidate-window.js';
import { readPublicKnowledgeSelection } from '../sdk/src/platform/knowledge/public-retrieval.js';
import type { KnowledgeNodeUpsertInput, KnowledgeSourceUpsertInput } from '../sdk/src/platform/knowledge/types.js';

const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const query = 'Restore the network settings.';
const body = 'Hold the recessed switch for ten seconds to recover factory configuration.';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-answer-scope-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init(); return store;
}
async function source(store: KnowledgeStore, id: string, title: string, extra: Partial<KnowledgeSourceUpsertInput> = {}) {
  const row = await store.upsertSource({ id, title, connectorId: 'synthetic', sourceType: 'document', summary: body, status: 'indexed', ...extra });
  await store.upsertExtraction({ sourceId: row.id, extractorId: 'synthetic', format: 'text', excerpt: body, metadata: row.metadata });
  return row;
}
async function node(store: KnowledgeStore, id: string, title: string, extra: Partial<KnowledgeNodeUpsertInput> = {}) {
  const input: KnowledgeNodeUpsertInput = { id, title, kind: 'topic', slug: id, summary: body, status: 'active', ...extra };
  const evidence = structuredClone(input);
  return upsertObservedKnowledgeNode(store, input, 'catalog-structure', evidence, () => evidence);
}
function readings() {
  const fake = fakePort((name, _question, state) => {
    if (name === 'included') {
      const scope = state as { view: 'ordinary' | 'explicit' | 'all'; candidate: { content: { title: string } } };
      // Explicit authored negatives are independent from relevance: a catalog
      // navigation descriptor belongs only to the requested all-space view.
      return noulAnswer(scope.view === 'all' || scope.candidate.content.title !== 'Catalog navigation' ? 0.99 : 0.01);
    }
    if (name === 'useful' || name === 'excerptUseful') return noulAnswer(0.99);
    throw new Error(`Unexpected scope consumer reading: ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
const collect = (store: KnowledgeStore, signal?: AbortSignal) => collectAnswerEvidence(store, { query }, 'default', 8, [], signal);

describe('retained scope at answer and public consumers', () => {
  test('scope no prevents relevance and excerpt dispatch for source and node descriptors', async () => {
    const store = await fixture();
    const useful = await source(store, 'useful-source', 'Network recovery');
    await source(store, 'catalog-source', 'Catalog navigation');
    await node(store, 'catalog-node', 'Catalog navigation');
    const fake = readings();
    const evidence = await collect(store);
    expect(evidence.map((item) => item.id)).toEqual([useful.id]);
    expect(fake.requests.filter((request) => 'included' in request.questions)).toHaveLength(3);
    const later = fake.requests.filter((request) => !('included' in request.questions));
    expect(JSON.stringify(later)).not.toContain('Catalog navigation');
    expect(later.some((request) => 'useful' in request.questions)).toBe(true);
    expect(later.some((request) => 'excerptUseful' in request.questions)).toBe(true);
    assertAnswerEvidenceCurrent(evidence);
  });
  test('linked phase carries the original scope rejection and cannot revive its source', async () => {
    const store = await fixture();
    const object = await node(store, 'object', 'Network controller');
    await source(store, 'catalog', 'Catalog navigation', { metadata: { sourceDiscovery: { linkedObjectIds: [object.id] } } });
    const fake = readings();
    const evidence = await collect(store);
    const before = fake.requests.filter((request) => 'included' in request.questions).length;
    const linked = await includeOfficialLinkedEvidence(store, 'default', query, evidence, [object], 8);
    expect(linked.some((item) => item.id === 'catalog')).toBe(false);
    expect(fake.requests.filter((request) => 'included' in request.questions)).toHaveLength(before);
    assertAnswerEvidenceCurrent(linked);
  });
  test('a retained private source window bounds scope preparation before its first dispatch', async () => {
    const store = await fixture(); const useful = await source(store, 'useful', 'Network recovery');
    await source(store, 'catalog', 'Catalog navigation');
    const input = { query };
    bindAnswerCandidateWindow(input, store, 'default', [useful.id], [], [], () => {});
    const fake = readings();
    const evidence = await collectAnswerEvidence(store, input, 'default', 8, []);
    expect(evidence.map((row) => row.id)).toEqual([useful.id]);
    expect(fake.requests.filter((request) => 'included' in request.questions)).toHaveLength(1);
    expect(JSON.stringify(fake.requests)).not.toContain('Catalog navigation');
    assertAnswerEvidenceCurrent(evidence);
  });
  test('packet ordinary rejects a descriptor while an explicit all-space reading can admit it', async () => {
    const store = await fixture(); await node(store, 'descriptor', 'Catalog navigation'); readings();
    const ordinary = await readPublicKnowledgeSelection(store, { query, scope: {}, mode: 'packet' });
    expect(ordinary.accepted).toEqual([]); ordinary.assertCurrent();
    const all = await readPublicKnowledgeSelection(store, { query, scope: { includeAllSpaces: true }, mode: 'packet' });
    expect(all.accepted.map((row) => row.id)).toEqual(['descriptor']); all.assertCurrent();
  });
  test('foreign edits preserve retained results, while a consumed correction retires them', async () => {
    const store = await fixture(); const useful = await source(store, 'useful', 'Network recovery');
    const foreign = await source(store, 'foreign', 'Unrelated project', { metadata: { knowledgeSpaceId: 'project:other' } });
    readings(); const evidence = await collect(store);
    const selection = await readPublicKnowledgeSelection(store, { query, scope: {}, mode: 'search' });
    await store.upsertSource({ ...foreign, summary: 'A different project correction.' });
    await source(store, 'another-foreign', 'Another unrelated project', { metadata: { knowledgeSpaceId: 'project:other' } });
    assertAnswerEvidenceCurrent(evidence); selection.assertCurrent();
    await store.upsertSource({ ...useful, summary: 'A consumed source correction.' });
    expect(() => assertAnswerEvidenceCurrent(evidence)).toThrow('stale');
    expect(() => selection.assertCurrent()).toThrow('stale');
  });
  test('cancellation releases an ignored-signal scope read before any relevance dispatch', async () => {
    const store = await fixture(); await source(store, 'useful', 'Network recovery');
    const fake = readings(); const controller = new AbortController(); const started = Promise.withResolvers<void>();
    let pendingSignal: AbortSignal | undefined;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (!('included' in request.questions)) throw new Error('Scope cancellation dispatched relevance');
      pendingSignal = request.signal; started.resolve(); return new Promise(() => {});
    } });
    const pending = collect(store, controller.signal); await started.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'aborted' }); expect(pendingSignal?.aborted).toBe(true);
    expect(fake.requests).toEqual([]);
  });
  test('public options signal and shouldStop remain attached after the completed budget', async () => {
    const store = await fixture(); await source(store, 'useful', 'Network recovery'); readings();
    let stopped = false;
    const selection = await readPublicKnowledgeSelection(store, { query, scope: {}, mode: 'search' }, { shouldStop: () => stopped });
    selection.assertCurrent(); stopped = true; expect(() => selection.assertCurrent()).toThrow('aborted');
    const controller = new AbortController();
    const cancellable = await readPublicKnowledgeSelection(store, { query, scope: {}, mode: 'search' }, { signal: controller.signal });
    cancellable.assertCurrent(); controller.abort(); expect(() => cancellable.assertCurrent()).toThrow('aborted');
  });
  test('public authority callbacks must return synchronous undefined before any dispatch', async () => {
    const store = await fixture(); await source(store, 'useful', 'Network recovery');
    const fake = readings();
    for (const assertCurrent of [async () => {}, async () => { throw new Error('Delayed authority rejection'); }, () => true]) {
      await expect(readPublicKnowledgeSelection(store, { query, scope: {}, mode: 'search' }, { assertCurrent }))
        .rejects.toMatchObject({ reason: 'stale' });
    }
    await Promise.resolve();
    expect(fake.requests).toEqual([]);
  });
  test('a caller correction to the original query after scope reading prevents every ranking dispatch', async () => {
    const store = await fixture(); await source(store, 'useful', 'Network recovery');
    const input = { query, scope: {}, mode: 'search' as const };
    const fake = readings(); let scopeAnswered = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if ('included' in request.questions) scopeAnswered = true;
      return result;
    } });
    await expect(readPublicKnowledgeSelection(store, input, { assertCurrent() {
      if (scopeAnswered) input.query = 'A corrected original question.';
    } })).rejects.toMatchObject({ reason: 'stale' });
    expect(scopeAnswered).toBe(true);
    expect(fake.requests.filter(request => 'useful' in request.questions)).toEqual([]);
    expect(store.listUsageRecords()).toEqual([]);
  });
  test('a late request getter holds before evaluation or a ranking request', async () => {
    const store = await fixture(); await source(store, 'useful', 'Network recovery');
    const input = { query, scope: {}, mode: 'search' as const };
    const fake = readings(); let scopeAnswered = false, getterInstalled = false, getterCalls = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if ('included' in request.questions) scopeAnswered = true;
      return result;
    } });
    await expect(readPublicKnowledgeSelection(store, input, { assertCurrent() {
      if (scopeAnswered && !getterInstalled) {
        Object.defineProperty(input, 'query', { get() { getterCalls++; return query; } });
        getterInstalled = true;
      }
    } })).rejects.toMatchObject({ reason: 'stale' });
    expect(getterCalls).toBe(0);
    expect(fake.requests.filter(request => 'useful' in request.questions)).toEqual([]);
    expect(store.listUsageRecords()).toEqual([]);
  });
  test('hidden named work-scope changes in the owner callback retire the original request', async () => {
    const store = await fixture(); await source(store, 'useful', 'Network recovery');
    const input = { query, writeScope: ['packages/network'], scope: {}, mode: 'search' as const };
    const fake = readings(); let scopeAnswered = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if ('included' in request.questions) scopeAnswered = true;
      return result;
    } });
    await expect(readPublicKnowledgeSelection(store, input, { assertCurrent() {
      if (scopeAnswered) Object.defineProperty(input.writeScope, 'additionalMeaning', { value: 'A different original work scope', configurable: true });
    } })).rejects.toMatchObject({ reason: 'stale' });
    expect(scopeAnswered).toBe(true);
    expect(fake.requests.filter(request => 'useful' in request.questions)).toEqual([]);
    expect(store.listUsageRecords()).toEqual([]);
  });
  test('a caller correction to an empty original query cannot publish an empty selection', async () => {
    const store = await fixture(); const fake = readings();
    const input = { query: '', scope: {}, mode: 'search' as const };
    await expect(readPublicKnowledgeSelection(store, input, { assertCurrent() {
      input.query = query;
    } })).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toEqual([]);
    expect(store.listUsageRecords()).toEqual([]);
  });
  test('a caller correction to the original query holds before store initialization', async () => {
    const store = await fixture(); const fake = readings();
    const input = { query, scope: {}, mode: 'search' as const };
    const init = store.init.bind(store); let initializations = 0;
    store.init = async () => { initializations++; await init(); };
    await expect(readPublicKnowledgeSelection(store, input, { assertCurrent() {
      input.query = 'A corrected original question.';
    } })).rejects.toMatchObject({ reason: 'stale' });
    expect(initializations).toBe(0);
    expect(fake.requests).toEqual([]);
    expect(store.listUsageRecords()).toEqual([]);
  });
  test.each(['source', 'extraction'] as const)('a %s correction during scope initialization prevents adoption and every dispatch', async (kind) => {
    const store = await fixture(); const useful = await source(store, 'useful', 'Network recovery');
    const fake = readings(); const init = store.init.bind(store); let calls = 0;
    store.init = async () => {
      await init();
      if (++calls !== 2) return;
      if (kind === 'source') await store.upsertSource({ ...useful, summary: 'A corrected recovery procedure.' });
      else await store.upsertExtraction({ ...store.getExtractionBySourceId(useful.id)!, excerpt: 'A corrected recovery procedure.' });
    };
    await expect(readPublicKnowledgeSelection(store, { query, scope: {}, mode: 'search' })).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toEqual([]);
  });
});
