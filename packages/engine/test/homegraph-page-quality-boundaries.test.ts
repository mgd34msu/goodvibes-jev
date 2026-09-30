import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { refreshDevicePagesForHomeGraphAsk } from '../sdk/src/platform/knowledge/home-graph/ask-page-refresh.js';
import {
  generateHomeGraphRoomPage,
  refreshHomeGraphDevicePassport,
} from '../sdk/src/platform/knowledge/home-graph/generated-pages.js';
import { buildHomeGraphMetadata, homeGraphNodeId } from '../sdk/src/platform/knowledge/home-graph/helpers.js';
import { renderRoomPage } from '../sdk/src/platform/knowledge/home-graph/rendering.js';
import { readHomeGraphState } from '../sdk/src/platform/knowledge/home-graph/state.js';
import type { HomeGraphAskResult } from '../sdk/src/platform/knowledge/home-graph/types.js';
import { KnowledgeSourceQualityHeldError } from '../sdk/src/platform/knowledge/source-quality.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';
import { withTestTimeout } from './_helpers/test-timeout.js';

const spaceId = 'homeassistant:page-quality-house';
const installationId = 'page-quality-house';
const areaId = 'living-room';
const deviceId = 'reference-device';
const primaryPurpose = 'Choose a useful, credible primary reference supporting this exact claim and subject:';
const roots: string[] = [];
let previous: JudgmentPort | undefined;

beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => {
  installJudgmentPort(previous);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type ReadingState = {
  readonly purpose: string;
  readonly candidate: { readonly title: string };
};

function readings(probability: (state: ReadingState) => number = () => 0.97) {
  const fake = fakePort((name, question, state) => {
    if (['batteryApplicable', 'manufacturerPresent', 'modelPresent', 'batteryTypePresent'].includes(name)) return noulAnswer(0.01); // Authored reference-device fixture: these fields are absent and battery tracking does not apply.
    if (name === 'supported' || name === 'attached') return noulAnswer(0.99);
    if (name === 'useful') return noulAnswer(probability(state as ReadingState));
    if (name === 'authority') return choiceAnswer(question, 'official-vendor', 0.97);
    throw new Error(`Unexpected page-quality fixture question: ${name}`);
  });
  installJudgmentPort(fake.port);
  return fake;
}

/** Pause a real quality request without timers or a live model. */
function pauseReading(predicate: (state: ReadingState) => boolean = () => true) {
  const fake = readings();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let paused = false;
  installJudgmentPort({
    ...fake.port,
    async ask(request) {
      const answer = await fake.port.ask(request);
      if (!paused && 'useful' in request.questions && predicate(request.state as ReadingState)) {
        paused = true;
        entered.resolve();
        await released.promise;
      }
      return answer;
    },
  });
  return { ...fake, entered: entered.promise, release: () => released.resolve() };
}

function metadata(extra: Record<string, unknown> = {}) {
  return buildHomeGraphMetadata(spaceId, installationId, extra);
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-page-quality-'));
  roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  await store.init();
  const area = await store.upsertNode({
    id: homeGraphNodeId(spaceId, 'ha_area', areaId), kind: 'ha_area', slug: areaId,
    title: 'Living Room', status: 'active',
    metadata: metadata({ homeAssistant: { objectId: areaId, objectKind: 'area' } }),
  });
  const device = await store.upsertNode({
    id: homeGraphNodeId(spaceId, 'ha_device', deviceId), kind: 'ha_device', slug: deviceId,
    title: 'Reference device', status: 'active',
    metadata: metadata({ homeAssistant: { objectId: deviceId, objectKind: 'device' } }),
  });
  await store.upsertEdge({
    fromKind: 'node', fromId: device.id, toKind: 'node', toId: area.id,
    relation: 'located_in', metadata: metadata(),
  });
  return { store, artifactStore, spaceId, installationId, device };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type PageKind = 'room' | 'passport';

async function addSource(context: Fixture, id: string, options: {
  readonly linked?: boolean;
  readonly summary?: string;
  readonly profile?: boolean;
} = {}) {
  const text = 'The reference device supports Wi-Fi wireless connectivity for its network connection.';
  const artifact = options.profile ? await context.artifactStore.create({
    kind: 'document', mimeType: 'text/plain', filename: `${id}.txt`, text, metadata: metadata(),
  }) : undefined;
  const source = await context.store.upsertSource({
    id, connectorId: 'homeassistant', sourceType: 'manual', title: id, status: 'indexed',
    canonicalUri: `https://reference.example.test/${id}`,
    summary: options.summary ?? 'A concrete reference documenting the device and its capabilities.',
    ...(artifact ? { artifactId: artifact.id } : {}), metadata: metadata(),
  });
  if (options.linked !== false) await context.store.upsertEdge({
    fromKind: 'source', fromId: source.id, toKind: 'node', toId: context.device.id,
    relation: 'has_manual', metadata: metadata(),
  });
  if (artifact) await context.store.upsertExtraction({
    sourceId: source.id, artifactId: artifact.id, extractorId: 'text', format: 'text',
    excerpt: text, structure: { searchText: text }, metadata: metadata(),
  });
  return source;
}

function generate(context: Fixture, kind: PageKind, signal?: AbortSignal) {
  return kind === 'room'
    ? generateHomeGraphRoomPage({ ...context, input: { areaId }, signal })
    : refreshHomeGraphDevicePassport({ ...context, input: { deviceId }, signal });
}

async function addAskFact(context: Fixture, source: KnowledgeSourceRecord) {
  return context.store.upsertNode({
    id: `${source.id}-fact`, kind: 'fact', slug: `${source.id}-fact`, status: 'active',
    title: 'Display resolution', summary: 'The device supports 4K UHD resolution.', sourceId: source.id,
    metadata: metadata({
      semanticKind: 'fact', factKind: 'specification', value: '4K UHD resolution',
      sourceId: source.id, subjectIds: [context.device.id],
    }),
  });
}

function refreshAsk(context: Fixture, sources: readonly KnowledgeSourceRecord[], facts: readonly KnowledgeNodeRecord[] = [],
  linkedObjects: readonly KnowledgeNodeRecord[] = [context.device]) {
  const answer: HomeGraphAskResult = {
    ok: true, spaceId, query: 'What features does the reference device have?', results: [],
    answer: { text: 'A source-backed reference answer.', mode: 'standard', confidence: 95, sources, facts, linkedObjects },
  };
  return refreshDevicePagesForHomeGraphAsk({ ...context, answer });
}

/** Compare records, not just counts: a held pass must not overwrite existing content. */
function persisted(context: Fixture) {
  return JSON.stringify({
    sources: context.store.listSourcesInSpace(spaceId),
    nodes: context.store.listNodesInSpace(spaceId),
    edges: context.store.listEdges(),
    extractions: context.store.listExtractionsInSpace(spaceId),
    issues: context.store.listIssuesInSpace(spaceId),
    artifacts: context.artifactStore.list(),
  });
}

describe('Home Graph page quality persistence boundaries', () => {
  for (const kind of ['room', 'passport'] as const) {
    test(`${kind} scopes sources before the 50-candidate cap and protected-input checks`, async () => {
      const context = await fixture();
      // Insert the relevant reference first; every later record sorts ahead of it,
      // including timestamp ties because its id sorts last.
      const relevant = await addSource(context, 'zz-relevant-reference');
      for (let index = 0; index < 50; index += 1) await addSource(context, `unrelated-${String(index).padStart(2, '0')}`, {
        linked: false,
        summary: index === 0 ? 'Authorization: Bearer synthetic-unrelated-value' : 'UNRELATED_REFERENCE_MARKER',
      });
      expect(context.store.listSourcesInSpace(spaceId).indexOf(relevant)).toBe(50);
      const fake = readings();
      const page = await generate(context, kind);
      expect(page.markdown).toContain(relevant.title!);
      expect(page.markdown).not.toContain('unrelated-');
      expect(fake.requests).toHaveLength(kind === 'passport' ? 2 : 1);
      expect(fake.requests.filter((request) => 'useful' in request.questions)).toHaveLength(1);
      expect((fake.requests[0]!.state as ReadingState).candidate.title).toBe(relevant.title!);
      expect(JSON.stringify(fake.requests)).not.toContain('synthetic-unrelated-value');
      expect(JSON.stringify(fake.requests)).not.toContain('UNRELATED_REFERENCE_MARKER');
      expect(context.artifactStore.list()).toHaveLength(1);
      expect(context.store.getSource(page.source!.id)).not.toBeNull();
    });

    test(`${kind} source changes during awaited quality leave no generated writes`, async () => {
      const context = await fixture();
      const source = await addSource(context, 'versioned-reference', { profile: true });
      const pause = pauseReading();
      const before = persisted(context);
      const result = generate(context, kind).then(() => undefined, (error: unknown) => error);
      try {
        await withTestTimeout(pause.entered);
        expect(persisted(context)).toBe(before);
        await context.store.replaceSourceRecord({ ...source, summary: 'Concurrent corrected reference content.' });
        const afterConcurrentEdit = persisted(context);
        pause.release();
        const error = await result;
        expect(error).toBeInstanceOf(KnowledgeSourceQualityHeldError);
        expect((error as KnowledgeSourceQualityHeldError).reason).toBe('stale');
        expect(persisted(context)).toBe(afterConcurrentEdit);
      } finally {
        pause.release();
        await result;
      }
    });

    test(`${kind} pre-aborted generation never asks or writes`, async () => {
      const context = await fixture();
      await addSource(context, 'aborted-reference', { profile: true });
      const fake = readings();
      const controller = new AbortController();
      controller.abort();
      const before = persisted(context);
      await expect(generate(context, kind, controller.signal)).rejects.toThrow('cancelled');
      expect(fake.requests).toHaveLength(0);
      expect(persisted(context)).toBe(before);
    });

    test(`${kind} cancellation during awaited quality leaves all records unchanged`, async () => {
      const context = await fixture();
      await addSource(context, 'cancelled-reference', { profile: true });
      const pause = pauseReading();
      const controller = new AbortController();
      const before = persisted(context);
      const result = generate(context, kind, controller.signal).then(() => undefined, (error: unknown) => error);
      try {
        await withTestTimeout(pause.entered);
        expect(persisted(context)).toBe(before);
        controller.abort();
        pause.release();
        const error = await result;
        expect(error).toBeInstanceOf(KnowledgeSourceQualityHeldError);
        expect((error as KnowledgeSourceQualityHeldError).reason).toBe('aborted');
        expect(persisted(context)).toBe(before);
      } finally {
        pause.release();
        await result;
      }
    });
  }

  test('passport shares useful/authority readings, then separately judges claim-specific primary sources', async () => {
    const context = await fixture();
    const a = await addSource(context, 'reference-a', { profile: true });
    const b = await addSource(context, 'reference-b', { profile: true });
    const fake = readings(({ purpose, candidate }) => (
      (purpose.startsWith(primaryPurpose) ? candidate.title === b.title : candidate.title === a.title) ? 0.99 : 0.91
    ));
    const page = await generate(context, 'passport');
    const qualityRequests = fake.requests.filter((request) => 'useful' in request.questions);
    const pageRequests = qualityRequests.filter(({ state }) => !((state as ReadingState).purpose ?? '').startsWith(primaryPurpose));
    const primaryRequests = qualityRequests.filter(({ state }) => ((state as ReadingState).purpose ?? '').startsWith(primaryPurpose));
    expect(pageRequests.map(({ state }) => (state as ReadingState).candidate.title).sort()).toEqual([a.title!, b.title!]);
    expect(primaryRequests.map(({ state }) => (state as ReadingState).candidate.title).sort()).toEqual([a.title!, b.title!]);
    for (const request of qualityRequests) expect(Object.keys(request.questions).sort()).toEqual(['authority', 'useful']);
    expect(fake.requests.some((request) => 'supported' in request.questions)).toBe(true);
    expect(fake.requests.slice(0, 2)).toEqual(pageRequests);
    const facts = context.store.listNodesInSpace(spaceId).filter((node) => node.kind === 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.sourceId).toBe(b.id);
    expect(facts[0]!.metadata.sourceIds).toEqual([a.id, b.id]);
    expect(page.markdown).toContain('Wi-Fi');
    expect(context.artifactStore.list()).toHaveLength(3);
  });

  test('a held primary-fact reading prevents earlier passport and profile writes', async () => {
    const context = await fixture();
    await addSource(context, 'reference-a', { profile: true });
    await addSource(context, 'reference-b', { profile: true });
    const fake = readings(({ purpose }) => purpose.startsWith(primaryPurpose) ? 0.65 : 0.97);
    const before = persisted(context);
    await expect(generate(context, 'passport')).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(fake.requests.filter((request) => 'useful' in request.questions)).toHaveLength(4);
    expect(persisted(context)).toBe(before);
  });

  test('passport guards source versions through the later primary-fact await', async () => {
    const context = await fixture();
    const a = await addSource(context, 'reference-a', { profile: true });
    await addSource(context, 'reference-b', { profile: true });
    const pause = pauseReading(({ purpose }) => purpose.startsWith(primaryPurpose));
    const before = persisted(context);
    const result = generate(context, 'passport').then(() => undefined, (error: unknown) => error);
    try {
      await withTestTimeout(pause.entered);
      expect(persisted(context)).toBe(before);
      await context.store.replaceSourceRecord({ ...a, summary: 'Concurrent source edit during primary selection.' });
      const afterConcurrentEdit = persisted(context);
      pause.release();
      const error = await result;
      expect(error).toBeInstanceOf(KnowledgeSourceQualityHeldError);
      expect((error as KnowledgeSourceQualityHeldError).reason).toBe('stale');
      expect(persisted(context)).toBe(afterConcurrentEdit);
    } finally {
      pause.release();
      await result;
    }
  });

  test('unknown area and room ids cannot broaden rendering or generation to unrelated content', async () => {
    const context = await fixture();
    await addSource(context, 'UNRELATED_PRIVATE_ROOM_REFERENCE', { profile: true });
    const fake = readings();
    const before = persisted(context);
    const state = { ...readHomeGraphState(context.store, spaceId), title: 'Missing room' };
    await expect(renderRoomPage(state, 'missing-area')).rejects.toThrow('not found');
    await expect(generateHomeGraphRoomPage({ ...context, input: { areaId: 'missing-area' } })).rejects.toThrow('not found');
    await expect(generateHomeGraphRoomPage({ ...context, input: { roomId: 'missing-room' } })).rejects.toThrow('not found');
    expect(fake.requests).toHaveLength(0);
    expect(persisted(context)).toBe(before);
  });

  test('ask refresh excludes foreign protected sources, including existing-id collisions, before transmission or linking', async () => {
    const context = await fixture();
    const foreignSpaceId = 'homeassistant:other-house';
    const foreign = await context.store.upsertSource({
      id: 'foreign-protected-reference', connectorId: 'homeassistant', sourceType: 'manual', status: 'indexed',
      title: 'FOREIGN_PROTECTED_REFERENCE', summary: 'Authorization: Bearer synthetic-foreign-value',
      metadata: buildHomeGraphMetadata(foreignSpaceId, 'other-house'),
    });
    const foreignDevice = await context.store.upsertNode({
      id: 'foreign-device', kind: 'ha_device', slug: 'foreign-device', title: 'Foreign device', status: 'active',
      metadata: buildHomeGraphMetadata(foreignSpaceId, 'other-house'),
    });
    const responseOnlyForeign = { ...foreign, id: 'response-only-foreign-reference' };
    // An incoming record cannot relabel an existing foreign id into this space.
    const collision = { ...foreign, metadata: metadata() };
    const fake = readings();
    const result = await refreshAsk(context, [responseOnlyForeign, collision], [], [context.device, foreignDevice]);
    expect(result).toEqual({ requested: true, refreshed: 1 });
    expect(fake.requests).toHaveLength(1);
    expect(Object.keys(fake.requests[0]!.questions)).toEqual(['batteryApplicable']);
    expect(JSON.stringify(fake.requests)).not.toContain('FOREIGN');
    expect(context.store.getSource(foreign.id)).toEqual(foreign);
    expect(context.store.getSource(responseOnlyForeign.id)).toBeNull();
    expect(context.store.getNode(foreignDevice.id)).toEqual(foreignDevice);
    expect(context.store.listEdges().filter((edge) => [foreign.id, responseOnlyForeign.id, foreignDevice.id].includes(edge.fromId)
      || [foreign.id, responseOnlyForeign.id, foreignDevice.id].includes(edge.toId))).toEqual([]);
    expect(context.store.listSourcesInSpace(spaceId).some((source) => source.title?.includes('FOREIGN'))).toBe(false);
  });

  for (const changedRecord of ['source', 'fact', 'device'] as const) {
    test(`ask refresh refuses a ${changedRecord} changed during quality before any source or link mutation`, async () => {
      const context = await fixture();
      const source = await addSource(context, 'answer-reference', { linked: false, profile: true });
      const fact = await addAskFact(context, source);
      const incoming = { ...source, summary: 'Updated answer reference content awaiting approval.' };
      const responseOnly = { ...source, id: 'response-only-reference', canonicalUri: 'https://reference.example.test/response-only' };
      const pause = pauseReading();
      const before = persisted(context);
      const result = refreshAsk(context, [incoming, responseOnly], [fact]).then(() => undefined, (error: unknown) => error);
      try {
        await withTestTimeout(pause.entered);
        expect(persisted(context)).toBe(before);
        if (changedRecord === 'source') await context.store.replaceSourceRecord({ ...source, summary: 'Concurrent source correction.' });
        else {
          const node = changedRecord === 'fact' ? fact : context.device;
          await context.store.replaceNodeRecord({ ...node, summary: `Concurrent ${changedRecord} correction.` });
        }
        const afterConcurrentEdit = persisted(context);
        pause.release();
        const error = await result;
        expect(error).toBeInstanceOf(KnowledgeSourceQualityHeldError);
        expect((error as KnowledgeSourceQualityHeldError).reason).toBe('stale');
        expect(context.store.getSource(responseOnly.id)).toBeNull();
        expect(persisted(context)).toBe(afterConcurrentEdit);
      } finally {
        pause.release();
        await result;
      }
    });
  }

  test('ask refresh links accepted-source facts only and leaves rejected and foreign facts unchanged', async () => {
    const context = await fixture();
    const accepted = await addSource(context, 'accepted-answer-reference', { linked: false });
    const rejected = await addSource(context, 'rejected-answer-reference', { linked: false });
    const acceptedFact = await addAskFact(context, accepted);
    const rejectedFact = await addAskFact(context, rejected);
    const foreignFact = { ...acceptedFact, id: 'foreign-response-fact',
      metadata: buildHomeGraphMetadata('homeassistant:other-house', 'other-house', acceptedFact.metadata) };
    const fake = readings(({ candidate }) => candidate.title === rejected.title ? 0.03 : 0.97);
    const result = await refreshAsk(context, [accepted, rejected], [acceptedFact, rejectedFact, foreignFact]);
    expect(result).toEqual({ requested: true, refreshed: 1 });
    expect(context.store.getSource(rejected.id)).toEqual(rejected);
    expect(context.store.getNode(rejectedFact.id)).toEqual(rejectedFact);
    expect(context.store.getNode(foreignFact.id)).toBeNull();
    expect(context.store.listEdges().filter((edge) => [rejected.id, rejectedFact.id, foreignFact.id].includes(edge.fromId)
      || [rejected.id, rejectedFact.id, foreignFact.id].includes(edge.toId))).toEqual([]);
    expect(context.store.getNode(acceptedFact.id)?.metadata.linkedBy).toBe('homegraph-ask-page-refresh');
    expect(context.store.listEdges().some((edge) => edge.fromId === accepted.id && edge.toId === acceptedFact.id
      && edge.relation === 'supports_fact')).toBe(true);
    expect(context.store.listEdges().some((edge) => edge.fromId === acceptedFact.id && edge.toId === context.device.id
      && edge.relation === 'describes')).toBe(true);
    expect(fake.requests.filter(({ state }) => (state as ReadingState).candidate?.title === rejected.title)).toHaveLength(1);
  });
  test('a write-entry hold restores its passport but preserves an untouched concurrent fact edit', async () => {
    const context = await fixture();
    await addSource(context, 'profile-reference', { profile: true });
    readings();
    await generate(context, 'passport');
    const fact = context.store.listNodes().find((node) => node.kind === 'fact')!;
    expect(fact).toBeDefined();
    const priorPassport = context.store.getNode(homeGraphNodeId(spaceId, 'ha_device_passport', deviceId));
    const racingStore = Object.create(context.store) as KnowledgeStore;
    let concurrent: KnowledgeNodeRecord | undefined;
    racingStore.upsertNode = async (input) => {
      const node = await context.store.upsertNode(input);
      if (input.kind === 'ha_device_passport') concurrent = await context.store.upsertNode({
        ...fact, summary: 'Concurrent operator correction.', metadata: { ...fact.metadata, operatorReview: 'rejected' },
      });
      return node;
    };
    await expect(generate({ ...context, store: racingStore }, 'passport')).rejects.toBeInstanceOf(KnowledgeSourceQualityHeldError);
    expect(context.store.getNode(fact.id)).toEqual(concurrent!);
    expect(context.store.getNode(priorPassport!.id)).toEqual(priorPassport);
  });

  test('mid-profile cancellation restores only written facts and preserves an untouched concurrent edit', async () => {
    const context = await fixture();
    const source = await addSource(context, 'multi-profile-reference', { profile: true });
    const extraction = context.store.getExtractionBySourceId(source.id)!;
    const text = 'The reference device has 4K UHD 3840 x 2160 resolution, 120 Hz, HDMI 2.1, USB, Ethernet, Bluetooth, Wi-Fi, and 2 x 10W speakers.';
    await context.store.upsertExtraction({ ...extraction, excerpt: text, structure: { searchText: text } });
    readings(); await generate(context, 'passport');
    const facts = context.store.listNodes().filter((node) => node.kind === 'fact');
    expect(facts.length).toBeGreaterThan(1);
    const before = new Map(facts.map((fact) => [fact.id, fact]));
    const controller = new AbortController();
    const racingStore = Object.create(context.store) as KnowledgeStore;
    let touched: string | undefined;
    let concurrent: KnowledgeNodeRecord | undefined;
    racingStore.upsertNode = async (input) => {
      const node = await context.store.upsertNode(input);
      if (input.kind === 'fact' && touched === undefined) {
        touched = node.id;
        const untouched = facts.find((fact) => fact.id !== node.id)!;
        concurrent = await context.store.upsertNode({ ...untouched, summary: 'Concurrent correction outside this write pass.' });
        controller.abort();
      }
      return node;
    };
    await expect(generate({ ...context, store: racingStore }, 'passport', controller.signal)).rejects.toThrow('Home Graph device passport refresh was cancelled');
    expect(touched).toBeDefined(); expect(concurrent).toBeDefined();
    expect(context.store.getNode(touched!)).toEqual(before.get(touched!)!);
    expect(context.store.getNode(concurrent!.id)).toEqual(concurrent!);
  });

});
