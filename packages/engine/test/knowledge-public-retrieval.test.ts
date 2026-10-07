import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { readPublicKnowledgeSelection, type PublicKnowledgeSelectionInput } from '../sdk/src/platform/knowledge/public-retrieval.js';
import type { KnowledgeNodeUpsertInput, KnowledgeSourceUpsertInput } from '../sdk/src/platform/knowledge/types.js';

const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const query = 'How do I restore network settings?';
const body = 'Hold the recessed switch for ten seconds to recover factory configuration.';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-public-retrieval-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init(); return store;
}
async function source(store: KnowledgeStore, id: string, text = body, extra: Partial<KnowledgeSourceUpsertInput> = {}) {
  const row = await store.upsertSource({ id, connectorId: 'synthetic', sourceType: 'document', title: id, status: 'indexed', ...extra });
  await store.upsertExtraction({ sourceId: row.id, extractorId: 'synthetic', format: 'text', excerpt: text, metadata: row.metadata });
  return row;
}
async function topic(store: KnowledgeStore, id: string, extra: Partial<KnowledgeNodeUpsertInput> = {}) {
  const input: KnowledgeNodeUpsertInput = { id, kind: 'topic', slug: id, title: id, summary: body, status: 'active', ...extra };
  const evidence = structuredClone(input);
  return upsertObservedKnowledgeNode(store, input, 'catalog-structure', evidence, () => evidence);
}
function readings(values: Readonly<Record<string, number>> = {}, excerpt = 0.99) {
  const fake = fakePort((name, _question, state) => {
    if (name === 'excerptUseful') return noulAnswer(excerpt);
    if (name !== 'useful') throw new Error(`Unexpected public retrieval reading: ${name}`);
    return noulAnswer(values[(state as { candidate: { title: string } }).candidate.title] ?? 0.01);
  });
  installJudgmentPort(fake.port); return fake;
}
function select(store: KnowledgeStore, extra: Partial<PublicKnowledgeSelectionInput> = {}) {
  return readPublicKnowledgeSelection(store, { query, scope: {}, mode: 'search', ...extra });
}

