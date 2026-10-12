import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort, bindJudgmentPortAuthority } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort, Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { SQLiteStore } from '../sdk/src/platform/state/sqlite-store.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import type { KnowledgeObjectProfilePolicy } from '../sdk/src/platform/knowledge/extensions.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
import { KnowledgeSemanticService } from '../sdk/src/platform/knowledge/semantic/service.js';
import { classifyGap, type GapContext } from '../sdk/src/platform/knowledge/semantic/self-improvement-gap-context.js';
import { discoverIntrinsicGaps } from '../sdk/src/platform/knowledge/semantic/self-improvement-intrinsic-gaps.js';
import { canonicalRepairSubjectNodes } from '../sdk/src/platform/knowledge/semantic/repair-subjects.js';
import { prepareSelfImprovementAssessment } from '../sdk/src/platform/knowledge/semantic/self-improvement-assessment/plan.js';
import { readSelfImprovementAssessment, KnowledgeSelfImprovementAssessmentHeldError as Held,
  type SelfImprovementAssessmentInput } from '../sdk/src/platform/knowledge/semantic/self-improvement-assessment/reader.js';
import { selfImprovementGapContext, selfImprovementEvidenceCoverage } from '../sdk/src/platform/knowledge/semantic/self-improvement-assessment/battery.js';
import { repairProfileRequirement } from '../sdk/src/platform/knowledge/semantic/repair-profile-requirement/battery.js';
import { prepareRepairProfileRequirement } from '../sdk/src/platform/knowledge/semantic/repair-profile-requirement/reader.js';
import { KnowledgeRepairFactScoringHeldError } from '../sdk/src/platform/knowledge/semantic/repair-fact-scoring/types.js';
import { registry } from '../sdk/src/platform/knowledge/judgment-registry.js';
import { registry as requirementRegistry } from '../sdk/src/platform/gate/judgment-registry.js';
import { captureStrictJudgmentJson } from '../sdk/src/platform/gate/judgment-result.js';
import { gapAssessmentFixture, selfImprovementFixtureReading } from './_helpers/knowledge-self-improvement-readings.js';
import { isKnowledgeSourceQualityFailure } from '../sdk/src/platform/knowledge/source-quality.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { knowledgeRecordVersion } from '../sdk/src/platform/knowledge/store-record-representation.js';

