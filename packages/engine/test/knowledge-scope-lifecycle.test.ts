import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindJudgmentPortAuthority, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { prepareKnowledgeScopeSelection, KnowledgeScopeSelectionHeldError } from '../sdk/src/platform/knowledge/scope-selection.js';
import { collectCandidateGaps } from '../sdk/src/platform/knowledge/semantic/self-improvement-gap-context.js';
import { enrichKnowledgeSource } from '../sdk/src/platform/knowledge/semantic/enrichment.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { isKnowledgeSourceQualityFailure } from '../sdk/src/platform/knowledge/source-quality.js';
import { buildKnowledgeSemanticGraphIndex } from '../sdk/src/platform/knowledge/semantic/graph-index.js';
import { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { createSchema } from '../sdk/src/platform/knowledge/store-schema.js';
import { validateKnowledgeEdgeChanges } from '../sdk/src/platform/knowledge/store-edge-generations.js';

const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-scope-lifecycle-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath }); await store.init();
  const source = await store.upsertSource({ id: 'scope-source', connectorId: 'synthetic', sourceType: 'document',
    title: 'Home Assistant navigation design', description: 'An authored application design guide.', status: 'indexed',
    metadata: { knowledgeSpaceId: 'default', privateMetadata: 'NEVER_TRANSMIT_PRIVATE_METADATA' } });
  return { store, source, dbPath };
}
function snapshot(store: KnowledgeStore) {
  return JSON.stringify({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(),
    issues: store.listIssues(), extractions: store.listExtractions(), tasks: store.listRefinementTasks() });
}
function heldReading() {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.99)); const records: string[] = [];
  let signal: AbortSignal | undefined;
  const port: JudgmentPort = { model: fake.port.model, async ask(request) {
    signal = request.signal; entered.resolve();
    try { await release.promise; return { ...await fake.port.ask(request), decisionId: 'scope-fixture' }; }
    finally { finished.resolve(); }
  }, recorder: { recordReadings() { records.push('readings'); }, recordAction() { records.push('action'); } } };
  return { port, entered, release, finished, records, get signal() { return signal; } };
}
async function promptly<T>(promise: Promise<T>): Promise<T | symbol> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<symbol>(resolve => { timer = setTimeout(() => resolve(Symbol('did not stop')), 250); })]); }
  finally { clearTimeout(timer); }
}

