import { repairScoringFixtureReading } from './_helpers/repair-scoring-fixture-readings.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../sdk/src/platform/knowledge/types.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { promoteRepairSources, type SelfImprovePromotionContext } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { repairSubjectFixtureReading } from './_helpers/repair-subject-fixture-readings.js';
import { repairUsefulFixtureReading } from './_helpers/repair-profile-fixture-readings.js';

const spaceId = 'cooperative-repair-resume';
const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  installJudgmentPort(previous);
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-repair-resume-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
  const input = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'gap', title: 'Display inputs',
    metadata: { knowledgeSpaceId: spaceId } };
  const gap = await upsertObservedKnowledgeNode(store, input, 'research-task', input, () => input);
  const source = await store.upsertSource({ id: 'pending-text', connectorId: 'synthetic', sourceType: 'manual',
    title: 'Awaiting extracted text', status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
  let requests = 0;
  installJudgmentPort({ model: 'must-not-read', async ask() {
    requests++; throw new Error('Stopped empty repair must not ask a question');
  } });
  const snapshot = () => JSON.stringify({ nodes: store.listNodes(), sources: store.listSources(),
    edges: store.listEdges(), tasks: store.listRefinementTasks() });
  return { store, gap, source, task, snapshot, requests: () => requests };
}

const repairClaims = [
  ['Smart TV platform and integrations', 'AC-7 supports webOS and an ATSC tuner.'],
  ['Network and wireless capabilities', 'AC-7 supports Wi-Fi and Bluetooth wireless connectivity.'],
  ['Input and output ports', 'AC-7 includes four HDMI inputs and two USB ports.'],
] as const;
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Unexpected synthetic repair state');
  return value;
}
function storedRepairReadings(sourceTexts: readonly string[]) {
  const supportedClaim = (value: unknown) => {
    const claim = record(value);
    return repairClaims.some(([title, statement]) => claim.title === title && claim.summary === `${title}: ${statement}`);
  };
  const fake = fakePort((name, _question, state) => {
    const input = record(state);
    if (['Does AC-7 support webOS?', 'What TV platform and wireless connections does AC-7 support?'].includes(String(input.query))) {
      if (name === 'fullProfileRequired') return noulAnswer(0.01);
      if (name === 'repairEvidenceSufficient') return noulAnswer(0.99);
    }
    const scored = repairScoringFixtureReading(name, _question, state, repairClaims);
    if (scored !== undefined) return scored;
    if (name === 'repairSubjectSelected') return noulAnswer(repairSubjectFixtureReading(state, [['AC-7', 0.99]]));
    if (name === 'repairUseful') return noulAnswer(repairUsefulFixtureReading(state, repairClaims));
    if (name === 'serve' && supportedClaim(input.candidate)) {
      const candidate = record(input.candidate);
      const statement = repairClaims.find(([title]) => title === candidate.title)?.[1];
      const evidence = input.evidence;
      if (statement !== undefined && Array.isArray(evidence) && evidence.some(value => {
        const excerpt = record(record(value).extraction).excerpt;
        return typeof excerpt === 'string' && sourceTexts.includes(excerpt) && excerpt.includes(statement);
      })) return noulAnswer(0.99);
    }
    if ((name === 'supported' || name === 'attached') && supportedClaim(input.claim)) {
      const extraction = record(input.extraction);
      const claim = record(input.claim);
      const statement = repairClaims.find(([title]) => title === claim.title)?.[1];
      if (typeof extraction.excerpt === 'string' && sourceTexts.includes(extraction.excerpt)
        && statement !== undefined && extraction.excerpt.includes(statement)) {
        if (name === 'attached' && record(input.subject).title === 'AC-7') return noulAnswer(0.99);
        if (name === 'supported') {
          const field = record(input.field), hint = field.value;
          const fields = { kind: 'feature', title: claim.title, summary: claim.summary, value: statement, evidence: statement, subject: 'AC-7' };
          if (typeof field.name === 'string' && Object.hasOwn(fields, field.name) && record(fields)[field.name] === hint) return noulAnswer(0.99);
          if (field.name === 'targetHints[0]' && typeof hint === 'object' && hint !== null
            && record(hint).title === 'AC-7' && record(hint).kind === 'ha_device') return noulAnswer(0.99);
        }
      }
    }
    throw new Error(`Unscripted stored repair question ${name}`);
  });
  installJudgmentPort(fake.port);
  return fake;
}
async function usefulFixture(combined = false) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-repair-completed-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite');
  const store = new KnowledgeStore({ dbPath }); stores.push(store);
  const raw = { id: 'subject', kind: 'ha_device' as const, slug: 'ac-seven', title: 'AC-7', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, model: 'AC-7' } };
  const subject = await upsertObservedKnowledgeNode(store, raw, 'home-assistant-snapshot', raw, () => raw);
  // The first combined source has no extracted facts. The second already has
  // two independent facts, the minimum needed to verify the complete union.
  // This control never invents profile readings to reach it.
  const groups = combined ? [[], repairClaims.slice(0, 2)] : [[repairClaims[0]]];
  const texts = groups.map(group => group.map(([, statement]) => statement).join('\n\n'));
  const readings = storedRepairReadings(texts);
  const sources: KnowledgeSourceRecord[] = [], facts: KnowledgeNodeRecord[] = [];
  for (const [index, group] of groups.entries()) {
    const source = await store.upsertSource({ id: `source-${index + 1}`, connectorId: 'synthetic', sourceType: 'manual',
      title: `AC-7 manual ${index + 1}`, status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
    sources.push(source);
    await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: texts[index], metadata: { knowledgeSpaceId: spaceId } });
    for (const [title, statement] of group) facts.push(await store.upsertNode({ id: `fact-${facts.length + 1}`, kind: 'fact',
      slug: `fact-${facts.length + 1}`, title, summary: `${title}: ${statement}`, status: 'active', sourceId: source.id,
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'feature', evidence: statement, value: statement,
        sourceIds: [source.id], subjectIds: [subject.id], linkedObjectIds: [subject.id], subject: subject.title } }));
  }
  const input = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'gap', title: combined ? 'What TV platform and wireless connections does AC-7 support?' : 'Does AC-7 support webOS?',
    status: 'active' as const, metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [subject.id] } };
  const gap = await upsertObservedKnowledgeNode(store, input, 'research-task', input, () => input);
  const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
  const receipts: Awaited<ReturnType<KnowledgeStore['applyPreparedIngest']>>[] = [];
  const apply = store.applyPreparedIngest.bind(store);
  store.applyPreparedIngest = (...args) => {
    const pending = apply(...args);
    // Observe the real settled receipt without changing the native returned promise.
    void pending.then(receipt => { receipts.push(receipt); }, () => {});
    return pending;
  };
  const snapshot = () => JSON.stringify({ nodes: store.listNodes(), sources: store.listSources(), extractions: store.listExtractions(),
    edges: store.listEdges(), tasks: store.listRefinementTasks() });
  return { store, subject, sources, facts, gap, task, dbPath, readings, receipts, snapshot };
}

