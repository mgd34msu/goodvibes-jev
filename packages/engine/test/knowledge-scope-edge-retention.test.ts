import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { prepareKnowledgeScopeSelection, KnowledgeScopeSelectionHeldError } from '../sdk/src/platform/knowledge/scope-selection.js';
import { registerGeneratedKnowledgeSourceReferences } from '../sdk/src/platform/knowledge/source-structural-references.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-edge-retention-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  await store.init();
  const sources = await Promise.all(['first', 'second'].map(id => store.upsertSource({ id,
    connectorId: 'synthetic', sourceType: 'document', title: `${id} queue handbook`, status: 'indexed' })));
  const first = sources[0], second = sources[1];
  if (!first || !second) throw new Error('Missing native source fixture');
  const edges = [await store.upsertEdge({ fromKind: 'source', fromId: first.id, toKind: 'source', toId: second.id,
    relation: 'references', weight: 0.8, metadata: { details: { label: 'complete original' } } }),
  await store.upsertEdge({ fromKind: 'source', fromId: second.id, toKind: 'source', toId: first.id,
    relation: 'describes', weight: 0.6, metadata: { details: { label: 'opposing original' } } })];
  const fake = fakePort(() => noulAnswer(0.99)); installJudgmentPort(fake.port);
  const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source'] });
  const records = [...edges], window = { sourceIds: sources.map(source => source.id) };
  const current = selection.retainEdges(records, window);
  return { store, edges, records, window, current, fake, selection };
}

async function recordFixture(registerBeforeSelection = false) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-signature-retention-')); roots.push(root);
  let store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const originalSource = await store.upsertSource({ id: 'reference', connectorId: 'synthetic', sourceType: 'document',
    title: 'Device reference', description: 'The reference explains the device connections.', status: 'indexed',
    canonicalUri: 'https://example.com/device-reference', sourceUri: 'https://example.com/device-source',
    metadata: { value: { first: 'original', second: 'complete' }, notes: 'unconsumed original' } });
  const originalExtraction = await store.upsertExtraction({ sourceId: originalSource.id, extractorId: 'synthetic', format: 'text',
    excerpt: 'The device connects to two controllers.', sections: ['Original connections'], structure: { text: 'Original reference text.' } });
  const originalNode = await store.upsertNode({ id: 'device', kind: 'knowledge_entity', slug: 'device', title: 'Device connections',
    summary: 'The device reference explains its controller connections.', sourceId: originalSource.id,
    metadata: { value: { first: 'original', second: 'complete' } } });
  await store.close();
  store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store); await store.init();
  const source = store.getSource(originalSource.id), extraction = store.getExtraction(originalExtraction.id), node = store.getNode(originalNode.id);
  if (!source || !extraction || !node) throw new Error('Missing original reopened native records');
  const canonicalUri = source.canonicalUri;
  if (canonicalUri === undefined) throw new Error('Missing original native source URI');
  if (registerBeforeSelection) registerGeneratedKnowledgeSourceReferences(store, source, {
    id: source.id, canonicalUri, sourceUri: source.sourceUri,
  });
  const fake = fakePort((name, _question, state) => {
    const candidate = state && typeof state === 'object' && !Array.isArray(state) ? state.candidate : undefined;
    const content = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate.content : undefined;
    if (name === 'included' && content && typeof content === 'object' && !Array.isArray(content)
      && typeof content.title === 'string' && ['Device reference', 'Device connections'].includes(content.title)) return noulAnswer(0.99);
    throw new Error(`Unexpected signature reading ${name}`);
  }); installJudgmentPort(fake.port);
  const selection = await prepareKnowledgeScopeSelection(store, {}, { kinds: ['source', 'node'] });
  return { store, source, canonicalUri, extraction, node, fake, selection };
}

