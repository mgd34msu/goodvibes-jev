import * as crypto from 'node:crypto';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { KnowledgeGeneratedFactSupportHeldError } from '../sdk/src/platform/knowledge/semantic/verification/types.js';
import { HomeGraphService } from '../sdk/src/platform/knowledge/home-graph/service.js';
import { withKnowledgeSourceAnswerAliases } from '../sdk/src/platform/knowledge/source-structural-references.js';
import { createKnowledgeNodeOperatorMutation } from '../sdk/src/platform/knowledge/store-node-authority.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
import { homeGraphRepairProfileValues, repairProfileFixtureReading, repairUsefulFixtureReading } from './_helpers/repair-profile-fixture-readings.js';

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
    const profile = repairProfileFixtureReading(name, state, homeGraphRepairProfileValues);
    if (profile !== undefined) return noulAnswer(profile);
    if (name === 'repairUseful') return noulAnswer(repairUsefulFixtureReading(state, homeGraphRepairProfileValues,
      [['Display resolution', 'The device supports 4K UHD resolution.', 'The reference device supports 4K UHD resolution.']]));
    if (['batteryApplicable', 'manufacturerPresent', 'modelPresent', 'batteryTypePresent'].includes(name)) return noulAnswer(0.01); // Authored reference-device fixture: these fields are absent and battery tracking does not apply.
    if (name === 'serve' && ['Network and wireless capabilities', 'Display and picture specifications', 'Input and output ports', 'Gaming and HDMI features', 'Audio capabilities', 'Display resolution'].includes((state as ReadingState).candidate.title)) return noulAnswer(0.99); // Authored synthetic reference-document claims.
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

/** Seed a real owned source without authorizing an automatic subject link.
 * The race under test installs its own quality reader after this seed phase. */