describe('generic public retrieval through shared readings', () => {
  test('contrary keyword/type/usage scores do not rescue a rejected source; probability ties retain ID order', async () => {
    const store = await fixture();
    await source(store, 'advertisement', 'Buy now.', { title: 'restore network settings official manual', sourceType: 'manual' });
    await source(store, 'z-recovery', body, { sourceType: 'other' }); await source(store, 'a-recovery');
    const fake = readings({ 'z-recovery': 0.99, 'a-recovery': 0.99 });
    const result = await select(store);
    expect(result.accepted.map((row) => row.id)).toEqual(['a-recovery', 'z-recovery']);
    expect(result.accepted.map((row) => row.probability)).toEqual([0.99, 0.99]);
    expect(fake.requests).toHaveLength(3); expect(store.listUsageRecords()).toEqual([]);
    result.assertCurrent();
  });
  test('reads every candidate beyond 100 and a multi-megabyte corpus without a global protection cap', async () => {
    const store = await fixture(); await source(store, 'last-useful');
    for (let index = 0; index < 104; index++) await source(store, `decoy-${index}`, index < 16 ? 'x'.repeat(128 * 1024) : 'Packaging color.');
    expect(store.listSources(Number.MAX_SAFE_INTEGER).findIndex((row) => row.id === 'last-useful')).toBeGreaterThanOrEqual(100);
    const fake = readings({ 'last-useful': 0.99 });
    const result = await select(store);
    expect(result.accepted.map((row) => row.id)).toEqual(['last-useful']); expect(fake.requests).toHaveLength(105);
    expect(fake.requests.every((request) => JSON.stringify(request.state).length < 160_000)).toBe(true);
  });
  test('default, all-space and structurally related scope retain generic admission', async () => {
    const store = await fixture(); const base = await source(store, 'base');
    const project = await source(store, 'project-source', body, { metadata: { knowledgeSpaceId: 'project:alpha' } });
    const implicit = await topic(store, 'implicit-topic');
    const related = await topic(store, 'related-topic', { sourceId: project.id });
    readings({ base: 0.99, 'project-source': 0.99, 'implicit-topic': 0.99, 'related-topic': 0.99 });
    expect((await select(store)).accepted.map((row) => row.id).sort()).toEqual([base.id, implicit.id].sort());
    expect((await select(store, { scope: { includeAllSpaces: true } })).accepted).toHaveLength(4);
    expect((await select(store, { scope: { knowledgeSpaceId: 'project:alpha' } })).accepted.map((row) => row.id).sort()).toEqual([project.id, related.id].sort());
  });
  test('search excludes stale sources and draft nodes while packet retains its existing policy and generated rows', async () => {
    const store = await fixture(); await source(store, 'stale', body, { status: 'stale' });
    await source(store, 'generated', body, { metadata: { generatedProjection: true } });
    await topic(store, 'draft', { status: 'draft' });
    readings({ stale: 0.99, generated: 0.99, draft: 0.99 });
    expect((await select(store)).accepted.map((row) => row.id)).toEqual(['generated']);
    expect((await select(store, { mode: 'packet' })).accepted.map((row) => row.id)).toEqual(['draft', 'generated', 'stale']);
  });
  test('foreign protected source is excluded, but a late admitted protected source prevents every dispatch', async () => {
    const store = await fixture();
    await source(store, 'foreign', 'Authorization: Bearer synthetic-foreign', { metadata: { knowledgeSpaceId: 'project:other' } });
    await source(store, 'good'); const fake = readings({ good: 0.99 });
    expect((await select(store)).accepted.map((row) => row.id)).toEqual(['good']);
    await source(store, 'late', `${'x'.repeat(128 * 1024)} Authorization: Bearer synthetic-late`);
    const next = readings({ good: 0.99 });
    await expect(select(store)).rejects.toBeInstanceOf(JudgmentInputError); expect(next.requests).toHaveLength(0);
    expect(fake.requests).toHaveLength(1);
  });
  test.each(['summary', 'nested', 'section'] as const)('hidden protected %s content cannot disappear during capture', async (field) => {
    const store = await fixture(); const row = await source(store, 'hidden');
    const extraction = store.getExtractionBySourceId(row.id)!;
    if (field === 'summary') Object.defineProperty(row, 'summary', { value: 'Authorization: Bearer synthetic-hidden', configurable: true });
    if (field === 'nested') Object.defineProperty(extraction.structure, 'metadata', { value: { content: 'Authorization: Bearer synthetic-hidden' }, configurable: true });
    if (field === 'section') Object.defineProperty(extraction.sections, '0', { value: 'Authorization: Bearer synthetic-hidden', configurable: true });
    const fake = readings({ hidden: 0.99 });
    await expect(select(store)).rejects.toBeInstanceOf(JudgmentInputError); expect(fake.requests).toHaveLength(0);
  });
  test('accessors never execute, including an accessor introduced during a request', async () => {
    const store = await fixture(); const row = await source(store, 'guarded'); let calls = 0;
    const fake = readings({ guarded: 0.99 });
    installJudgmentPort({ ...fake.port, async ask(request) {
      Object.defineProperty(row, 'summary', { get() { calls++; return 'unsafe'; }, configurable: true });
      return fake.port.ask(request);
    } });
    await expect(select(store)).rejects.toThrow(); expect(calls).toBe(0);
  });
  test('packet supplies complete write scope, folder path and exact full selected qualifiers', async () => {
    const store = await fixture(); const text = `${'Context. '.repeat(500)}Standby only; active use lasts two hours.`;
    const row = await source(store, 'qualified', text, { folderPath: 'packages/network/config' });
    const fake = readings({ qualified: 0.99 });
    const result = await select(store, { mode: 'packet', writeScope: ['packages/network/config'] });
    expect(result.accepted[0]!.spans?.some((span) => span.text === text && span.start === 0 && span.end === text.length)).toBe(true);
    const requests = JSON.stringify(fake.requests);
    expect(requests).toContain('packages/network/config'); expect(requests).toContain('Standby only; active use lasts two hours.');
    expect(requests).not.toContain(store.getExtractionBySourceId(row.id)!.id); result.assertCurrent();
    readings({ qualified: 0.99 }, 0.01);
    expect((await select(store, { mode: 'packet' })).accepted[0]!.spans).toEqual([]);
  });
  test('metadata claims and memory/catalog context survive without arbitrary metadata or local IDs', async () => {
    const store = await fixture(); await topic(store, 'private-node-key', { title: 'Recovery', summary: undefined,
      metadata: { text: body, tags: ['configuration'], scope: 'project', cls: 'procedure', privateInternal: 'DO_NOT_TRANSMIT', reviewState: 'operator-authorized' } });
    const fake = readings({ Recovery: 0.99 }); const result = await select(store, { mode: 'packet' });
    expect(result.accepted[0]!.nodeText).toContain(body); expect(result.accepted[0]!.nodeText).toContain('procedure');
    const wire = JSON.stringify(fake.requests);
    for (const hidden of ['private-node-key', 'DO_NOT_TRANSMIT', 'operator-authorized']) expect(wire).not.toContain(hidden);
  });
  test('related labels use captured scoped endpoints and remain contextual after the display cap', async () => {
    const store = await fixture(); const row = await source(store, 'manual');
    for (let index = 0; index < 10; index++) {
      const node = await topic(store, `related-${index}`);
      await store.upsertEdge({ fromKind: 'source', fromId: row.id, toKind: 'node', toId: node.id, relation: 'documents' });
    }
    const other = await topic(store, 'foreign-topic', { metadata: { knowledgeSpaceId: 'project:other' } });
    await store.upsertEdge({ fromKind: 'source', fromId: row.id, toKind: 'node', toId: other.id, relation: 'documents' });
    readings({ manual: 0.99 }); const result = await select(store);
    expect(result.relatedLabels('source', row.id)).toHaveLength(8);
    expect(result.relatedLabels('source', row.id)).not.toContain(other.title);
  });
  test('known foreign target keys stay local without lending foreign subject content', async () => {
    const store = await fixture();
    const other = await topic(store, 'foreign-private-key', { summary: 'Foreign private meaning.', metadata: { knowledgeSpaceId: 'project:other' } });
    await topic(store, 'claim', { metadata: { targetHints: [{ id: other.id, title: 'Requested target' }] } });
    const fake = readings({ claim: 0.99 }); await select(store);
    const wire = JSON.stringify(fake.requests);
    expect(wire).not.toContain(other.id); expect(wire).not.toContain('Foreign private meaning.');
    expect(wire).toContain('Requested target');
  });
  test('unknown external target identity retains the ordinary protected-input check', async () => {
    const store = await fixture();
    await topic(store, 'claim', { metadata: { targetHints: [{ id: 'Authorization: Bearer synthetic-external' }] } });
    const fake = readings({ claim: 0.99 });
    await expect(select(store)).rejects.toBeInstanceOf(JudgmentInputError); expect(fake.requests).toHaveLength(0);
  });
  test.each(['source', 'extraction', 'scope-edge', 'configuration', 'caller'] as const)('%s change prevents partial results and later batches', async (changed) => {
    const store = await fixture(); const row = await source(store, 'first', 'x'.repeat(128 * 1024));
    await source(store, 'second', 'x'.repeat(128 * 1024)); const fake = readings({ first: 0.99, second: 0.99 }); let invalid = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if (changed === 'source') (row as { summary: string }).summary = 'Concurrent correction.';
      if (changed === 'extraction') (store.getExtractionBySourceId(row.id)! as { excerpt: string }).excerpt = 'Concurrent correction.';
      if (changed === 'scope-edge') await store.upsertEdge({ fromKind: 'source', fromId: row.id, toKind: 'node', toId: 'missing', relation: 'documents' });
      if (changed === 'configuration') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
      invalid = true; return fake.port.ask(request);
    } });
    await expect(readPublicKnowledgeSelection(store, { query, scope: {}, mode: 'search' }, {
      assertCurrent() { if (changed === 'caller' && invalid) throw new Error('Caller options changed'); },
    })).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(1); expect(store.listUsageRecords()).toEqual([]);
  });
  test('caller cancellation aborts an ignored-signal provider and revokes completed selections', async () => {
    const store = await fixture(); await source(store, 'cancel'); const fake = readings({ cancel: 0.99 });
    const controller = new AbortController(); let runningSignal: AbortSignal | undefined;
    const started = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) { runningSignal = request.signal; started.resolve(); return new Promise(() => {}); } });
    const pending = select(store, { signal: controller.signal }); await started.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'aborted' }); expect(runningSignal?.aborted).toBe(true);
    readings({ cancel: 0.99 }); const settledController = new AbortController();
    const result = await select(store, { signal: settledController.signal }); result.assertCurrent(); settledController.abort();
    expect(() => result.assertCurrent()).toThrow('aborted');
  });
  test.each(['scope', 'writeScope', 'new-extraction'] as const)('%s mutation revokes packet before its next excerpt dispatch', async (changed) => {
    const store = await fixture(); const row = await store.upsertSource({ id: 'summary-only', connectorId: 'synthetic', sourceType: 'manual', title: 'Summary', summary: body, status: 'indexed' });
    const scope = { knowledgeSpaceId: 'default' }, writeScope = ['packages/network'];
    const fake = readings({ Summary: 0.99 }); let excerptRequests = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      if ('excerptUseful' in request.questions) {
        excerptRequests++;
        if (changed === 'scope') scope.knowledgeSpaceId = 'project:other';
        if (changed === 'writeScope') writeScope.push('packages/changed');
        if (changed === 'new-extraction') await store.upsertExtraction({ sourceId: row.id, extractorId: 'synthetic', format: 'text', excerpt: 'New extraction.' });
      }
      return fake.port.ask(request);
    } });
    await expect(select(store, { scope, writeScope, mode: 'packet' })).rejects.toMatchObject({ reason: 'stale' });
    expect(excerptRequests).toBe(1); expect(store.listUsageRecords()).toEqual([]);
  });
  test('late uncertain reading holds the complete pass; settled no stays empty', async () => {
    const store = await fixture(); await source(store, 'yes', 'x'.repeat(128 * 1024)); await source(store, 'uncertain', 'x'.repeat(128 * 1024));
    readings({ yes: 0.99, uncertain: 0.6 }); await expect(select(store)).rejects.toMatchObject({ reason: 'unsettled' });
    readings(); expect((await select(store)).accepted).toEqual([]); expect(store.listUsageRecords()).toEqual([]);
  });
});