const spaceId = 'house';
const subjectTitle = 'Kitchen probe';
const narrowQuery = 'What are the full details of its sensing channel count?';
const broadQuery = 'Give the entire feature and specification profile.';
const statement = 'The kitchen probe has two sensing channels.';
const roots: string[] = [], stores: KnowledgeStore[] = [];
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function input(query = narrowQuery): SelfImprovementAssessmentInput {
  return { query, subjects: [{ title: subjectTitle, kind: 'ha_device', aliases: [], identity: {}, content: { batteryPowered: true } }],
    facts: [{ title: 'Sensing channels', kind: 'specification', aliases: [], content: { value: 2, evidence: statement } }],
    evidence: [{ source: { title: 'Kitchen probe manual', sourceType: 'manual' }, text: statement }], objectProfiles: [] };
}
function sameQuestion(question: Question, expected: Question): boolean {
  return isDeepStrictEqual(captureStrictJudgmentJson(question), captureStrictJudgmentJson(expected));
}
/** Only authored synthetic subject, source and fact assertions receive plumbing readings. */
function readings(options: { applicable?: number; concrete?: number; sufficient?: number; selected?: number; fullProfileRequired?: number } = {}) {
  const fake = fakePort((name, question, state) => {
    const value = state as { query?: string; candidates?: { reference: string; title: string }[]; candidate?: string | { title?: string; content?: { title?: string } }; fact?: { title: string }; subjects?: { title: string }[] };
    if (sameQuestion(question, repairProfileRequirement.items.fullProfileRequired.question)) {
      if (!value.subjects || value.subjects.some(subject => subject.title !== subjectTitle)
        || ![narrowQuery, broadQuery, `What are the complete features and specifications for ${subjectTitle}?`].includes(value.query ?? '')) throw new Error('Unscripted profile requirement');
      return noulAnswer(options.fullProfileRequired ?? new Map([[narrowQuery, 0.01], [broadQuery, 0.99], [`What are the complete features and specifications for ${subjectTitle}?`, 0.99]]).get(value.query!)!);
    }
    if (sameQuestion(question, selfImprovementGapContext.items.gapApplicable.question) || sameQuestion(question, selfImprovementGapContext.items.repairContextConcrete.question)
      || sameQuestion(question, selfImprovementEvidenceCoverage.items.repairEvidenceSufficient.question)) {
      if (!value.query || !value.subjects || value.subjects.some(subject => subject.title !== subjectTitle)) throw new Error('Unscripted assessment source');
      return noulAnswer(name === 'gapApplicable' ? options.applicable ?? 0.99 : name === 'repairContextConcrete' ? options.concrete ?? 0.99 : options.sufficient ?? 0.01);
    }
    if (name === 'repairSubjectSelected') {
      const selected = value.candidates?.find(candidate => candidate.reference === value.candidate);
      if (!selected || selected.title !== subjectTitle) throw new Error('Unscripted native subject');
      return noulAnswer(options.selected ?? 0.99);
    }
    if (name === 'repairUseful') {
      if (!value.fact || !['Sensing channels', 'Display audio network ports'].includes(value.fact.title)) throw new Error('Unscripted useful fact');
      return noulAnswer(0.99);
    }
    if (name === 'serve') {
      if (typeof value.candidate !== 'object' || !['Sensing channels', 'Display audio network ports'].includes(value.candidate.title ?? '')) throw new Error('Unscripted native serving claim');
      return noulAnswer(0.99);
    }
    if (name === 'included') {
      if (typeof value.candidate !== 'object' || ![subjectTitle, 'Kitchen probe manual', narrowQuery, broadQuery,
        'Display audio network ports', 'Sensing channels'].includes(value.candidate.content?.title ?? '')) throw new Error('Unscripted native graph candidate');
      return noulAnswer(0.99);
    }
    throw new Error('Unscripted fixture question');
  });
  installJudgmentPort(fake.port); return fake;
}
async function fixture(query = narrowQuery, factCount = 0, subjectClock?: number) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-assessment-')); roots.push(root);
  const dbPath = join(root, 'knowledge.sqlite'), store = new KnowledgeStore({ dbPath }); stores.push(store);
  const raw = { id: 'probe', kind: 'ha_device' as const, slug: 'kitchen-probe', title: subjectTitle, aliases: [], status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, batteryPowered: true } };
  let clock: { mockRestore(): void } | undefined;
  let clockReads = 0;
  if (subjectClock !== undefined) {
    await store.init();
    clock = spyOn(Date, 'now').mockImplementation(() => {
      clockReads += 1;
      clock?.mockRestore();
      return subjectClock;
    });
  }
  let subject: KnowledgeNodeRecord;
  try { subject = await upsertObservedKnowledgeNode(store, raw, 'home-assistant-snapshot', raw, () => raw); }
  finally { clock?.mockRestore(); }
  if (subjectClock !== undefined) expect(clockReads).toBe(1);
  const source = await store.upsertSource({ id: 'probe-manual', connectorId: 'fixture', sourceType: 'manual', title: 'Kitchen probe manual',
    status: 'indexed', metadata: { knowledgeSpaceId: spaceId } });
  await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', excerpt: statement,
    metadata: { knowledgeSpaceId: spaceId } });
  const facts: KnowledgeNodeRecord[] = [];
  readings();
  for (let index = 0; index < factCount; index++) {
    const title = factCount === 1 ? 'Sensing channels' : 'Display audio network ports';
    facts.push(await store.upsertNode({ id: `probe-fact-${index}`, kind: 'fact', slug: `probe-fact-${index}`, title,
      summary: statement, aliases: [], status: 'active', sourceId: source.id,
      metadata: { knowledgeSpaceId: spaceId, semanticKind: 'fact', factKind: 'specification', value: 'two sensing channels', evidence: statement,
        extractor: 'repair-promotion', sourceIds: [source.id], subjectIds: [subject.id], linkedObjectIds: [subject.id], subject: subject.title } }));
  }
  const rawGap = { id: 'probe-gap', kind: 'knowledge_gap' as const, slug: 'probe-gap', title: query, aliases: [], status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, semanticKind: 'gap', linkedObjectIds: [subject.id], sourceIds: [source.id],
      ...(factCount ? { repairStatus: 'repaired' } : {}) } };
  const gap = await upsertObservedKnowledgeNode(store, rawGap, 'research-task', rawGap, () => rawGap);
  await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: subject.id, relation: 'source_for' });
  const context: GapContext = { gap, linkedObjects: [subject], sources: [source], facts, repairSourceIds: factCount ? [source.id] : [] };
  return { dbPath, store, subject, source, gap, facts, context };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function native(item: Fixture, kind: 'context' | 'coverage' = 'context') {
  const objectProfiles: KnowledgeObjectProfilePolicy[] = [];
  return { kind, store: item.store, spaceId, query: item.gap.title, gap: item.gap,
    subjects: [item.subject], sources: [item.source], facts: kind === 'coverage' ? item.facts : [], objectProfiles };
}
function snapshot(store: KnowledgeStore): string { return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), tasks: store.listRefinementTasks() }); }
async function held(promise: Promise<unknown>, reason: Held['reason']) {
  const error: unknown = await promise.catch(error => error);
  expect(error).toBeInstanceOf(Held); expect((error as Held).reason).toBe(reason); expect(isKnowledgeSourceQualityFailure(error)).toBe(true);
}