async function ingestAliasFixtureNote(service: HomeGraphService, input: Parameters<HomeGraphService['ingestNote']>[0]) {
  const seed = fakePort((name, question) => {
    if (name === 'relation') return choiceAnswer(question, 'source_for', 0.99);
    if (['manual', 'integrationDocumentation', 'selected'].includes(name)) return noulAnswer(0.01);
    throw new Error(`Unexpected alias seed question: ${name}`);
  });
  const previousSeed = installJudgmentPort(seed.port);
  try { return await service.ingestNote(input); }
  finally { installJudgmentPort(previousSeed); }
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
  const area = await seedHomeAssistantObservation(store, {
    id: homeGraphNodeId(spaceId, 'ha_area', areaId), kind: 'ha_area', slug: areaId,
    title: 'Living Room', status: 'active',
    metadata: metadata({ homeAssistant: { objectId: areaId, objectKind: 'area' } }),
  });
  const device = await seedHomeAssistantObservation(store, {
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
  const extraction = context.store.getExtractionBySourceId(source.id);
  await context.store.upsertExtraction({ ...extraction, sourceId: source.id, extractorId: 'synthetic-reference', format: 'text',
    excerpt: [extraction?.excerpt, 'The reference device supports 4K UHD resolution.'].filter(Boolean).join(' '),
    metadata: metadata(),
  });
  readings();
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
        expect(error).toBeInstanceOf(Error);
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
        expect(error).toBeInstanceOf(Error);
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
    const foreignDevice = await seedHomeAssistantObservation(context.store, {
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
          const summary = `Concurrent ${changedRecord} correction.`;
          if (changedRecord === 'device') await seedHomeAssistantObservation(context.store, { ...node, summary });
          else await context.store.replaceNodeRecord({ ...node, summary }, createKnowledgeNodeOperatorMutation(node, {
            action: 'revise', reviewer: 'fixture-operator', fieldCorrections: [{ path: ['summary'], value: summary }],
          }));
        }
        const afterConcurrentEdit = persisted(context);
        pause.release();
        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as KnowledgeSourceQualityHeldError).reason).toBe('stale');
        expect(context.store.getSource(responseOnly.id)).toBeNull();
        expect(persisted(context)).toBe(afterConcurrentEdit);
      } finally {
        pause.release();
        await result;
      }
    });
  }

  test('ask refresh rejects an already-replaced selected device before quality or source linking', async () => {
    const context = await fixture(); const source = await addSource(context, 'selected-reference', { linked: false });
    await seedHomeAssistantObservation(context.store, { ...context.device, title: 'Different foreign device',
      metadata: { ...context.device.metadata, knowledgeSpaceId: 'homeassistant:foreign', namespace: 'homeassistant:foreign' } });
    const before = persisted(context); const fake = readings();
    await expect(refreshAsk(context, [source])).rejects.toMatchObject({ reason: 'stale' });
    expect(fake.requests).toHaveLength(0); expect(persisted(context)).toBe(before);
    expect(context.store.listEdges().some(edge => edge.fromId === source.id && edge.toId === context.device.id)).toBe(false);
  });

  test('selected device ownership reaches the final prepared source-link write', async () => {
    const context = await fixture(); const source = await addSource(context, 'selected-reference', { linked: false });
    const original = context.store.applyPreparedIngest.bind(context.store);
    let changed = false; readings();
    const apply = spyOn(context.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
      if (!changed) {
        changed = true;
        await seedHomeAssistantObservation(context.store, { ...context.device, title: 'Different foreign device',
          metadata: { ...context.device.metadata, knowledgeSpaceId: 'homeassistant:foreign', namespace: 'homeassistant:foreign' } });
      }
      return original(...args);
    });
    try {
      await expect(refreshAsk(context, [source])).rejects.toMatchObject({ reason: 'stale' });
      expect(changed).toBe(true);
      expect(context.store.listEdges().some(edge => edge.fromId === source.id && edge.toId === context.device.id)).toBe(false);
      expect(context.store.listSourcesInSpace(spaceId).some(row => row.metadata.generatedProjection === true)).toBe(false);
      expect(context.artifactStore.list()).toEqual([]);
    } finally { apply.mockRestore(); }
  });

  test('a plain current source still receives Home Graph metadata during ask refresh', async () => {
    const context = await fixture();
    const source = await context.store.upsertSource({ id: 'plain-current-reference', connectorId: 'manual',
      sourceType: 'manual', title: 'Plain reference manual', status: 'indexed',
      canonicalUri: 'https://reference.example.test/plain-current', metadata: { knowledgeSpaceId: spaceId } });
    readings();
    await refreshAsk(context, [source]);
    const stored = context.store.getSource(source.id)!;
    expect(stored).not.toBe(source);
    expect(stored.metadata.homeGraph).toBe(true);
    expect(stored.metadata.homeAssistant).toMatchObject({ installationId });
  });

  test('owned answer alias source changes during quality leave no source or link writes', async () => {
    const context = await fixture();
    const service = new HomeGraphService(context.store, context.artifactStore);
    const ingested = await ingestAliasFixtureNote(service, { installationId, title: 'Reference device manual',
      body: 'The reference device supports 4K UHD resolution.', category: 'manual' });
    const source = context.store.getSource(ingested.source.id)!;
    const alias = withKnowledgeSourceAnswerAliases(source);
    const pause = pauseReading();
    const before = persisted(context);
    const result = refreshAsk(context, [alias]).then(() => undefined, (error: unknown) => error);
    try {
      await withTestTimeout(pause.entered);
      expect(persisted(context)).toBe(before);
      await context.store.replaceSourceRecord({ ...source, summary: 'Concurrent source correction.' });
      const afterConcurrentEdit = persisted(context);
      pause.release();
      const error = await result;
      expect(error).toBeInstanceOf(KnowledgeSourceQualityHeldError);
      expect((error as KnowledgeSourceQualityHeldError).reason).toBe('stale');
      expect(persisted(context)).toBe(afterConcurrentEdit);
    } finally {
      pause.release();
      await result;
      service.dispose();
    }
  });

  test('a ledger cache rebuild during quality rejects all owned aliases before the first write', async () => {
    const context = await fixture();
    const service = new HomeGraphService(context.store, context.artifactStore);
    const random = spyOn(crypto, 'randomUUID').mockReturnValue('00001af0-0000-4000-8000-000000000000');
    let ingested: Awaited<ReturnType<HomeGraphService['ingestNote']>>;
    try {
      ingested = await ingestAliasFixtureNote(service, { installationId, title: 'Reference device manual',
        body: 'The reference device supports 4K UHD resolution.', category: 'manual' });
    } finally { random.mockRestore(); }
    const source = context.store.getSource(ingested.source.id)!;
    const alias = withKnowledgeSourceAnswerAliases(source);
    // This valid new source sorts before the stale owned alias. A per-source
    // check would admit a partial write: SQLiteStore.batch flushes in finally.
    const responseOnly = { ...source, id: 'a-response-first',
      canonicalUri: 'https://reference.example.test/response-first', sourceUri: undefined };
    const projectId = 'alias-cache-rebuild';
    const storage = await context.store.openWorkLedgerStorage(projectId);
    const ledger = createWorkLedger({ projectId, storage, clock: { now: () => 100, newId: kind => `${kind}-fixture` } });
    const actor = ledger.authority.issueActor({ projectId, actorId: 'fixture-owner', role: 'coordinator' });
    const pause = pauseReading();
    const result = refreshAsk(context, [responseOnly, alias]).then(() => undefined, (error: unknown) => error);
    try {
      await withTestTimeout(pause.entered);
      expect(await ledger.service.execute({ type: 'create', requestId: 'create-ledger-work', expectedRevision: 0,
        title: 'Independent ledger work', goal: 'Commit a normal ledger transaction', criteria: ['Durable revision'] }, actor))
        .toMatchObject({ kind: 'accepted' });
      const current = context.store.getSource(source.id)!;
      expect(current).not.toBe(source);
      expect(current).toEqual(source);
      const afterLedger = persisted(context);
      const bytesAfterLedger = readFileSync(context.store.storagePath);
      pause.release();
      const error = await result;
      expect(context.store.getSource(responseOnly.id)).toBeNull();
      expect(persisted(context)).toBe(afterLedger);
      expect(readFileSync(context.store.storagePath)).toEqual(bytesAfterLedger);
      expect(error).toBeInstanceOf(Error);
      expect((error as KnowledgeGeneratedFactSupportHeldError).reason).toBe('stale');
    } finally {
      pause.release();
      await result;
      await ledger.service.close();
      service.dispose();
    }
  });

  for (const [changedSource, extraMicrotasks] of [['later', 0], ['current', 0], ['current', 1]] as const) {
    test(`a public correction to the ${changedSource} owned source after the first edge and ${extraMicrotasks} extra microtasks is never overwritten`, async () => {
      const context = await fixture();
      const service = new HomeGraphService(context.store, context.artifactStore);
      const otherDevice = await seedHomeAssistantObservation(context.store, {
        id: 'another-reference-device', kind: 'ha_device', slug: 'another-reference-device',
        title: 'Another reference device', status: 'active',
        metadata: metadata({ homeAssistant: { objectId: 'another-reference-device', objectKind: 'device' } }),
      });
      const sources: KnowledgeSourceRecord[] = [];
      for (const title of ['First reference manual', 'Second reference manual']) {
        const ingested = await ingestAliasFixtureNote(service, { installationId, title,
          body: 'The reference device supports 4K UHD resolution.', category: 'manual' });
        sources.push(context.store.getSource(ingested.source.id)!);
      }
      sources.sort((left, right) => left.id.localeCompare(right.id));
      const first = sources[0]!, later = sources[1]!;
      const changed = changedSource === 'later' ? later : first;
      const aliases = sources.map(withKnowledgeSourceAnswerAliases);
      const askEdges = () => context.store.listEdges().filter((edge) => edge.relation === 'source_for'
        && edge.metadata.linkedBy === 'homegraph-ask-page-refresh');
      readings();
      let settled = false;
      const result = refreshAsk(context, aliases, [], [context.device, otherDevice])
        .then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
      try {
        // Observe public state between real async store operations. No store
        // method is replaced; a public upsert races the next source/edge step.
        for (let turn = 0; turn < 1_000 && !settled && !askEdges().some((edge) => edge.fromId === first.id); turn++) {
          await Promise.resolve();
        }
        expect(askEdges().some((edge) => edge.fromId === first.id && edge.toId === context.device.id)).toBe(true);
        for (let turn = 0; turn < extraMicrotasks; turn++) await Promise.resolve();
        const correction = await context.store.upsertSource({ ...changed,
          title: 'Newer corrected manual title', summary: 'Newer operator correction after the first valid edge.' });
        const error = await result;
        expect(context.store.getSource(changed.id)).toBe(correction);
        expect(context.store.getSource(changed.id)).toEqual(correction);
        expect(error).toBeInstanceOf(Error);
        expect((error as KnowledgeGeneratedFactSupportHeldError).reason).toBe('stale');
        expect(askEdges().filter((edge) => edge.fromId === later.id)).toHaveLength(0);
        if (changedSource === 'current') {
          expect(askEdges().filter((edge) => edge.fromId === first.id && edge.toId === otherDevice.id)).toHaveLength(0);
        }
        // The earlier valid edge may remain: batch is not an atomic rollback.
        expect(askEdges().some((edge) => edge.fromId === first.id && edge.toId === context.device.id)).toBe(true);
        const reopened = new KnowledgeStore({ dbPath: context.store.storagePath });
        try {
          await reopened.init();
          expect(reopened.getSource(changed.id)).toEqual(correction);
        } finally { await reopened.close(); }
      } finally {
        await result;
        service.dispose();
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
    expect(context.store.getNode(acceptedFact.id)).toEqual(acceptedFact);
    expect(context.store.listEdges().some((edge) => edge.fromId === acceptedFact.id
      && edge.metadata.linkedBy === 'homegraph-ask-page-refresh')).toBe(true);
    expect(context.store.listEdges().some((edge) => edge.fromId === accepted.id && edge.toId === acceptedFact.id
      && edge.relation === 'supports_fact')).toBe(true);
    expect(context.store.listEdges().some((edge) => edge.fromId === acceptedFact.id && edge.toId === context.device.id
      && edge.relation === 'describes')).toBe(true);
    expect(fake.requests.filter(({ state }) => (state as ReadingState).candidate?.title === rejected.title)).toHaveLength(1);
  });
  test('a write-entry hold preserves the published page and concurrent fact edit', async () => {
    const context = await fixture();
    await addSource(context, 'profile-reference', { profile: true });
    readings();
    const priorPage = await generate(context, 'passport');
    const priorArtifacts = context.artifactStore.list();
    const fact = context.store.listNodes().find((node) => node.kind === 'fact')!;
    expect(fact).toBeDefined();
    const racingStore = Object.create(context.store) as KnowledgeStore;
    let concurrent: KnowledgeNodeRecord | undefined;
    const commit = racingStore.upsertPreparedNode.bind(racingStore);
    racingStore.upsertPreparedNode = async (prepared, index) => {
      const node = await commit(prepared, index);
      if (node.kind === 'ha_device_passport') concurrent = await context.store.upsertNode({
        ...fact, summary: 'Concurrent operator correction.',
      }, createKnowledgeNodeOperatorMutation(fact, { action: 'reject', reviewer: 'fixture-operator' }));
      return node;
    };
    await expect(generate({ ...context, store: racingStore }, 'passport')).rejects.toThrow();
    expect(context.store.getNode(fact.id)).toEqual(concurrent!);
    expect(context.store.getSource(priorPage.source!.id)).toEqual(priorPage.source!);
    expect(context.artifactStore.list()).toEqual(priorArtifacts);
  });

  test('mid-profile cancellation preserves published pages and concurrent edits without compensation', async () => {
    const context = await fixture();
    const source = await addSource(context, 'multi-profile-reference', { profile: true });
    const extraction = context.store.getExtractionBySourceId(source.id)!;
    const text = 'The reference device has 4K UHD 3840 x 2160 resolution, 120 Hz, HDMI 2.1, USB, Ethernet, Bluetooth, Wi-Fi, and 2 x 10W speakers.';
    await context.store.upsertExtraction({ ...extraction, excerpt: text, structure: { searchText: text } });
    readings(); const priorPage = await generate(context, 'passport');
    const priorArtifacts = context.artifactStore.list();
    const facts = context.store.listNodes().filter((node) => node.kind === 'fact');
    expect(facts.length).toBeGreaterThan(1);
    const controller = new AbortController();
    const racingStore = Object.create(context.store) as KnowledgeStore;
    let touched: KnowledgeNodeRecord | undefined;
    let concurrent: KnowledgeNodeRecord | undefined;
    const commitPrepared = racingStore.upsertPreparedNode.bind(racingStore);
    racingStore.upsertPreparedNode = async (prepared, index) => {
      const node = await commitPrepared(prepared, index);
      if (node.kind === 'fact' && touched === undefined) {
        touched = node;
        const untouched = facts.find((fact) => fact.id !== node.id)!;
        const summary = 'Concurrent correction outside this write pass.';
        concurrent = await context.store.upsertNode({ ...untouched, summary }, createKnowledgeNodeOperatorMutation(untouched, {
          action: 'revise', reviewer: 'fixture-operator', fieldCorrections: [{ path: ['summary'], value: summary }],
        }));
        controller.abort();
      }
      return node;
    };
    await expect(generate({ ...context, store: racingStore }, 'passport', controller.signal)).rejects.toThrow();
    expect(touched).toBeDefined(); expect(concurrent).toBeDefined();
    expect(context.store.getNode(touched!.id)).toEqual(touched!);
    expect(context.store.getSource(priorPage.source!.id)).toEqual(priorPage.source!);
    expect(context.artifactStore.list()).toEqual(priorArtifacts);
    expect(context.store.getNode(concurrent!.id)).toEqual(concurrent!);
  });

});
