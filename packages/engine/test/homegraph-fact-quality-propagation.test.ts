import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createWorkLedger } from '../sdk/src/platform/workflow/work-ledger/service.js';
import { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { buildHomeGraphMetadata } from '../sdk/src/platform/knowledge/home-graph/helpers.js';
import { renderDevicePassportPage } from '../sdk/src/platform/knowledge/home-graph/rendering.js';
import { refreshDevicePagesForHomeGraphAsk } from '../sdk/src/platform/knowledge/home-graph/ask-page-refresh.js';
import { generateHomeGraphRoomPage, refreshHomeGraphDevicePassport } from '../sdk/src/platform/knowledge/home-graph/generated-pages.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';
import { withTestTimeout } from './_helpers/test-timeout.js';

const spaceId = 'homeassistant:fact-quality-propagation';
const installationId = 'fact-quality-propagation';
const roots: string[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function readings(probability = 0.99) {
  const fake = fakePort((name, question) => {
    if (name === 'authority') return choiceAnswer(question, 'official-vendor', 0.99);
    if (name === 'repairUseful') return noulAnswer(probability);
    if (['wanted', 'selected', 'profileSupported', 'batteryApplicable', 'manufacturerPresent', 'modelPresent', 'batteryTypePresent'].includes(name)) return noulAnswer(0.01);
    if (['serve', 'supported', 'attached', 'useful'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unexpected fact-quality question: ${name}`);
  });
  installJudgmentPort(fake.port);
  return fake;
}
async function fixture() {
  readings();
  const root = mkdtempSync(join(tmpdir(), 'homegraph-fact-quality-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); await store.init();
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const metadata = (extra = {}) => buildHomeGraphMetadata(spaceId, installationId, extra);
  const device = await seedHomeAssistantObservation(store, { id: 'subject-device', kind: 'ha_device', slug: 'subject-device', title: 'Reference appliance', status: 'active', metadata: metadata({ homeAssistant: { objectId: 'appliance', objectKind: 'device' } }) });
  const source = await store.upsertSource({ id: 'device-manual', connectorId: 'homeassistant', sourceType: 'manual', title: 'Reference appliance manual', status: 'indexed', canonicalUri: 'https://reference.example.test/manual', summary: 'Replace the appliance filter every six months.', metadata: metadata() });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'text', format: 'text', excerpt: 'Replace the appliance filter every six months.', metadata: metadata() });
  const fact = await store.upsertNode({ id: 'filter-interval', kind: 'fact', slug: 'filter-interval', title: 'Filter replacement', summary: 'Replace the appliance filter every six months.', status: 'active', sourceId: source.id, metadata: metadata({ semanticKind: 'fact', factKind: 'maintenance', value: 'Every six months', evidence: 'Replace the appliance filter every six months.', sourceId: source.id, sourceIds: [source.id], subjectIds: [device.id], linkedObjectIds: [device.id] }) });
  await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: device.id, relation: 'has_manual', metadata: metadata() });
  await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: fact.id, relation: 'supports_fact', metadata: metadata() });
  await store.upsertEdge({ fromKind: 'node', fromId: fact.id, toKind: 'node', toId: device.id, relation: 'describes', metadata: metadata() });
  return { store, artifactStore, spaceId, installationId, fact, source, device };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function generate(context: Fixture, kind: 'room' | 'passport', signal?: AbortSignal) {
  return kind === 'room' ? generateHomeGraphRoomPage({ ...context, input: {}, signal }) : refreshHomeGraphDevicePassport({ ...context, input: { deviceId: 'appliance' }, signal });
}
function persisted(context: Fixture) {
  return JSON.stringify({ nodes: context.store.listNodesInSpace(spaceId), sources: context.store.listSourcesInSpace(spaceId), edges: context.store.listEdges(), artifacts: context.artifactStore.list() });
}

describe('Home Graph complete-fact quality propagation', () => {
  test('the synchronous renderer rejects an unprepared predicate disguised as a plan', async () => {
    const context = await fixture();
    expect(() => renderDevicePassportPage({ spaceId, device: context.device, entities: [], sources: [context.source],
      issues: [], missingFields: [], semanticFacts: [context.fact],
      factPlan: { facts: [context.fact], accepts: () => true, assertCurrent() {}, acknowledgeWritten() {}, acknowledgeEdgeWritten() {} },
    })).toThrow('prepared page fact quality plan');
  });

  test('ask refresh propagates an unavailable fact reading before enrichment writes', async () => {
    const context = await fixture();
    await generate(context, 'passport');
    const fake = readings();
    installJudgmentPort({ ...fake.port, async ask(request) {
      if ('repairUseful' in request.questions) throw new Error('Fact quality unavailable');
      return fake.port.ask(request);
    } });
    const before = persisted(context);
    await expect(refreshDevicePagesForHomeGraphAsk({ ...context, answer: {
      ok: true, spaceId, query: 'When should the filter be replaced?', results: [],
      answer: { text: 'Every six months.', mode: 'standard', confidence: 95,
        sources: [context.source], facts: [context.store.getNode(context.fact.id)!], linkedObjects: [context.device] },
    } })).rejects.toThrow();
    expect(persisted(context)).toBe(before);
  });

  for (const kind of ['room', 'passport'] as const) {
    test(`${kind} accepts maintenance and excludes a settled negative reading`, async () => {
      const context = await fixture();
      const fake = readings();
      expect((await generate(context, kind)).markdown).toContain('Filter replacement: Every six months');
      expect(fake.requests.some((request) => 'repairUseful' in request.questions)).toBe(true);
      readings(0.01);
      expect((await generate(context, kind)).markdown).not.toContain('Filter replacement');
    });

    for (const failure of ['missing', 'malformed'] as const) {
      test(`${kind} preserves the previous page when fact reading is ${failure}`, async () => {
        const context = await fixture();
        await generate(context, kind);
        const fake = readings();
        installJudgmentPort({ ...fake.port, async ask(request) {
          if ('repairUseful' in request.questions) {
            if (failure === 'missing') throw new Error('No fact quality reader available');
            return { model: fake.port.model, answers: {} } as never;
          }
          return fake.port.ask(request);
        } });
        const before = persisted(context);
        await expect(generate(context, kind)).rejects.toThrow();
        expect(persisted(context)).toBe(before);
      });
    }

    for (const retirement of ['object', 'source', 'port'] as const) {
      test(`${kind} preserves its page when ${retirement} retires during artifact creation`, async () => {
        const context = await fixture();
        const previousPage = await generate(context, kind);
        const oldArtifacts = context.artifactStore.list();
        const currentFact = context.store.getNode(context.fact.id)!;
        await context.store.replaceNodeRecord({ ...currentFact, summary: 'Replace the appliance filter every six months. Keep a spare filter.' });
        const create = context.artifactStore.create.bind(context.artifactStore);
        const intercepted = spyOn(context.artifactStore, 'create').mockImplementation(async (input) => {
          const artifact = await create(input);
          if (retirement === 'object') {
            const selected = context.store.getNode(context.fact.id)!;
            await context.store.replaceNodeRecord({ ...selected, summary: `${selected.summary} Replacement by another writer.` });
            expect(context.store.getNode(selected.id)).not.toBe(selected);
          }
          if (retirement === 'source') await context.store.replaceSourceRecord({ ...context.source, status: 'stale' });
          if (retirement === 'port') readings();
          return artifact;
        });
        try {
          await expect(generate(context, kind)).rejects.toThrow();
          expect(context.store.getSource(previousPage.source!.id)).toEqual(previousPage.source!);
          expect(context.artifactStore.list()).toEqual(oldArtifacts);
        } finally { intercepted.mockRestore(); }
      });
    }

    for (const failure of ['abort', 'stale'] as const) {
      test(`${kind} preserves the previous page after ${failure} during fact reading`, async () => {
        const context = await fixture(); await generate(context, kind);
        const fake = readings(), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
        installJudgmentPort({ ...fake.port, async ask(request) {
          const result = await fake.port.ask(request);
          if ('repairUseful' in request.questions) { entered.resolve(); await released.promise; }
          return result;
        } });
        const controller = new AbortController();
        const pending = generate(context, kind, controller.signal).then(() => undefined, (error: unknown) => error);
        try {
          await withTestTimeout(entered.promise);
          if (failure === 'abort') controller.abort();
          else await context.store.replaceNodeRecord({ ...context.fact, summary: 'Concurrent corrected interval.' });
          const before = persisted(context); released.resolve();
          expect(await pending).toBeInstanceOf(Error);
          expect(persisted(context)).toBe(before);
        } finally { released.resolve(); await pending; }
      });
    }
  }
});

test('prepared page rendering preserves qualifiers, numeric values, units and opposite signs', async () => {
  const context = await fixture();
  const { createHomeGraphPageFactReader } = await import('../sdk/src/platform/knowledge/home-graph/page-quality.js');
  const { renderDevicePassportPage } = await import('../sdk/src/platform/knowledge/home-graph/rendering.js');
  const claims = [
    { title: 'Bluetooth', value: 'Supported', summary: 'Bluetooth is supported only with adapter X.' },
    { title: 'Offset', value: '+5 V', summary: 'Positive offset is +5 V.' },
    { title: 'Offset', value: '-5 V', summary: 'Negative offset is -5 V.' },
    { title: 'Mass in kilograms', value: 12, summary: 'The mass is 12 kg without the adapter.' },
    { title: 'Polarity configuration', value: { voltage: '-5 V', adapter: 'X' }, summary: 'The output is -5 V only with adapter X.' },
  ];
  const fake = fakePort((name) => {
    if (['repairUseful', 'serve', 'supported', 'attached'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unexpected exact rendering question ${name}`);
  }); installJudgmentPort(fake.port);
  await context.store.upsertExtraction({ sourceId: context.source.id, extractorId: 'text', format: 'text', excerpt: claims.map((claim) => claim.summary).join('\n'), metadata: { knowledgeSpaceId: spaceId } });
  const facts = [];
  for (const [index, claim] of claims.entries()) facts.push(await context.store.upsertNode({
    id: `qualified-${index}`, kind: 'fact', slug: `qualified-${index}`, title: claim.title, summary: claim.summary, sourceId: context.source.id, status: 'active',
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', value: claim.value, evidence: claim.summary },
  }));
  const factPlan = await createHomeGraphPageFactReader(context.store, { spaceId, query: 'Reference appliance exact specifications', subjects: [context.device] }).prepare(facts);
  const markdown = renderDevicePassportPage({ spaceId, device: context.device, entities: [], sources: [context.source], issues: [], missingFields: [], semanticFacts: facts, factPlan });
  expect(markdown).toContain('only with adapter X'); expect(markdown).toContain('+5 V'); expect(markdown).toContain('-5 V');
  expect(markdown).toContain('Mass in kilograms: 12'); expect(markdown).toContain('without the adapter');
  expect(markdown).toContain('{"voltage":"-5 V","adapter":"X"}');
});

for (const outcome of ['success', 'cancel', 'failure', 'authority'] as const) {
  test(`concurrent passport refresh retains queued request ownership and releases after ${outcome}`, async () => {
    const context = await fixture();
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const original = context.artifactStore.create.bind(context.artifactStore);
    let calls = 0;
    const create = spyOn(context.artifactStore, 'create').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) { enter(); await pause; if (outcome === 'failure') throw new Error('First artifact unavailable'); }
      return original(...args);
    });
    const first = generate(context, 'passport').then((value) => ({ value }), (error: unknown) => ({ error }));
    await withTestTimeout(entered);
    const controller = new AbortController();
    const second = generate(context, 'passport', controller.signal).then((value) => ({ value }), (error: unknown) => ({ error }));
    if (outcome === 'cancel') controller.abort();
    if (outcome === 'authority') readings();
    release();
    try {
      const [one, two] = await Promise.all([first, second]);
      if (outcome === 'failure' || outcome === 'authority') expect(one).toHaveProperty('error');
      else expect(one).toHaveProperty('value');
      if (outcome === 'cancel' || outcome === 'authority') expect(two).toHaveProperty('error');
      else expect(two).toHaveProperty('value');
      if (outcome === 'cancel' || outcome === 'authority') expect(calls).toBe(1);
      const final = await generate(context, 'passport');
      expect(final.markdown).toContain('Every six months');
    } finally { release(); create.mockRestore(); }
  });
}