describe('repair passes resume under their original caller', () => {
  test('native timer cancellation before the next pass prevents questions and bookkeeping', async () => {
    const item = await fixture(), before = item.snapshot(), controller = new AbortController();
    const observed = Promise.withResolvers<void>();
    const timer = setTimeout(() => { controller.abort(); observed.resolve(); }, 0);
    try {
      await expect(promoteRepairSources({ store: item.store, shouldStop: () => controller.signal.aborted },
        spaceId, item.gap, [item.source.id], item.task, Date.now() + 5_000))
        .rejects.toMatchObject({ name: 'KnowledgeSourceQualityHeldError', reason: 'aborted' });
      await observed.promise;
      expect(controller.signal.aborted).toBe(true);
      expect(item.requests()).toBe(0);
      expect(item.snapshot()).toBe(before);
      expect(item.store.getRefinementTask(item.task.id)).toBe(item.task);
    } finally {
      clearTimeout(timer);
    }
  });

  test('native timer mutation of the original request cannot become a new pass baseline', async () => {
    const item = await fixture(), before = item.snapshot(), sourceIds = [item.source.id];
    const observed = Promise.withResolvers<void>();
    const timer = setTimeout(() => { sourceIds.push('later-source'); observed.resolve(); }, 0);
    try {
      await expect(promoteRepairSources({ store: item.store },
        spaceId, item.gap, sourceIds, item.task, Date.now() + 5_000))
        .rejects.toMatchObject({ name: 'KnowledgeRepairSourceAuthorityHeldError', reason: 'stale' });
      await observed.promise;
      expect(sourceIds).toEqual([item.source.id, 'later-source']);
      expect(item.requests()).toBe(0);
      expect(item.snapshot()).toBe(before);
      expect(item.store.getRefinementTask(item.task.id)).toBe(item.task);
    } finally {
      clearTimeout(timer);
    }
  });

  test('a completed sufficient pass preserves its actual native fact receipt through durable task publication', async () => {
    const item = await usefulFixture();
    const result = await promoteRepairSources({ store: item.store, enrichSource: async () => {
      throw new Error('Already sufficient native evidence must not start enrichment');
    } }, spaceId, item.gap, item.sources.map(source => source.id), item.task, Date.now() + 20_000);
    expect(result).toEqual({ promotedFactCount: 1, repairComplete: true, promotedSourceIds: [item.sources[0]!.id] });
    expect(item.receipts).toHaveLength(1);
    const written = item.receipts[0]!.nodes[0]!;
    expect(written.id).toBe(item.facts[0]!.id);
    expect(item.store.getNode(written.id)).toBe(written);
    expect(item.store.listEdges().filter(edge => edge.relation === 'describes').map(edge => edge.fromId)).toEqual([written.id]);
    expect(item.store.getRefinementTask(item.task.id)).toMatchObject({ state: 'verified', promotedFactCount: 1, metadata: { promotedFactCount: 1 } });
    await item.store.close(); stores.splice(stores.indexOf(item.store), 1);
    const reopened = new KnowledgeStore({ dbPath: item.dbPath }); stores.push(reopened); await reopened.init();
    expect(reopened.getNode(written.id)?.summary).toBe(written.summary);
    expect(reopened.listEdges().filter(edge => edge.relation === 'describes').map(edge => edge.fromId)).toEqual([written.id]);
    expect(reopened.getRefinementTask(item.task.id)).toMatchObject({ state: 'verified', promotedFactCount: 1, metadata: { promotedFactCount: 1 } });
  });

  test.each(['source replacement and restoration', 'caller callback replacement', 'caller cancellation', 'judgment owner replacement and restoration'] as const)(
    'the completed original count holds on %s at the final native task boundary', async change => {
      const item = await usefulFixture(), controller = new AbortController();
      const context: SelfImprovePromotionContext = { store: item.store, shouldStop: () => controller.signal.aborted,
        enrichSource: async () => { throw new Error('Already sufficient native evidence must not start enrichment'); } };
      const batch = item.store.batch.bind(item.store);
      let entered = 0, beforePublication = '', requestCount = -1;
      item.store.batch = async operation => {
        entered++;
        if (change === 'source replacement and restoration') {
          const source = item.sources[0]!;
          await item.store.replaceSourceRecord({ ...source, title: 'AC-8 changed manual' });
          await item.store.replaceSourceRecord(source);
        } else if (change === 'caller callback replacement') {
          Object.defineProperty(context, 'shouldStop', { value: () => false, configurable: true, enumerable: true, writable: true });
        } else if (change === 'caller cancellation') controller.abort();
        else {
          installJudgmentPort({ model: 'retired-synthetic-owner', async ask() { throw new Error('Retired owner must not receive requests'); } });
          installJudgmentPort(item.readings.port);
        }
        beforePublication = item.snapshot(); requestCount = item.readings.requests.length;
        return batch(operation);
      };
      await expect(promoteRepairSources(context, spaceId, item.gap, item.sources.map(source => source.id), item.task, Date.now() + 20_000))
        .rejects.toMatchObject({ reason: change === 'caller cancellation' ? 'aborted' : 'stale' });
      expect(entered).toBe(1);
      expect(item.receipts).toHaveLength(1);
      expect(item.store.getNode(item.facts[0]!.id)).toBe(item.receipts[0]!.nodes[0]!);
      expect(item.store.listEdges().filter(edge => edge.relation === 'describes')).toHaveLength(1);
      expect(item.store.getRefinementTask(item.task.id)).toBe(item.task);
      expect(item.snapshot()).toBe(beforePublication);
      expect(item.readings.requests).toHaveLength(requestCount);
    });

  test('a processed two-source union still settles the complete combined native link and count', async () => {
    const item = await usefulFixture(true);
    const enriched: string[] = [];
    const result = await promoteRepairSources({ store: item.store, enrichSource: async sourceId => { enriched.push(sourceId); } },
      spaceId, item.gap, item.sources.map(source => source.id), item.task, Date.now() + 20_000);
    const factIds = item.facts.map(fact => fact.id).sort();
    expect(result).toEqual({ promotedFactCount: 2, repairComplete: true, promotedSourceIds: item.sources.map(source => source.id) });
    expect(enriched).toEqual([item.sources[0]!.id]);
    const combined = item.receipts.at(-1)!;
    expect(combined.nodes.map(node => node.id).sort()).toEqual(factIds);
    expect(item.receipts).toHaveLength(2);
    expect(item.receipts.filter(receipt => receipt.nodes.length === 2)).toHaveLength(2);
    for (const written of combined.nodes) expect(item.store.getNode(written.id)).toBe(written);
    expect(item.store.listEdges().filter(edge => edge.relation === 'describes').map(edge => edge.fromId).sort()).toEqual(factIds);
    expect(item.store.getRefinementTask(item.task.id)).toMatchObject({ state: 'verified', promotedFactCount: 2, metadata: { promotedFactCount: 2 } });
  });
});