describe('native semantic self-improvement assessment', () => {
  test('registers separate high-stakes context and coverage batteries with opposing authored cases', async () => {
    expect(registry.list().some(battery => battery.name === selfImprovementGapContext.name)).toBe(true);
    expect(registry.list().some(battery => battery.name === selfImprovementEvidenceCoverage.name)).toBe(true);
    expect(requirementRegistry.list().some(battery => battery.name === repairProfileRequirement.name)).toBe(true);
    for (const battery of [selfImprovementGapContext, selfImprovementEvidenceCoverage, repairProfileRequirement]) {
      expect(battery.accuracyFloor).toBeGreaterThanOrEqual(0.95);
      const fake = fakePort((name, _question, state) => {
        const fixture = battery.fixtures.find(fixture => JSON.stringify(fixture.state) === JSON.stringify(state));
        if (!fixture) throw new Error('Unscripted battery fixture');
        const verdict: unknown = Object.getOwnPropertyDescriptor(fixture.expect, name)?.value;
        if (!['yes', 'no', 'uncertain'].includes(String(verdict))) throw new Error('Unscripted battery item');
        return noulAnswer(verdict === 'yes' ? 0.99 : verdict === 'no' ? 0.01 : 0.5);
      });
      const checks = await battery.checkFixtures(fake.port);
      expect(checks.every(check => check.correct)).toBe(true);
    }
  });
  test('category applicability reads meaning instead of a suppressed substring', async () => {
    const item = await fixture('How do I calibrate the probe? Do not discuss battery replacement.');
    const fake = readings({ applicable: 0.99 }), before = snapshot(item.store);
    const result = await classifyGap(item.context, false, [{ id: 'probe-policy', subjectKinds: ['ha_device'], suppressedGapKinds: ['battery'] }], item.store);
    expect(result.action).toBe('repair'); expect(snapshot(item.store)).toBe(before);
    expect(JSON.stringify(fake.requests)).toContain('Do not discuss battery replacement.');
    const other = await fixture('What cells power the kitchen probe sensing module?');
    readings({ applicable: 0.01 }); const otherBefore = snapshot(other.store);
    const inverse = await classifyGap(other.context, false, [{ id: 'probe-policy', subjectKinds: ['ha_device'], suppressedGapKinds: ['energy storage'] }], other.store);
    expect(inverse.action).toBe('suppress'); expect(snapshot(other.store)).toBe(otherBefore);
  });
  test('natural battery ownership and source-only context use actual context readings', async () => {
    const item = await fixture('What powers the kitchen probe sensing module?'); readings();
    expect((await classifyGap(item.context, false, [], item.store)).action).toBe('repair');
    readings({ concrete: 0.01 });
    expect((await classifyGap({ ...item.context, linkedObjects: [] }, false, [], item.store)).status).toBe('needs_context');
    readings({ concrete: 0.99 });
    expect((await classifyGap({ ...item.context, linkedObjects: [] }, false, [], item.store)).action).toBe('repair');
  });
  test('unrelated native kind policies remain screened but cannot supply applicability exclusions', async () => {
    const item = await fixture('How do I replace the probe cell?'), fake = readings({ applicable: 0.99 });
    expect((await classifyGap(item.context, false, [{ id: 'service-policy', subjectKinds: ['service'], suppressedGapKinds: ['battery information'] }], item.store)).action).toBe('repair');
    const request = fake.requests.find(request => 'gapApplicable' in request.questions);
    expect(request?.state).toMatchObject({ objectProfiles: [] });
    const invalid: KnowledgeObjectProfilePolicy = { id: 'service-policy', subjectKinds: ['service'] };
    Object.defineProperty(invalid, 'unknown', { value: 'apiKey=synthetic-private-fixture', enumerable: true });
    const before = fake.requests.length;
    await expect(prepareSelfImprovementAssessment({ ...native(item), objectProfiles: [invalid] })).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(before);
  });
  test('pending uncertain evidence cannot acquire a changed interpretation band', async () => {
    const item = await fixture(narrowQuery, 1), fake = readings({ sufficient: 0.61 }), before = snapshot(item.store);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise;
      try { return await fake.port.ask(request); } finally { drained.resolve(); }
    } });
    const pending = prepareSelfImprovementAssessment(native(item, 'coverage')).catch(error => error);
    try {
      await entered.promise;
      const assessmentItem = selfImprovementEvidenceCoverage.items.repairEvidenceSufficient;
      const original = assessmentItem.band;
      expect(Object.isFrozen(assessmentItem)).toBe(true); expect(Object.isFrozen(original)).toBe(true);
      expect(Reflect.set(assessmentItem, 'band', { yes: { actAt: 0.6, confirmAt: 0.55 }, no: { actAt: 0.85, confirmAt: 0.7 } })).toBe(false);
      expect(assessmentItem.band).toBe(original);
      release.resolve(); const error: unknown = await pending;
      expect(error).toBeInstanceOf(Held); expect((error as Held).reason).toBe('uncertain');
      expect(snapshot(item.store)).toBe(before);
    } finally { release.resolve(); await Promise.allSettled([pending, drained.promise]); }
  });
  test('a held native assessment creates no task, repair attempt or repairer credit', async () => {
    const item = await fixture(), before = snapshot(item.store); readings({ applicable: 0.5 });
    let repairs = 0;
    const service = new KnowledgeSemanticService(item.store, { gapRepairer: async () => { repairs++;
      return { searched: true, acceptedSourceIds: [], ingestedSourceIds: [], skippedUrls: [] }; } });
    await held(service.selfImprove({ knowledgeSpaceId: spaceId, gapIds: [item.gap.id], force: true }), 'uncertain');
    expect(repairs).toBe(0); expect(item.store.listRefinementTasks()).toEqual([]); expect(snapshot(item.store)).toBe(before);
  });
  test('one accepted fact can settle an exact request even when it includes full', async () => {
    const item = await fixture(narrowQuery, 1), fake = readings({ sufficient: 0.99 }), before = snapshot(item.store);
    const result = await classifyGap(item.context, false, [], item.store);
    expect(result.action).toBe('skip'); expect(result.status).toBe('repaired'); expect(snapshot(item.store)).toBe(before);
    const coverage = fake.requests.find(request => 'repairEvidenceSufficient' in request.questions);
    expect(coverage?.state).toMatchObject({ query: narrowQuery, requestedScope: { fullProfileRequired: false }, facts: [{ title: 'Sensing channels' }] });
    expect(fake.requests.filter(request => 'fullProfileRequired' in request.questions)).toHaveLength(1);
    expect(fake.requests.some(request => 'repairUseful' in request.questions)).toBe(true);
  });
  test('a retained independently read requirement reaches coverage without replacing the exact query', async () => {
    const item = await fixture(narrowQuery, 1), fake = readings({ sufficient: 0.99 });
    const requirement = await prepareRepairProfileRequirement({ query: item.gap.title, subjects: [{ title: subjectTitle, kind: item.subject.kind, identity: {} }] });
    const data = { ...native(item, 'coverage'), fullProfileRequired: requirement.fullProfileRequired, assertCurrent: requirement.assertCurrent };
    const result = await prepareSelfImprovementAssessment(data);
    expect(result).toMatchObject({ kind: 'coverage', sufficient: true });
    expect(fake.requests.filter(request => 'fullProfileRequired' in request.questions)).toHaveLength(1);
    expect(fake.requests.find(request => 'repairEvidenceSufficient' in request.questions)?.state).toMatchObject({ query: narrowQuery, requestedScope: { fullProfileRequired: false } });
    data.fullProfileRequired = true; expect(result.assertCurrent).toThrow(Held);
    const before = fake.requests.length;
    const invalidScope = { fullProfileRequired: false, unknown: 'ordinary' };
    await held(readSelfImprovementAssessment('coverage', { ...input(), requestedScope: invalidScope }), 'malformed');
    expect(fake.requests).toHaveLength(before);
    readings({ sufficient: 0.5 });
    await held(readSelfImprovementAssessment('coverage', { ...input(broadQuery), requestedScope: { fullProfileRequired: false } }), 'uncertain');
  });
  test('an unsettled full-profile requirement cannot reach coverage or claim repair credit', async () => {
    const item = await fixture(narrowQuery, 1), fake = readings({ fullProfileRequired: 0.5, sufficient: 0.99 }), before = snapshot(item.store);
    const error: unknown = await classifyGap(item.context, false, [], item.store).catch(error => error);
    expect(error).toBeInstanceOf(KnowledgeRepairFactScoringHeldError);
    expect(isKnowledgeSourceQualityFailure(error)).toBe(true);
    expect(fake.requests.filter(request => 'fullProfileRequired' in request.questions)).toHaveLength(1);
    expect(fake.requests.some(request => 'repairEvidenceSufficient' in request.questions)).toBe(false);
    expect(snapshot(item.store)).toBe(before); expect(item.store.listRefinementTasks()).toEqual([]);
  });
  test('native coverage retains a settled requirement through the later coverage await', async () => {
    const item = await fixture(narrowQuery, 1), fake = readings({ sufficient: 0.99 }), before = snapshot(item.store);
    let requirementRead = false;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      if ('fullProfileRequired' in request.questions) requirementRead = true;
      if ('repairEvidenceSufficient' in request.questions) {
        expect(requirementRead).toBe(true); installJudgmentPort({ ...fake.port });
      }
      return result;
    } });
    const error: unknown = await prepareSelfImprovementAssessment(native(item, 'coverage')).catch(error => error);
    expect(error).toBeInstanceOf(Held);
    expect(isKnowledgeSourceQualityFailure(error)).toBe(true);
    expect(snapshot(item.store)).toBe(before); expect(item.store.listRefinementTasks()).toEqual([]);
  });
  test('four useful rows with three vocabulary categories do not authorize broad completeness', async () => {
    const item = await fixture(broadQuery, 4), fake = readings({ sufficient: 0.01 }), before = snapshot(item.store);
    expect((await classifyGap(item.context, false, [], item.store)).action).toBe('repair');
    const coverage = fake.requests.find(request => 'repairEvidenceSufficient' in request.questions);
    expect((coverage?.state as { facts: unknown[] }).facts).toHaveLength(4);
    expect(coverage?.state).toMatchObject({ requestedScope: { fullProfileRequired: true } });
    expect(snapshot(item.store)).toBe(before);
  });
  test('intrinsic discovery uses canonical natural identity without requiring a model-shaped title', async () => {
    const item = await fixture(), fake = readings({ sufficient: 0.01 });
    expect(await discoverIntrinsicGaps(item.store, spaceId, new Set([item.source.id]), [])).toBe(1);
    const gaps = item.store.listNodes().filter(node => node.metadata.gapKind === 'intrinsic_features');
    expect(gaps).toHaveLength(1); expect(gaps[0]?.metadata.linkedObjectIds).toEqual([item.subject.id]);
    expect(fake.requests.some(request => 'repairSubjectSelected' in request.questions)).toBe(true);
    expect(fake.requests.some(request => 'repairEvidenceSufficient' in request.questions)).toBe(true);
  });
  test('graph-wide subject context is a genuine native node and a settled no keeps the graph unchanged', async () => {
    const item = await fixture(), before = snapshot(item.store); readings({ selected: 0.01 });
    const selection = await canonicalRepairSubjectNodes({ store: item.store, spaceId, context: { subject: item.subject }, nodes: [item.subject],
      text: 'What are the complete features and specifications for the kitchen probe?' });
    expect(selection.nodes).toEqual([]); expect(snapshot(item.store)).toBe(before);
    readings({ selected: 0.99 });
    const selected = await canonicalRepairSubjectNodes({ store: item.store, spaceId, context: { subject: item.subject }, nodes: [item.subject],
      text: 'What are the complete features and specifications for the kitchen probe?' });
    expect(selected.nodes).toEqual([item.subject]); expect(selected.nodes[0]).toBe(item.subject);
  });
  test('unconfigured and uncertain applicability never suppress or mutate native records', async () => {
    const item = await fixture(), before = snapshot(item.store);
    installJudgmentPort(undefined); await held(classifyGap(item.context, false, [], item.store), 'unconfigured');
    for (const field of ['applicable', 'concrete'] as const) {
      readings({ [field]: 0.5 }); await held(classifyGap(item.context, false, [], item.store), 'uncertain');
      expect(snapshot(item.store)).toBe(before);
    }
  });
  test('complete native source metadata is screened before any assessment request', async () => {
    const item = await fixture();
    const sqlite = (item.store as unknown as { sqlite: SQLiteStore }).sqlite;
    const raw = item.store.getSourceSnapshot({ id: item.source.id }).raw!;
    sqlite.run('UPDATE knowledge_sources SET metadata = ? WHERE id = ?', [JSON.stringify({ ...JSON.parse(String(raw.metadata)), late: 'apiKey=synthetic-private-fixture' }), item.source.id]);
    await sqlite.save(); await item.store.close();
    const store = new KnowledgeStore({ dbPath: item.dbPath }); stores.push(store); await store.init();
    const current = { ...item, store, subject: store.getNode(item.subject.id)!, gap: store.getNode(item.gap.id)!, source: store.getSource(item.source.id)! };
    const fake = readings(), before = snapshot(store);
    await expect(prepareSelfImprovementAssessment(native(current))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
  });
  test('hidden and late protected reader fields do not leave the process', async () => {
    for (const [data, error] of [[Object.defineProperty(input(), 'late', { value: 'ordinary hidden prose' }), Held],
      [{ ...input(), evidence: [...input().evidence, { source: {}, text: '4111 1111 1111 1111' }] }, JudgmentInputError]] as const) {
      const fake = readings(); await expect(readSelfImprovementAssessment('coverage', data)).rejects.toBeInstanceOf(error);
      expect(fake.requests).toHaveLength(0);
    }
  });
  test('native source and exact policy replacement during a request retire the whole decision', async () => {
    for (const change of ['source', 'policy'] as const) {
      const item = await fixture(), data = native(item), before = snapshot(item.store), fake = readings();
      installJudgmentPort({ ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if (change === 'policy') data.objectProfiles.push({ id: 'changed-policy', subjectKinds: [] });
        else await item.store.upsertSource({ ...item.source, title: 'Changed manual' });
        return result;
      } });
      await held(prepareSelfImprovementAssessment(data), 'stale');
      expect(item.store.listRefinementTasks()).toEqual([]);
      if (change === 'policy') expect(snapshot(item.store)).toBe(before);
    }
  });
  test('installed source-owner retirement cannot publish its late settled result', async () => {
    const item = await fixture(), fake = readings(), before = snapshot(item.store), controller = new AbortController();
    const sourceOwner = { identity: Object.freeze({}), signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); } };
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>();
    const port: JudgmentPort = { ...fake.port, async ask(request) { entered.resolve(); await release.promise; try { return await fake.port.ask(request); } finally { drained.resolve(); } } };
    bindJudgmentPortAuthority(port, () => sourceOwner); installJudgmentPort(port);
    const pending = prepareSelfImprovementAssessment(native(item)).catch(error => error);
    try { await entered.promise; controller.abort(); release.resolve(); const error: unknown = await pending;
      expect(error).toBeInstanceOf(Held); expect(snapshot(item.store)).toBe(before);
    } finally { release.resolve(); await Promise.allSettled([pending, drained.promise]); }
  });
  test('caller cancellation interrupts a pending reader and late settlement has no native effects', async () => {
    const item = await fixture(), fake = readings(), before = snapshot(item.store), controller = new AbortController();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) { entered.resolve(); await release.promise; try { return await fake.port.ask(request); } finally { drained.resolve(); } } });
    const pending = prepareSelfImprovementAssessment({ ...native(item), signal: controller.signal }).catch(error => error);
    try { await entered.promise; controller.abort(); const error: unknown = await pending;
      expect(error).toBeInstanceOf(Held); expect((error as Held).reason).toBe('aborted');
      release.resolve(); await pending; expect(snapshot(item.store)).toBe(before);
    } finally { release.resolve(); await Promise.allSettled([pending, drained.promise]); }
  });
  test('a complete original response is admitted before metadata or a misleading empty-fact yes can publish', async () => {
    const fake = readings({ sufficient: 0.99 });
    await held(readSelfImprovementAssessment('coverage', { ...input(), facts: [] }), 'malformed');
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), late: 'apiKey=synthetic-private-fixture' }; } });
    await expect(readSelfImprovementAssessment('coverage', input())).rejects.toBeInstanceOf(JudgmentInputError);
  });
  test('original options and retained exact input remain restrictions after settlement', async () => {
    const data = input(), options = { assertCurrent: () => {} }; readings({ sufficient: 0.99 });
    const result = await readSelfImprovementAssessment('coverage', data, options);
    if (result.kind !== 'coverage') throw new Error('Wrong native assessment kind');
    expect(result.sufficient).toBe(true); Object.defineProperty(data.subjects[0]!.content, 'batteryPowered', { value: false, enumerable: true, configurable: true, writable: true });
    expect(result.assertCurrent).toThrow(Held);
    readings({ sufficient: 0.99 }); const clean = input(); const another = await readSelfImprovementAssessment('coverage', clean, options);
    options.assertCurrent = () => {};
    expect(another.assertCurrent).toThrow(Held);
  });
});