for (const change of ['fact', 'twice', 'source', 'subject', 'port', 'cancel'] as const) {
  test(`Ask page recovery rejudges genuine fact changes once and preserves ${change} lifetime`, async () => {
    const context = await fixture(); const controller = new AbortController();
    const original = context.artifactStore.create.bind(context.artifactStore); let creations = 0;
    const create = spyOn(context.artifactStore, 'create').mockImplementation(async (...args) => {
      const artifact = await original(...args); creations += 1;
      if (creations === 1 || change === 'twice') {
        const fact = context.store.getNode(context.fact.id)!;
        await context.store.replaceNodeRecord({ ...fact, summary: `Replace the appliance filter every six months. Revision ${creations}.` });
        if (change === 'source') await context.store.replaceSourceRecord({ ...context.source, title: 'Replaced source owner' });
        if (change === 'subject') await seedHomeAssistantObservation(context.store, { ...context.device, title: 'Replaced device owner' });
        if (change === 'port') readings();
        if (change === 'cancel') controller.abort();
      }
      return artifact;
    });
    try {
      const result = refreshDevicePagesForHomeGraphAsk({ ...context, signal: controller.signal, answer: {
        ok: true, spaceId, query: 'When should the filter be replaced?', results: [],
        answer: { text: 'Every six months.', mode: 'standard', confidence: 95,
          sources: [context.source], facts: [context.fact], linkedObjects: [context.device] },
      } });
      if (change === 'fact') { expect(await result).toEqual({ requested: true, refreshed: 1 }); expect(creations).toBe(2); }
      else { await expect(result).rejects.toThrow(); expect(creations).toBe(change === 'twice' ? 2 : 1); }
      if (change !== 'fact') expect(context.store.listSources().filter((source) => source.metadata.generatedProjection === true)).toHaveLength(0);
    } finally { create.mockRestore(); }
  });
}