test.each(['equal source subtree', 'equal node subtree', 'equal extraction subtree', 'reordered object slots',
  'reordered corpus', 'equal extraction view', 'equal caller source', 'equal caller node', 'unconsumed data'] as const)(
  'selected scope signatures preserve %s without adopting a new baseline', async mode => {
    const { store, source, extraction, node, fake, selection } = await recordFixture();
    const originalRequests = fake.requests.length;
    const callerNode = structuredClone(node);
    if (mode === 'equal source subtree') source.metadata.value = structuredClone(source.metadata.value);
    else if (mode === 'equal node subtree') {
      callerNode.metadata.value = structuredClone(callerNode.metadata.value);
      expect(selection.node(callerNode)).toBe(true);
      await Promise.resolve(); expect(selection.node(callerNode)).toBe(true);
      callerNode.metadata.value = { first: 'changed caller meaning', second: 'complete' };
      expect(() => selection.node(callerNode)).toThrow(KnowledgeScopeSelectionHeldError);
    }
    else if (mode === 'equal extraction subtree') expect(Reflect.set(extraction, 'sections', [...extraction.sections])).toBe(true);
    else if (mode === 'reordered object slots') source.metadata.value = { second: 'complete', first: 'original' };
    else if (mode === 'reordered corpus') {
      const sources = store.listSources.bind(store), nodes = store.listNodes.bind(store);
      spyOn(store, 'listSources').mockImplementation(limit => sources(limit).reverse());
      spyOn(store, 'listNodes').mockImplementation(limit => nodes(limit).reverse());
    } else if (mode === 'equal extraction view') {
      const read = store.getExtractionBySourceId.bind(store);
      spyOn(store, 'getExtractionBySourceId').mockImplementation(id => structuredClone(read(id)));
    } else if (mode === 'equal caller source') expect(selection.source(structuredClone(source))).toBe(true);
    else if (mode === 'equal caller node') expect(selection.node(structuredClone(node))).toBe(true);
    else source.metadata.notes = 'a legal unconsumed correction';
    selection.assertCurrent(); await Promise.resolve(); selection.assertCurrent();
    source.metadata.value = { first: 'changed after the equivalent observation', second: 'complete' };
    expect(selection.assertCurrent).toThrow(KnowledgeScopeSelectionHeldError);
    expect(fake.requests).toHaveLength(originalRequests);
  },
);

test.each(['source title', 'source meaning', 'node meaning', 'node alias', 'extraction text', 'extraction section',
  'extraction structure', 'hidden source child', 'source accessor', 'source proxy', 'hidden extraction child',
  'extraction accessor', 'extraction proxy'] as const)(
  'selected scope signatures reject %s before another dispatch', async mode => {
    const { source, extraction, node, fake, selection } = await recordFixture();
    const originalRequests = fake.requests.length; let callbacks = 0;
    const callerNode = structuredClone(node);
    if (mode === 'source title') expect(Reflect.set(source, 'title', 'Changed reference')).toBe(true);
    else if (mode === 'source meaning') source.metadata.value = { first: 'changed meaning', second: 'complete' };
    else if (mode === 'node meaning') callerNode.metadata.value = { first: 'changed node meaning', second: 'complete' };
    else if (mode === 'node alias') expect(Reflect.set(callerNode, 'aliases', [...callerNode.aliases, 'Changed device identity'])).toBe(true);
    else if (mode === 'extraction text') expect(Reflect.set(extraction, 'excerpt', 'A different device has seven controllers.')).toBe(true);
    else if (mode === 'extraction section') expect(Reflect.set(extraction, 'sections', [...extraction.sections, 'Changed source qualification'])).toBe(true);
    else if (mode === 'extraction structure') extraction.structure.text = 'Changed reference meaning';
    else if (mode === 'hidden source child') Object.defineProperty(source.metadata.value, 'hidden', { value: 'private child' });
    else if (mode === 'source accessor') Object.defineProperty(source, 'title', { enumerable: true, get() { callbacks++; return 'Device reference'; } });
    else if (mode === 'source proxy') source.metadata.value = new Proxy({}, { ownKeys() { callbacks++; return []; } });
    else if (mode === 'hidden extraction child') Object.defineProperty(extraction.structure, 'hidden', { value: 'private child' });
    else if (mode === 'extraction accessor') Object.defineProperty(extraction, 'excerpt', { enumerable: true, get() { callbacks++; return 'Original reference'; } });
    else extraction.structure.text = new Proxy({}, { ownKeys() { callbacks++; return []; } });
    if (mode === 'node meaning' || mode === 'node alias') expect(() => selection.node(callerNode)).toThrow(KnowledgeScopeSelectionHeldError);
    else expect(selection.assertCurrent).toThrow(KnowledgeScopeSelectionHeldError);
    expect(callbacks).toBe(0); expect(fake.requests).toHaveLength(originalRequests);
  },
);

test('a new authentic producer-reference registration retires the original scope projection', async () => {
  const { store, source, canonicalUri, fake, selection } = await recordFixture();
  const requests = fake.requests.length;
  registerGeneratedKnowledgeSourceReferences(store, source, {
    id: source.id, canonicalUri, sourceUri: source.sourceUri,
  });
  expect(selection.assertCurrent).toThrow(KnowledgeScopeSelectionHeldError);
  expect(fake.requests).toHaveLength(requests);
});

test('an original producer-reference projection remains current through repeated observations', async () => {
  const { store, source, canonicalUri, fake, selection } = await recordFixture(true);
  const requests = fake.requests.length;
  selection.assertCurrent(); await Promise.resolve(); selection.assertCurrent();
  registerGeneratedKnowledgeSourceReferences(store, source, { id: source.id, canonicalUri });
  expect(selection.assertCurrent).toThrow(KnowledgeScopeSelectionHeldError);
  expect(fake.requests).toHaveLength(requests);
});