test('unresolved object applicability remains an uncertain native hold without a binary calibration truth', async () => {
  const unresolved = selfImprovementGapContext.fixtures.find(fixture => fixture.name === 'unresolved object');
  if (!unresolved) throw new Error('Unresolved object fixture missing');
  const data: SelfImprovementAssessmentInput = {
    query: 'What are its full capabilities?', subjects: [], facts: [], evidence: [], objectProfiles: [],
  };
  expect(data).toEqual(unresolved.state);
  expect(unresolved.expect).not.toHaveProperty('gapApplicable');
  expect(unresolved.expect).toHaveProperty('repairContextConcrete', 'no');
  const fake = fakePort((name, question, state) => {
    expect(state).toEqual(unresolved.state);
    if (name === 'gapApplicable' && sameQuestion(question, selfImprovementGapContext.items.gapApplicable.question)) return noulAnswer(0.5);
    if (name === 'repairContextConcrete' && sameQuestion(question, selfImprovementGapContext.items.repairContextConcrete.question)) return noulAnswer(0.01);
    throw new Error('Unscripted unresolved object question');
  });
  installJudgmentPort(fake.port);
  await held(readSelfImprovementAssessment('context', data), 'uncertain');
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]?.state).toEqual(unresolved.state);
});


test('native assessment transports complete canonical metadata instead of compatibility clock numbers', async () => {
  const collision = 4_222_222_222_222;
  const item = await fixture(narrowQuery, 1, collision), fake = readings({ sufficient: 0.99 });
  const originalSubject = JSON.parse(String(item.store.getRecordSnapshot('node', item.subject.id).raw!.metadata));
  const originalFact = JSON.parse(String(item.store.getRecordSnapshot('node', item.facts[0]!.id).raw!.metadata));
  const viewProvenance: unknown = Object.getOwnPropertyDescriptor(item.subject.metadata, 'reviewProvenance')?.value;
  const rawProvenance: unknown = Object.getOwnPropertyDescriptor(originalSubject, 'reviewProvenance')?.value;
  if (!viewProvenance || typeof viewProvenance !== 'object' || Array.isArray(viewProvenance)
    || !rawProvenance || typeof rawProvenance !== 'object' || Array.isArray(rawProvenance)) throw new Error('Missing native review provenance');
  const viewClock = Object.getOwnPropertyDescriptor(viewProvenance, 'decidedAt');
  const rawClock = Object.getOwnPropertyDescriptor(rawProvenance, 'decidedAt');
  if (!viewClock || !('value' in viewClock) || !rawClock || !('value' in rawClock)) throw new Error('Missing native review clock data');
  expect(viewClock.value).toBe(collision);
  expect(rawClock.value).toBe(new Date(collision).toISOString());
  const before = snapshot(item.store);
  const result = await prepareSelfImprovementAssessment(native(item, 'coverage'));
  expect(result).toMatchObject({ kind: 'coverage', sufficient: true });
  const request = fake.requests.find(request => 'repairEvidenceSufficient' in request.questions);
  if (!request || !request.state || typeof request.state !== 'object' || Array.isArray(request.state)) throw new Error('Missing coverage request');
  const subjects: unknown = Object.getOwnPropertyDescriptor(request.state, 'subjects')?.value;
  const facts: unknown = Object.getOwnPropertyDescriptor(request.state, 'facts')?.value;
  if (!Array.isArray(subjects) || subjects.length !== 1 || !Array.isArray(facts) || facts.length !== 1) throw new Error('Missing complete native candidates');
  expect(Object.getOwnPropertyDescriptor(subjects[0], 'content')?.value).toEqual(originalSubject);
  expect(Object.getOwnPropertyDescriptor(facts[0], 'content')?.value).toEqual(originalFact);
  expect(snapshot(item.store)).toBe(before);
  result.assertCurrent();
});