test('different device and space queue keys progress independently', async () => {
  const context = await fixture();
  const { withDevicePageRefresh } = await import('../sdk/src/platform/knowledge/home-graph/page-refresh-queue.js');
  let release!: () => void; const paused = new Promise<void>((resolve) => { release = resolve; });
  const first = withDevicePageRefresh(context.store, JSON.stringify(['space-a', 'device-a']), undefined, () => 'request', () => paused);
  try {
    await withTestTimeout(withDevicePageRefresh(context.store, JSON.stringify(['space-a', 'device-b']), undefined, () => 'request', async () => 'second'));
    await withTestTimeout(withDevicePageRefresh(context.store, JSON.stringify(['space-b', 'device-a']), undefined, () => 'request', async () => 'third'));
  } finally { release(); await first; }
});

test('unrelated fact churn cannot turn generic stale into Ask retry permission', async () => {
  const context = await fixture();
  const { createAskPageRecovery } = await import('../sdk/src/platform/knowledge/home-graph/ask-page-recovery.js');
  const { KnowledgeRepairFactUsefulnessHeldError } = await import('../sdk/src/platform/knowledge/semantic/repair-usefulness/types.js');
  const recovery = createAskPageRecovery(context.store, spaceId, () => {}); let calls = 0;
  await expect(recovery.run(async () => {
    calls += 1; await context.store.replaceNodeRecord({ ...context.fact, summary: 'Changed unrelated fact.' });
    throw new KnowledgeRepairFactUsefulnessHeldError('stale');
  })).rejects.toThrow();
  expect(calls).toBe(1);
});

test('Ask edge receipt never adopts a concurrent replacement during save', async () => {
  const context = await fixture(); const original = context.store.applyPreparedIngest.bind(context.store); let newer: unknown;
  const write = spyOn(context.store, 'applyPreparedIngest').mockImplementation(async (...args) => {
    const receipt = await original(...args);
    const edge = receipt.edges.find((entry) => entry.relation === 'supports_fact');
    if (edge && !newer) newer = await context.store.upsertEdge({ ...edge, metadata: { ...edge.metadata, writer: 'concurrent-owner' } });
    return receipt;
  });
  try { await expect(refreshDevicePagesForHomeGraphAsk({ ...context, answer: {
    ok: true, spaceId, query: 'Filter interval?', results: [], answer: { text: 'Every six months.', mode: 'standard', confidence: 95,
      sources: [context.source], facts: [context.fact], linkedObjects: [context.device] },
  } })).rejects.toThrow(); }
  finally { write.mockRestore(); }
  expect(context.store.listEdges()).toContain(newer as ReturnType<KnowledgeStore['listEdges']>[number]);
  expect(context.store.listSources().filter((source) => source.metadata.generatedProjection === true)).toHaveLength(0);
});