test.each(['reorder', 'equivalent records', 'equivalent nested input', 'equivalent window', 'equivalent cached nested data', 'equivalent cached records'] as const)(
  'original edge comparison still accepts %s without adopting a new baseline', async mode => {
    const { store, edges, records, window, current, fake } = await fixture();
    const originalRequests = fake.requests.length;
    if (mode === 'reorder') records.reverse();
    else if (mode === 'equivalent records') records.splice(0, records.length, ...structuredClone(records));
    else if (mode === 'equivalent nested input') {
      const first = records[0]; if (!first) throw new Error('Missing original edge');
      first.metadata.details = structuredClone(first.metadata.details);
    } else if (mode === 'equivalent window') window.sourceIds = [...window.sourceIds];
    else if (mode === 'equivalent cached nested data') {
      const first = edges[0]; if (!first) throw new Error('Missing original edge');
      first.metadata.details = structuredClone(first.metadata.details);
    } else {
      const read = store.listEdges.bind(store);
      spyOn(store, 'listEdges').mockImplementation(() => structuredClone(read()));
    }
    current(); await Promise.resolve(); current();
    const first = records[0]; if (!first) throw new Error('Missing retained input edge');
    expect(Reflect.set(first, 'relation', 'contradicts')).toBe(true);
    expect(current).toThrow(KnowledgeScopeSelectionHeldError);
    expect(fake.requests).toHaveLength(originalRequests);
  },
);

test.each(['relation', 'confidence', 'metadata', 'hidden', 'accessor', 'proxy', 'new input', 'removed input', 'window mutation'] as const)(
  'the original retained edge input rejects %s', async mode => {
    const { records, window, current, fake } = await fixture();
    const originalRequests = fake.requests.length;
    const first = records[0]; if (!first) throw new Error('Missing original edge');
    let callbacks = 0;
    if (mode === 'relation') expect(Reflect.set(first, 'relation', 'contradicts')).toBe(true);
    else if (mode === 'confidence') expect(Reflect.set(first, 'weight', 0.1)).toBe(true);
    else if (mode === 'metadata') first.metadata.details = { label: 'changed evidence' };
    else if (mode === 'hidden') Object.defineProperty(first, 'hidden', { value: { credential: 'never-wire-private' } });
    else if (mode === 'accessor') Object.defineProperty(first, 'relation', { enumerable: true, get() { callbacks++; return 'references'; } });
    else if (mode === 'proxy') records[0] = new Proxy(first, { ownKeys(target) { callbacks++; return Reflect.ownKeys(target); } });
    else if (mode === 'new input') records.push({ ...first, id: 'unselected-edge' });
    else if (mode === 'removed input') records.pop();
    else window.sourceIds.pop();
    expect(current).toThrow(KnowledgeScopeSelectionHeldError);
    expect(callbacks).toBe(0);
    expect(fake.requests).toHaveLength(originalRequests);
  },
);

test.each(['new edge', 'removed edge'] as const)('fresh complete membership rejects a %s inside the original endpoints', async mode => {
  const { store, edges, current, fake } = await fixture();
  const originalRequests = fake.requests.length;
  const first = edges[0]; if (!first) throw new Error('Missing original edge');
  if (mode === 'new edge') await store.upsertEdge({ fromKind: first.fromKind, fromId: first.fromId,
    toKind: first.toKind, toId: first.toId, relation: 'contradicts' });
  else await store.deleteEdge(first.id);
  expect(current).toThrow(KnowledgeScopeSelectionHeldError);
  expect(fake.requests).toHaveLength(originalRequests);
});

test.each(['relation', 'confidence', 'metadata', 'hidden', 'accessor', 'proxy'] as const)(
  'the independently retained cached edge window rejects %s', async mode => {
    const { store, edges, selection, fake } = await fixture();
    const current = selection.retainEdges(structuredClone(edges)), originalRequests = fake.requests.length;
    const first = edges[0]; if (!first) throw new Error('Missing original cached edge');
    let callbacks = 0;
    if (mode === 'relation') expect(Reflect.set(first, 'relation', 'contradicts')).toBe(true);
    else if (mode === 'confidence') expect(Reflect.set(first, 'weight', 0.1)).toBe(true);
    else if (mode === 'metadata') first.metadata.details = { label: 'changed cached evidence' };
    else if (mode === 'hidden') Object.defineProperty(first.metadata, 'hidden', { value: 'never-wire-private' });
    else if (mode === 'accessor') Object.defineProperty(first, 'relation', { enumerable: true, get() { callbacks++; return 'references'; } });
    else {
      const read = store.listEdges.bind(store);
      spyOn(store, 'listEdges').mockImplementation(() => read().map(edge => edge === first
        ? new Proxy(first, { ownKeys(target) { callbacks++; return Reflect.ownKeys(target); } }) : edge));
    }
    expect(current).toThrow(KnowledgeScopeSelectionHeldError);
    expect(callbacks).toBe(0);
    expect(fake.requests).toHaveLength(originalRequests);
  },
);