test('caller numeric review-clock lookalikes remain refused before any assessment request', async () => {
  const item = await fixture();
  const sqlite = (item.store as unknown as { sqlite: SQLiteStore }).sqlite;
  const raw = item.store.getRecordSnapshot('node', item.subject.id).raw!;
  const metadata = JSON.parse(String(raw.metadata));
  metadata.reviewProvenance.decidedAt = 4_222_222_222_222;
  sqlite.run('UPDATE knowledge_nodes SET metadata = ? WHERE id = ?', [JSON.stringify(metadata), item.subject.id]);
  await sqlite.save(); await item.store.close();
  const store = new KnowledgeStore({ dbPath: item.dbPath }); stores.push(store); await store.init();
  const current = { ...item, store, subject: store.getNode(item.subject.id)!, gap: store.getNode(item.gap.id)!, source: store.getSource(item.source.id)! };
  const fake = readings(), before = snapshot(store);
  await expect(prepareSelfImprovementAssessment(native(current))).rejects.toBeInstanceOf(JudgmentInputError);
  expect(fake.requests).toHaveLength(0); expect(snapshot(store)).toBe(before);
});

test('assessment fixture dispatch admits complete copied questions and refuses changed or swapped schemas', () => {
  const data = { ...input(), facts: [] };
  const authored = [gapAssessmentFixture({ title: narrowQuery }, [{ title: subjectTitle }], 0.99, 0.99)];
  const question = selfImprovementGapContext.items.gapApplicable.question;
  expect(selfImprovementFixtureReading('gapApplicable', captureStrictJudgmentJson(question), data, authored)).toBe(0.99);
  expect(() => selfImprovementFixtureReading('gapApplicable', { ...question, criteria: { true: 'A changed criterion' } }, data, authored)).toThrow('Unscripted assessment fixture question');
  expect(() => selfImprovementFixtureReading('gapApplicable', selfImprovementGapContext.items.repairContextConcrete.question, data, authored)).toThrow('Unscripted assessment fixture question');
  expect(() => selfImprovementFixtureReading('gapApplicable', question, { ...data, query: 'Unlisted complete request' }, authored)).toThrow('Unscripted self-improvement assessment');
});