describe('canonical knowledge scope lifecycle', () => {
  test('complete authored readings override titles and retain namespace authority', async () => {
    const { store, source } = await fixture();
    const rejected = await store.upsertSource({ id: 'rejected', connectorId: 'synthetic', sourceType: 'document',
      title: 'Ordinary project handbook', description: 'Only saved-search controls and repository website chrome.', status: 'indexed' });
    const foreign = await store.upsertSource({ id: 'foreign', connectorId: 'synthetic', sourceType: 'manual', title: 'FOREIGN_CONTENT', status: 'indexed',
      metadata: { knowledgeSpaceId: 'homeassistant:another-house' } });
    const fake = fakePort((_name, _question, state) => noulAnswer(typeof state === 'object' && state !== null && 'candidate' in state
      && JSON.stringify(state.candidate).includes('An authored application design guide.') ? 0.99 : 0.01));
    installJudgmentPort(fake.port);
    const selection = await prepareKnowledgeScopeSelection(store);
    expect(selection.sources.map(record => record.id)).toEqual([source.id]);
    expect(selection.source(rejected)).toBe(false); expect(selection.source(foreign)).toBe(false);
    expect(fake.requests).toHaveLength(2);
    expect(JSON.stringify(fake.requests)).not.toContain('NEVER_TRANSMIT_PRIVATE_METADATA');
    expect(JSON.stringify(fake.requests)).not.toContain('FOREIGN_CONTENT');
    expect(JSON.stringify(fake.requests)).not.toContain(source.id);
    expect(Object.isFrozen(selection.sources)).toBe(true);
  });

  test('explicit extension membership needs no semantic port and cannot enter ordinary scope', async () => {
    const { store } = await fixture();
    const source = await store.upsertSource({ id: 'extension-source', connectorId: 'synthetic', sourceType: 'manual', title: 'Lamp installation', status: 'indexed',
      metadata: { knowledgeSpaceId: 'homeassistant:house' } });
    const selection = await prepareKnowledgeScopeSelection(store, { knowledgeSpaceId: 'homeassistant:house' }, { kinds: ['source'] });
    expect(selection.sources.map(record => record.id)).toEqual([source.id]);
    const yes = fakePort(() => noulAnswer(0.99)); installJudgmentPort(yes.port);
    expect((await prepareKnowledgeScopeSelection(store)).source(source)).toBe(false);
    expect(yes.requests).toHaveLength(1);
  });

  test.each(['missing', 'uncertain', 'outage', 'malformed'] as const)('%s holds before any persisted enrichment or fallback', async (mode) => {
    const { store, source } = await fixture();
    await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text',
      excerpt: 'Restore the committed queue before starting workers. Replay the durable outbox before new events.', metadata: { knowledgeSpaceId: 'default' } });
    if (mode !== 'missing') {
      const fake = fakePort(() => noulAnswer(mode === 'uncertain' ? 0.5 : 0.99));
      installJudgmentPort({ ...fake.port, async ask(request) {
        if (mode === 'outage') throw new Error('Synthetic unavailable scope reader');
        const result = await fake.port.ask(request);
        if (mode === 'malformed') Object.assign(result.answers, { included: { noul: 2 } });
        return result;
      } });
    }
    const before = snapshot(store);
    await expect(enrichKnowledgeSource({ store }, source, { force: true })).rejects.toMatchObject({ reason: mode === 'missing' || mode === 'outage' ? 'unavailable' : mode });
    expect(snapshot(store)).toBe(before); expect(store.getSemanticEnrichmentState(source.id)).toBeNull();
    expect(isKnowledgeSourceQualityFailure(new KnowledgeScopeSelectionHeldError('uncertain'))).toBe(true);
  });

  for (const stop of ['caller abort', 'port retirement', 'source authority retirement'] as const) {
    test(`${stop} promptly stops an ignoring transport with zero late records`, async () => {
      const { store } = await fixture(); const held = heldReading(); const caller = new AbortController(), sourceAuthority = new AbortController();
      bindJudgmentPortAuthority(held.port, () => ({ identity: held, signal: sourceAuthority.signal, assertCurrent() { sourceAuthority.signal.throwIfAborted(); } }));
      installJudgmentPort(held.port);
      const before = snapshot(store);
      const pending = prepareKnowledgeScopeSelection(store, {}, { signal: caller.signal }).then(() => null, error => error);
      try {
        await held.entered.promise;
        if (stop === 'caller abort') caller.abort();
        else if (stop === 'port retirement') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
        else sourceAuthority.abort();
        expect(await promptly(pending)).toBeInstanceOf(KnowledgeScopeSelectionHeldError);
        expect(held.signal?.aborted).toBe(true);
        held.release.resolve(); await held.finished.promise;
        expect(held.records).toEqual([]); expect(snapshot(store)).toBe(before);
      } finally { held.release.resolve(); await pending; }
    });
  }

  test.each(['source replacement', 'request mutation', 'caller revocation'] as const)('%s during reading prevents consumption and recording', async (change) => {
    const { store, source } = await fixture(); const held = heldReading(); installJudgmentPort(held.port);
    const scope = { knowledgeSpaceId: 'default' }; let current = true;
    const pending = prepareKnowledgeScopeSelection(store, scope, { assertCurrent() { if (!current) throw new Error('caller retired'); } });
    await held.entered.promise;
    if (change === 'source replacement') await store.upsertSource({ ...source, title: 'Changed source content' });
    else if (change === 'request mutation') scope.knowledgeSpaceId = 'homeassistant:house';
    else current = false;
    const afterChange = snapshot(store); held.release.resolve();
    await expect(pending).rejects.toMatchObject({ reason: 'stale' });
    expect(held.records).toEqual([]); expect(snapshot(store)).toBe(afterChange);
  });

  test('settled reading retires after source replace-and-restore and provider restoration', async () => {
    const { store, source } = await fixture(); const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const selection = await prepareKnowledgeScopeSelection(store);
    await store.upsertSource({ ...source, title: 'Temporary replacement' }); await store.replaceSourceRecord(source);
    expect(() => selection.assertCurrent()).toThrow('Knowledge scope selection held: stale');
    const fresh = await prepareKnowledgeScopeSelection(store);
    installJudgmentPort(undefined); installJudgmentPort(fake.port);
    expect(() => fresh.source(store.getSource(source.id)!)).toThrow('Knowledge scope selection held: stale');
  });

  test('a separate persisted writer cannot lend newer SQL authority to the old cached source', async () => {
    const { store, source, dbPath } = await fixture();
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    const selection = await prepareKnowledgeScopeSelection(store);
    const writer = new KnowledgeStore({ dbPath }); await writer.init();
    await writer.upsertSource({ ...source, title: 'Externally replaced source content' });
    expect(selection.assertCurrent).toThrow('Knowledge scope selection held: stale');
    await expect(prepareKnowledgeScopeSelection(store)).rejects.toMatchObject({ reason: 'stale' });
  });

  test('new foreign associations cannot override retained explicit namespace membership', async () => {
    const { store, source } = await fixture();
    const input = { id: 'scope-topic', kind: 'topic' as const, slug: 'scope-topic', title: 'Queue design', sourceId: source.id, status: 'active' as const };
    const node = await upsertObservedKnowledgeNode(store, input, 'catalog-structure', input, () => input);
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const selection = await prepareKnowledgeScopeSelection(store);
    const foreign = await store.upsertSource({ id: 'new-foreign', connectorId: 'synthetic', sourceType: 'manual', status: 'indexed', metadata: { knowledgeSpaceId: 'homeassistant:house' } });
    await store.upsertEdge({ fromKind: 'source', fromId: foreign.id, toKind: 'node', toId: node.id, relation: 'describes', metadata: { knowledgeSpaceId: 'homeassistant:house' } });
    expect(() => selection.node(node)).toThrow('Knowledge scope selection held: stale');
  });

  test('unrelated foreign changes do not retire the consumed scope content', async () => {
    const { store, source } = await fixture();
    const foreign = await store.upsertSource({ id: 'irrelevant-foreign', connectorId: 'synthetic', sourceType: 'manual', title: 'Other house manual', status: 'indexed', metadata: { knowledgeSpaceId: 'homeassistant:house' } });
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    const selection = await prepareKnowledgeScopeSelection(store);
    await store.upsertSource({ ...foreign, title: 'Other house updated manual' });
    expect(selection.source(source)).toBe(true);
  });

  test('a later protected candidate is rejected before the first provider dispatch', async () => {
    const { store } = await fixture();
    await store.upsertSource({ id: 'protected-source', connectorId: 'synthetic', sourceType: 'document',
      title: 'Payment reference 4111111111111111', status: 'indexed' });
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    await expect(prepareKnowledgeScopeSelection(store)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });

  test('an asynchronous caller authority cannot authorize a dispatch or record', async () => {
    const { store } = await fixture();
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const authority = Promise.withResolvers<void>();
    await expect(prepareKnowledgeScopeSelection(store, {}, { assertCurrent: () => authority.promise })).rejects.toMatchObject({ reason: 'stale' });
    authority.reject(new Error('Synthetic asynchronous authority revoked'));
    expect(fake.requests).toHaveLength(0);
  });

  test('prepared input authority runs once and rejects an asynchronous grant before dispatch', async () => {
    const { store } = await fixture();
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    let preparations = 0;
    const selection = await prepareKnowledgeScopeSelection(store, {}, { assertPreparedInputCurrent() { preparations++; } });
    selection.assertCurrent(); selection.source(selection.sources[0]!);
    expect(preparations).toBe(1);
    const requests = fake.requests.length;
    const authority = Promise.withResolvers<void>();
    await expect(prepareKnowledgeScopeSelection(store, {}, { assertPreparedInputCurrent: () => authority.promise })).rejects.toMatchObject({ reason: 'stale' });
    authority.reject(new Error('Synthetic prepared input authority revoked'));
    expect(fake.requests).toHaveLength(requests);
  });

  test('named semantic array fields added during a reading retire the original input', async () => {
    const { store, source } = await fixture();
    const held = heldReading(); installJudgmentPort(held.port);
    const pending = prepareKnowledgeScopeSelection(store);
    await held.entered.promise;
    Object.defineProperty(source.tags, 'protectedExtra', { value: '4111111111111111', enumerable: true });
    held.release.resolve();
    await expect(pending).rejects.toMatchObject({ reason: 'stale' });
    expect(held.records).toEqual([]);
  });

  test('complete source extraction is read and its original version is retained', async () => {
    const { store, source } = await fixture();
    await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text',
      excerpt: 'Actual authored body. The durable outbox replays committed events before the workers start.' });
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const selection = await prepareKnowledgeScopeSelection(store);
    expect(JSON.stringify(fake.requests)).toContain('Actual authored body.');
    await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: 'Replaced original source body.' });
    expect(selection.assertCurrent).toThrow('Knowledge scope selection held: stale');
  });

  test('foreign associated content cannot lend semantic meaning to an ordinary source', async () => {
    const { store, source } = await fixture();
    const foreign = await store.upsertSource({ id: 'foreign-related', connectorId: 'synthetic', sourceType: 'manual',
      title: 'Foreign confidential content 4111111111111111', status: 'indexed', metadata: { knowledgeSpaceId: 'homeassistant:house' } });
    await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'source', toId: foreign.id,
      relation: 'references', metadata: { knowledgeSpaceId: 'default' } });
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const selection = await prepareKnowledgeScopeSelection(store);
    expect(selection.source(source)).toBe(true);
    expect(JSON.stringify(fake.requests)).not.toContain('Foreign confidential content');
    expect(JSON.stringify(fake.requests)).toContain('outsideRequestedScope');
  });

  test('candidate gap selection uses the retained semantic result and has no title fallback', async () => {
    const { store } = await fixture();
    const input = { id: 'ordinary-gap', kind: 'knowledge_gap' as const, slug: 'ordinary-gap', title: 'Ordinary queue handbook gap',
      summary: 'No grounded project evidence supports automatic repair.', status: 'active' as const, metadata: { knowledgeSpaceId: 'default' } };
    await upsertObservedKnowledgeNode(store, input, 'research-task', input, () => input);
    const fake = fakePort((_name, _question, state) => noulAnswer(typeof state === 'object' && state !== null && 'candidate' in state
      && JSON.stringify(state.candidate).includes('Ordinary queue handbook gap') ? 0.01 : 0.99));
    installJudgmentPort(fake.port);
    const selection = await collectCandidateGaps(store, 'default', null, null);
    expect(selection.gaps).toEqual([]); selection.assertCurrent();
    installJudgmentPort(undefined);
    expect(selection.assertCurrent).toThrow('Knowledge scope selection held: stale');
  });

  test.each(['cached', 'persisted'] as const)('%s relationship replacement retires the exact semantic graph input', async (mode) => {
    const { store, source, dbPath } = await fixture();
    const input = { id: 'edge-topic', kind: 'topic' as const, slug: 'edge-topic', title: 'Durable queue',
      sourceId: source.id, status: 'active' as const, metadata: { knowledgeSpaceId: 'default' } };
    const node = await upsertObservedKnowledgeNode(store, input, 'catalog-structure', input, () => input);
    const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id,
      relation: 'describes', weight: 0.8, metadata: { knowledgeSpaceId: 'default' } });
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    const graph = await buildKnowledgeSemanticGraphIndex(store, 'default');
    const writer = mode === 'persisted' ? new KnowledgeStore({ dbPath }) : store;
    await writer.init();
    await writer.replaceEdgeRecord({ ...edge, relation: 'contradicts', weight: 0.1 });
    expect(graph.assertCurrent).toThrow('Knowledge scope selection held: stale');
  });

  test.each(['cached', 'persisted'] as const)('%s new relationship inside original endpoints retires the graph input', async mode => {
    const { store, source, dbPath } = await fixture();
    const input = { id: 'addition-topic', kind: 'topic' as const, slug: 'addition-topic', title: 'Durable queue',
      sourceId: source.id, status: 'active' as const, metadata: { knowledgeSpaceId: 'default' } };
    const node = await upsertObservedKnowledgeNode(store, input, 'catalog-structure', input, () => input);
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    const graph = await buildKnowledgeSemanticGraphIndex(store, 'default');
    const writer = mode === 'persisted' ? new KnowledgeStore({ dbPath }) : store;
    await writer.init();
    await writer.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id,
      relation: 'contradicts', weight: 0.1, metadata: { knowledgeSpaceId: 'default' } });
    expect(graph.assertCurrent).toThrow('Knowledge scope selection held: stale');
  });

  test('new output-only endpoints do not rebase or retire the retained graph inputs', async () => {
    const { store, source } = await fixture();
    const input = { id: 'input-topic', kind: 'topic' as const, slug: 'input-topic', title: 'Durable queue',
      sourceId: source.id, status: 'active' as const, metadata: { knowledgeSpaceId: 'default' } };
    const node = await upsertObservedKnowledgeNode(store, input, 'catalog-structure', input, () => input);
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    const graph = await buildKnowledgeSemanticGraphIndex(store, 'default', { nodeIds: [node.id] });
    const output = { id: 'output-gap', kind: 'knowledge_gap' as const, slug: 'output-gap', title: 'New refinement output',
      sourceId: source.id, status: 'active' as const, metadata: { knowledgeSpaceId: 'default' } };
    const gap = await upsertObservedKnowledgeNode(store, output, 'research-task', output, () => output);
    await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: gap.id,
      relation: 'has_gap', metadata: { knowledgeSpaceId: 'default' } });
    graph.assertCurrent();
    expect(graph.nodesById.has(gap.id)).toBe(false);
  });

  test.each(['replacement', 'addition'] as const)('persisted incident windows permit unrelated writes and reject primary %s', async mode => {
    const { store, source, dbPath } = await fixture();
    const other = await store.upsertSource({ id: 'other-input', connectorId: 'synthetic', sourceType: 'document',
      title: 'Other retained handbook', status: 'indexed', metadata: { knowledgeSpaceId: 'default' } });
    const input = { id: 'incident-topic', kind: 'topic' as const, slug: 'incident-topic', title: 'Durable queue',
      sourceId: source.id, status: 'active' as const, metadata: { knowledgeSpaceId: 'default' } };
    const node = await upsertObservedKnowledgeNode(store, input, 'catalog-structure', input, () => input);
    const primary = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id,
      relation: 'describes', weight: 0.8, metadata: { knowledgeSpaceId: 'default' } });
    const unrelated = await store.upsertEdge({ fromKind: 'source', fromId: other.id, toKind: 'node', toId: node.id,
      relation: 'references', metadata: { knowledgeSpaceId: 'default' } });
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    const selection = await prepareKnowledgeScopeSelection(store);
    const assertEdgesCurrent = selection.retainEdges([primary], { incidentTo: [{ kind: 'source', id: source.id }] });
    const writer = new KnowledgeStore({ dbPath }); await writer.init();
    await writer.replaceEdgeRecord({ ...unrelated, relation: 'contradicts' });
    selection.assertCurrent(); assertEdgesCurrent();
    if (mode === 'replacement') await writer.replaceEdgeRecord({ ...primary, relation: 'contradicts', weight: 0.1 });
    else await writer.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'source', toId: other.id,
      relation: 'references', metadata: { knowledgeSpaceId: 'default' } });
    expect(assertEdgesCurrent).toThrow('Knowledge scope selection held: stale');
  });

  test.each(['replace and restore', 'add and delete', 'move in and out'] as const)('direct separate SQL writer %s retires the original edge window', async mode => {
    const { store, source, dbPath } = await fixture();
    const input = { id: 'aba-topic', kind: 'topic' as const, slug: 'aba-topic', title: 'Durable queue',
      sourceId: source.id, status: 'active' as const, metadata: { knowledgeSpaceId: 'default' } };
    const node = await upsertObservedKnowledgeNode(store, input, 'catalog-structure', input, () => input);
    const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id,
      relation: 'describes', weight: 0.8, metadata: { knowledgeSpaceId: 'default' } });
    const outside = await store.upsertEdge({ fromKind: 'source', fromId: 'outside-source', toKind: 'node', toId: 'outside-node', relation: 'references' });
    installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
    const selection = await prepareKnowledgeScopeSelection(store);
    const assertEdgesCurrent = selection.retainEdges([edge]);
    const original = store.getEdgeSnapshot(edge.id);
    const writer = new SQLiteStore(dbPath, { coordinated: true });
    try {
      await writer.init(createSchema, { schemaVersion: 10, validateCurrentSchema: validateKnowledgeEdgeChanges });
      if (mode === 'replace and restore') {
        writer.run("UPDATE knowledge_edges SET relation='contradicts' WHERE id=?", [edge.id]); await writer.save();
        writer.run('UPDATE knowledge_edges SET relation=? WHERE id=?', [edge.relation, edge.id]); await writer.save();
      } else if (mode === 'add and delete') {
        writer.run(`INSERT INTO knowledge_edges(id,from_kind,from_id,to_kind,to_id,relation,weight,metadata,created_at,updated_at)
          SELECT 'temporary-edge',from_kind,from_id,to_kind,to_id,'references',weight,metadata,created_at,updated_at FROM knowledge_edges WHERE id=?`, [edge.id]);
        await writer.save(); writer.run("DELETE FROM knowledge_edges WHERE id='temporary-edge'"); await writer.save();
      } else {
        writer.run('UPDATE knowledge_edges SET from_id=?,to_id=? WHERE id=?', [source.id, node.id, outside.id]); await writer.save();
        writer.run('UPDATE knowledge_edges SET from_id=?,to_id=? WHERE id=?', [outside.fromId, outside.toId, outside.id]); await writer.save();
      }
      expect(store.getEdgeSnapshot(edge.id).raw).toEqual(original.raw);
      expect(store.listEdges().find(record => record.id === edge.id)).toBe(edge);
      expect(assertEdgesCurrent).toThrow('Knowledge scope selection held: stale');
    } finally { writer.close(); }
  });

  test('new contextual associations during a reading retire its exact semantic input', async () => {
    const { store, source } = await fixture();
    const other = await store.upsertSource({ id: 'new-context', connectorId: 'synthetic', sourceType: 'document', title: 'New contextual handbook', status: 'indexed' });
    const input = { id: 'context-topic', kind: 'topic' as const, slug: 'context-topic', title: 'Durable queue',
      sourceId: source.id, status: 'active' as const, metadata: { knowledgeSpaceId: 'default' } };
    const node = await upsertObservedKnowledgeNode(store, input, 'catalog-structure', input, () => input);
    const held = heldReading(); installJudgmentPort(held.port);
    const pending = prepareKnowledgeScopeSelection(store, {}, { kinds: ['node'], nodeIds: [node.id] });
    await held.entered.promise;
    await store.upsertEdge({ fromKind: 'source', fromId: other.id, toKind: 'node', toId: node.id, relation: 'references' });
    held.release.resolve();
    await expect(pending).rejects.toMatchObject({ reason: 'stale' });
    expect(held.records).toEqual([]);
  });

  test.each(['cached', 'persisted'] as const)('%s open incident guard retains stable missing links and retires additions without lending content', async mode => {
    const { store, source, dbPath } = await fixture();
    await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: 'original-missing', relation: 'documents' });
    const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
    const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
    const window = { incidentTo: [{ kind: 'source' as const, id: source.id }], includeUnselectedEndpoints: true };
    const assertEdgesCurrent = selection.retainEdges(selection.edges, window);
    assertEdgesCurrent(); expect(selection.edges).toEqual([]);
    expect(JSON.stringify(fake.requests)).not.toContain('original-missing');
    const writer = mode === 'persisted' ? new KnowledgeStore({ dbPath }) : store; await writer.init();
    await writer.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: 'new-missing', relation: 'documents',
      metadata: { privateBody: '4111111111111111' } });
    expect(assertEdgesCurrent).toThrow('Knowledge scope selection held: stale');
    expect(JSON.stringify(fake.requests)).not.toContain('4111111111111111');
  });

  test('version nine migration retains original graph rows and establishes durable edge history', async () => {
    const { store, source, dbPath } = await fixture();
    const edge = await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: 'legacy-missing', relation: 'documents' });
    await store.close();
    const legacy = new SQLiteStore(dbPath, { coordinated: true });
    try {
      await legacy.init(createSchema, { schemaVersion: 10, validateCurrentSchema: validateKnowledgeEdgeChanges });
      legacy.run('DROP TRIGGER knowledge_edge_change_insert'); legacy.run('DROP TRIGGER knowledge_edge_change_delete');
      legacy.run('DROP TRIGGER knowledge_edge_change_update'); legacy.run('DROP TABLE knowledge_edge_changes');
      legacy.run('PRAGMA user_version=9'); await legacy.save();
    } finally { legacy.close(); }
    const migrated = new KnowledgeStore({ dbPath });
    try {
      await migrated.init();
      expect(migrated.getSource(source.id)).toEqual(source);
      expect(migrated.listEdges()).toEqual([edge]);
      expect(migrated.getEdgeWindowGeneration([`source:${source.id}`, 'node:legacy-missing'])).not.toBe('0');
      const original = migrated.getEdgeSnapshot(edge.id).generation;
      await migrated.replaceEdgeRecord({ ...edge, relation: 'references' }); await migrated.replaceEdgeRecord(edge);
      expect(migrated.getEdgeSnapshot(edge.id).generation).not.toBe(original);
    } finally { await migrated.close(); }
  });
});