test('a replaced compatibility representation lookup cannot change admitted native assessment metadata', async () => {
  const item = await fixture(narrowQuery, 1), fake = readings({ sufficient: 0.99 });
  const rawMetadata = JSON.parse(String(item.store.getRecordSnapshot('node', item.subject.id).raw!.metadata));
  const forged = { version: knowledgeRecordVersion(item.subject.metadata), raw: { ...rawMetadata, batteryPowered: false } };
  const originalGet = WeakMap.prototype.get, apply = Reflect.apply;
  let replaced = false;
  const data = { ...native(item, 'coverage'), assertCurrent() {
    if (replaced) return;
    replaced = true;
    WeakMap.prototype.get = function (this: WeakMap<object, unknown>, key: object) {
      if (key === item.subject.metadata) return forged;
      return apply(originalGet, this, [key]);
    };
  } };
  try {
    const before = snapshot(item.store);
    const result = await prepareSelfImprovementAssessment(data);
    expect(replaced).toBe(true);
    expect(result).toMatchObject({ kind: 'coverage', sufficient: true });
    const request = fake.requests.find(request => 'repairEvidenceSufficient' in request.questions);
    if (!request || !request.state || typeof request.state !== 'object' || Array.isArray(request.state)) throw new Error('Missing coverage request');
    const subjects: unknown = Object.getOwnPropertyDescriptor(request.state, 'subjects')?.value;
    if (!Array.isArray(subjects) || subjects.length !== 1) throw new Error('Missing admitted native subject');
    expect(Object.getOwnPropertyDescriptor(subjects[0], 'content')?.value).toEqual(rawMetadata);
    expect(snapshot(item.store)).toBe(before);
    result.assertCurrent();
  } finally { WeakMap.prototype.get = originalGet; }
});
