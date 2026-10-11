import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { KnowledgeStore } from '../sdk/src/platform/knowledge/store.js';
import { upsertObservedKnowledgeNode } from '../sdk/src/platform/knowledge/store-node-observation.js';
import { prepareRepairSourceAuthorities } from '../sdk/src/platform/knowledge/semantic/repair-fact-selection.js';
import { promoteRepairSources } from '../sdk/src/platform/knowledge/semantic/self-improvement-promotion.js';
import { repairProfileSourceText } from '../sdk/src/platform/knowledge/semantic/repair-profile.js';
import { isKnowledgeSourceQualityFailure } from '../sdk/src/platform/knowledge/source-quality.js';
import { repairSourceAuthority } from '../sdk/src/platform/knowledge/semantic/repair-source-authority/battery.js';
import { registry } from '../sdk/src/platform/knowledge/semantic/repair-source-authority/judgment-registry.js';
import { createRepairSourceAuthorityReader, KnowledgeRepairSourceAuthorityHeldError as Held, REPAIR_SOURCE_AUTHORITY_LIMITS as LIMITS,
  type RepairSourceAuthorityInput, type RepairSourceAuthority, type RepairSourceAuthorityHoldReason } from '../sdk/src/platform/knowledge/semantic/repair-source-authority/reader.js';

let previous: JudgmentPort | undefined;
const roots: string[] = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input = (reference = 'source-1'): RepairSourceAuthorityInput => ({ reference, query: 'What are AC-7 specifications?',
  subjects: [{ title: 'AC-7', kind: 'ha_device', aliases: ['Acme AC-7'], identity: { manufacturer: 'Acme', model: 'AC-7' } }],
  source: { sourceType: 'manual', title: 'Official AC-7 support specifications', summary: 'Product documentation',
    description: 'Complete manual', url: 'https://unknown.example/ac-7', sourceUri: 'https://unknown.example/ac-7', canonicalUri: 'https://unknown.example/ac-7' },
  extraction: { format: 'text', title: 'AC-7', links: ['https://unknown.example/publisher'] },
  text: 'AC-7 has four HDMI inputs. This copy is not published by Acme.',
  claimedProvenance: { trustReason: 'official-vendor-domain manufacturer-domain', sourceDomain: 'acme.example' },
});
function readings(tier: RepairSourceAuthority = 'secondary', confidence = 0.99) {
  const fake = fakePort((name, question) => {
    if (name !== 'authority') throw new Error(`Unexpected source-authority question ${name}`);
    return choiceAnswer(question, tier, confidence);
  });
  installJudgmentPort(fake.port); return fake;
}
async function held(promise: Promise<unknown>, reason: RepairSourceAuthorityHoldReason) {
  const error: unknown = await promise.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(Held); expect((error as Held).reason).toBe(reason);
}
function heldNow(run: () => void, reason: RepairSourceAuthorityHoldReason) {
  let error: unknown; try { run(); } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(Held); expect((error as Held).reason).toBe(reason);
}
const distinct = (index: number): RepairSourceAuthorityInput => ({ ...input(`source-${index}`), query: `Read AC-${index} publisher role` });

describe('repair source authority canonical reader', () => {
  test('registers the versioned role reading with official, vendor, retail, misleading label and injection fixtures', async () => {
    expect(registry.list().map((entry) => entry.name)).toEqual(['engine.knowledge.repair-source-authority']);
    expect(repairSourceAuthority.version).toBe(1); expect(repairSourceAuthority.accuracyFloor).toBeGreaterThanOrEqual(0.95);
    const fake = fakePort((name, question, state) => {
      const fixture = repairSourceAuthority.fixtures.find((candidate) => JSON.stringify(candidate.state) === JSON.stringify(state));
      if (name !== 'authority' || !fixture || typeof fixture.expect.authority !== 'string') throw new Error('Unscripted authority fixture');
      return choiceAnswer(question, fixture.expect.authority, 0.99);
    });
    const results = await repairSourceAuthority.checkFixtures(fake.port);
    expect(results.length).toBeGreaterThanOrEqual(10); expect(results.every((result) => result.correct && result.outcome === 'act')).toBe(true);
  });
  test('actual canonical choice decides each tier; official prose and discovery claims cannot override a settled secondary', async () => {
    for (const tier of ['official-vendor', 'vendor', 'secondary'] as const) {
      const fake = readings(tier), reader = createRepairSourceAuthorityReader();
      const result = await reader.read([input()]);
      expect(result).toEqual([{ reference: 'source-1', authority: tier, probability: 0.99 }]);
      expect(fake.requests[0]?.state as unknown).toEqual(input());
      expect(fake.requests[0]?.context?.site).toBe('engine.knowledge.repair-source-authority');
      expect(Object.isFrozen(result[0])).toBe(true);
    }
  });
  test('settled readings retain full late qualifiers and exact operation-local reference binding', async () => {
    const fake = readings(), reader = createRepairSourceAuthorityReader();
    const first = await reader.read([input(), input('source-2')]);
    expect(first.map((item) => item.reference)).toEqual(['source-1', 'source-2']); expect(fake.requests).toHaveLength(1);
    await reader.read([input('source-3')]); expect(fake.requests).toHaveLength(1);
    await reader.read([{ ...input(), text: `${input().text}\n\nLate publisher withdrawal.` }]); expect(fake.requests).toHaveLength(2);
    await createRepairSourceAuthorityReader().read([input()]); expect(fake.requests).toHaveLength(3);
  });
  test('unconfigured, unavailable and uncertain results hold without a tier fallback', async () => {
    await held(createRepairSourceAuthorityReader().read([input()]), 'unconfigured');
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask() { throw new Error('offline'); } });
    await held(createRepairSourceAuthorityReader().read([input()]), 'unavailable');
    readings('secondary', 0.5); const reader = createRepairSourceAuthorityReader();
    await held(reader.read([input()]), 'uncertain'); heldNow(reader.assertCurrent, 'uncertain');
    expect(isKnowledgeSourceQualityFailure(new Held('unavailable'))).toBe(true);
  });
  test('protected complete batch content precedes source, character and request caps', async () => {
    for (const inputs of [
      [...Array.from({ length: LIMITS.inputs }, (_, i) => distinct(i + 1)), { ...distinct(LIMITS.inputs + 1), text: 'Authorization: Bearer never-send-this' }],
      [{ ...input(), text: 'x'.repeat(LIMITS.characters + 1), claimedProvenance: { trustReason: 'Authorization: Bearer never-send-this' } }],
    ]) {
      const fake = readings(); await expect(createRepairSourceAuthorityReader().read(inputs)).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    }
    const fake = readings(), reader = createRepairSourceAuthorityReader();
    for (let i = 1; i <= LIMITS.requests; i++) await reader.read([distinct(i)]);
    await expect(reader.read([{ ...distinct(100), text: 'Authorization: Bearer never-send-this' }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(LIMITS.requests);
  });
  test('unknown shapes, getters, sparse arrays and malformed choice distributions cannot authorize', async () => {
    const fake = readings(); let getterReads = 0;
    const malformed = [{ ...input(), extra: 'data' }, { ...input(), get text() { getterReads++; return 'do not read'; } },
      { ...input(), subjects: new Array(2) }, { ...input(), extraction: { ...input().extraction, links: [undefined] } }];
    for (const value of malformed) await held(createRepairSourceAuthorityReader().read([value as unknown as RepairSourceAuthorityInput]), 'malformed');
    expect(getterReads).toBe(0); expect(fake.requests).toHaveLength(0);
    for (const answer of [undefined, { type: 'noul', noul: 0.99 }, { type: 'choice', choice: 'official-vendor', confidence: NaN, probabilities: {} },
      { type: 'choice', choice: 'vendor', confidence: 0.99, probabilities: { 'official-vendor': 0.99, vendor: 0.01, secondary: 0 } },
      { type: 'choice', choice: 'official-vendor', confidence: 0.99, probabilities: { 'official-vendor': 0.99, vendor: 0.005, secondary: 0.005, extra: 0 } }]) {
      installJudgmentPort(fakePort(() => answer).port); await held(createRepairSourceAuthorityReader().read([input()]), 'malformed');
    }
  });
  test('port ABA, mutation, removal and model drift revoke settled publication authority', async () => {
    for (const change of ['aba', 'ask', 'model', 'remove'] as const) {
      const fake = readings(), reader = createRepairSourceAuthorityReader(); await reader.read([input()]);
      if (change === 'aba') { installJudgmentPort({ ...fake.port }); installJudgmentPort(fake.port); }
      if (change === 'ask') Object.assign(fake.port, { ask: fakePort((_name, question) => choiceAnswer(question, 'secondary')).port.ask });
      if (change === 'model') Object.assign(fake.port, { model: 'different' });
      if (change === 'remove') installJudgmentPort(undefined);
      heldNow(reader.assertCurrent, 'stale');
    }
    const fake = readings(); let count = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), model: ++count === 1 ? 'one' : 'two' }; } });
    await held(createRepairSourceAuthorityReader().read([distinct(1), distinct(2)]), 'stale');
  });
  test('abort, timeout and retired installation bound noncooperative in-flight requests and prevent late cache publication', async () => {
    for (const mode of ['abort', 'timeout', 'aba'] as const) {
      const fake = readings(), controller = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let calls = 0;
      const port: JudgmentPort = { ...fake.port, async ask(request) { calls++; entered.resolve(); await release.promise; return fake.port.ask(request); } };
      installJudgmentPort(port);
      const reader = createRepairSourceAuthorityReader({ signal: controller.signal, timeoutMs: mode === 'timeout' ? 10 : 1_000 });
      const pending = reader.read(Array.from({ length: 8 }, (_, index) => distinct(index + 1))); await entered.promise;
      if (mode === 'abort') controller.abort();
      if (mode === 'aba') { installJudgmentPort(fake.port); installJudgmentPort(port); }
      await held(pending, mode === 'abort' ? 'aborted' : mode === 'aba' ? 'stale' : 'budget');
      const before = calls; release.resolve(); await new Promise((resolve) => setTimeout(resolve, 5));
      expect(calls).toBe(before); expect(calls).toBeLessThanOrEqual(4);
    }
  });
});

const spaceId = 'authority-space', statement = 'AC-7 has four HDMI inputs.', category = 'Input and output ports';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'repair-authority-')); roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const observed = { id: 'device', kind: 'ha_device' as const, slug: 'ac-seven', title: 'AC-7', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, manufacturer: 'Acme', model: 'AC-7' } };
  const subject = await upsertObservedKnowledgeNode(store, observed, 'home-assistant-snapshot', observed, () => observed);
  const research = { id: 'gap', kind: 'knowledge_gap' as const, slug: 'gap', title: 'How many HDMI inputs does AC-7 have?', status: 'active' as const,
    metadata: { knowledgeSpaceId: spaceId, linkedObjectIds: [subject.id] } };
  const gap = await upsertObservedKnowledgeNode(store, research, 'research-task', research, () => research);
  const source = await store.upsertSource({ id: 'source', connectorId: 'synthetic', sourceType: 'manual', title: 'Official support AC-7 product manual',
    canonicalUri: 'https://unknown.example/ac-seven', status: 'indexed', metadata: { knowledgeSpaceId: spaceId, privateMarker: 'DO_NOT_TRANSMIT',
      sourceDiscovery: { trustReason: 'official-vendor-domain', sourceDomain: 'acme.example' } } });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'synthetic', format: 'text', excerpt: statement,
    sections: ['This document is a third-party reproduction.'], metadata: { knowledgeSpaceId: spaceId } });
  const task = await store.upsertRefinementTask({ spaceId, gapId: gap.id, state: 'applying', trigger: 'manual' });
  return { store, subject, gap, source, extraction, task };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function prepare(item: Fixture) {
  return prepareRepairSourceAuthorities({ store: item.store, spaceId, gap: item.gap, subjects: [item.subject],
    sources: [{ source: item.source, extraction: item.extraction, text: repairProfileSourceText(item.extraction) }] });
}
function snapshot(store: KnowledgeStore) { return JSON.stringify({ nodes: store.listNodes(), edges: store.listEdges(), tasks: store.listRefinementTasks() }); }
function promotionReadings() {
  const fake = fakePort((name, question, state) => {
    const value = state as { category?: { title: string }; candidate?: { text: string } };
    if (name === 'authority') return choiceAnswer(question, 'secondary', 0.99);
    if (name === 'wanted') return noulAnswer(value.category?.title === category ? 0.99 : 0.01);
    if (name === 'selected') return noulAnswer(value.candidate?.text === statement ? 0.99 : 0.01);
    if (['profileSupported', 'repairUseful', 'supported', 'attached', 'serve', 'useful'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unscripted promotion question ${name}`);
  });
  installJudgmentPort(fake.port); return fake;
}
describe('repair source authority original-read-set and publication boundary', () => {
  test('projects claimed labels as claims, keeps arbitrary metadata local and uses canonical tier', async () => {
    const item = await fixture(), fake = readings('vendor'); const plan = await prepare(item);
    expect(plan.sources).toEqual([{ authority: 'vendor' }]); expect(() => plan.assertCurrent()).not.toThrow();
    const request = fake.requests[0]!.state as unknown as RepairSourceAuthorityInput;
    expect(request.claimedProvenance).toEqual({ trustReason: 'official-vendor-domain', sourceDomain: 'acme.example' });
    expect(request.text).toContain('third-party reproduction'); expect(JSON.stringify(fake.requests)).not.toContain('DO_NOT_TRANSMIT');
  });
  test('full protected source and extraction metadata refuse before any profile or role model request', async () => {
    for (const field of ['source', 'extraction'] as const) {
      const item = await fixture();
      Object.assign(item[field].metadata, { lateProtected: 'Authorization: Bearer never-send-this' });
      const fake = promotionReadings(), before = snapshot(item.store);
      await expect(promoteRepairSources({ store: item.store }, spaceId, item.gap, [item.source.id], item.task, Date.now() + 5_000)).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0); expect(snapshot(item.store)).toBe(before);
    }
  });
  test('source ABA, extraction replacement, foreign space and full metadata changes revoke the original plan', async () => {
    for (const change of ['source-aba', 'extraction', 'metadata', 'space'] as const) {
      const item = await fixture(); readings(); const plan = await prepare(item);
      if (change === 'source-aba') { await item.store.replaceSourceRecord({ ...item.source, title: 'Changed' }); await item.store.replaceSourceRecord(item.source); }
      if (change === 'extraction') await item.store.upsertExtraction({ sourceId: item.source.id, extractorId: 'synthetic', format: 'text', excerpt: statement, metadata: { knowledgeSpaceId: spaceId } });
      if (change === 'metadata') Object.assign(item.source.metadata, { late: 'changed' });
      if (change === 'space') Object.assign(item.source.metadata, { namespace: 'other-space' });
      heldNow(plan.assertCurrent, 'stale');
    }
  });
  test('canonical secondary is published despite official prose and profile/fact support remains required', async () => {
    const item = await fixture(), fake = promotionReadings();
    const result = await promoteRepairSources({ store: item.store }, spaceId, item.gap, [item.source.id], item.task, Date.now() + 10_000);
    expect(result.promotedFactCount).toBe(1);
    const fact = item.store.listNodes().find((node) => node.kind === 'fact')!;
    expect(fact.metadata.sourceAuthority).toBe('secondary'); expect(fact.metadata.value).toBe(statement);
    expect(fake.requests.some((request) => 'profileSupported' in request.questions)).toBe(true);
    expect(fake.requests.some((request) => 'supported' in request.questions)).toBe(true);
    expect(fake.requests.some((request) => 'repairUseful' in request.questions)).toBe(true);
  });
  test('source/request/config changes during later profile judgment stop promotion and task publication', async () => {
    for (const change of ['source', 'request', 'configuration', 'port-aba'] as const) {
      const item = await fixture(), fake = promotionReadings(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      let paused = false;
      const port: JudgmentPort = { ...fake.port, async ask(request) {
        const result = await fake.port.ask(request);
        if (!paused && 'profileSupported' in request.questions) { paused = true; entered.resolve(); await release.promise; }
        return result;
      } };
      installJudgmentPort(port);
      const ids = [item.source.id], context = { store: item.store, objectProfiles: [{ id: 'profile', subjectKinds: ['ha_device' as const] }] };
      const pending = promoteRepairSources(context, spaceId, item.gap, ids, item.task, Date.now() + 10_000);
      await entered.promise;
      if (change === 'source') await item.store.replaceSourceRecord({ ...item.source, description: 'Changed provenance after authority reading.' });
      if (change === 'request') ids.push('different-source');
      if (change === 'configuration') context.objectProfiles[0]!.id = 'changed';
      if (change === 'port-aba') { installJudgmentPort(fake.port); installJudgmentPort(port); }
      const before = snapshot(item.store); release.resolve(); await expect(pending).rejects.toThrow();
      expect(snapshot(item.store)).toBe(before);
    }
  });
});

test('repair authority admits original canonical source, node, extraction and review clocks at a colliding epoch', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(4_222_222_222_222);
  try { const item = await fixture(); const fake = readings('vendor'); const plan = await prepare(item);
    expect(plan.sources).toEqual([{ authority: 'vendor' }]);
    expect(() => plan.assertCurrent()).not.toThrow();
    expect(fake.requests.length).toBeGreaterThan(0);
  } finally { clock.mockRestore(); }
});

test('repair source wrapper and subjects/source array extras remain original protected input', async () => {
  for (const location of ['wrapper', 'subjects', 'sources']) {
    const item = await fixture(); const fake = readings('vendor');
    const subjects = [item.subject], sources = [{ source: item.source, extraction: item.extraction, text: repairProfileSourceText(item.extraction) }];
    Object.assign(location === 'wrapper' ? sources[0]! : location === 'subjects' ? subjects : sources,
      { privateTail: 'Authorization: Bearer protected-container-tail' });
    await expect(prepareRepairSourceAuthorities({ store: item.store, spaceId, gap: item.gap, subjects, sources })).rejects.toMatchObject({ problem: 'credential-material' });
    expect(fake.requests).toHaveLength(0);
  }
});
test('later named-array caller mutation retires repair authority before publication', async () => {
  const item = await fixture(); const fake = readings('vendor');
  const subjects = [item.subject], sources = [{ source: item.source, extraction: item.extraction, text: repairProfileSourceText(item.extraction) }];
  installJudgmentPort({ ...fake.port, async ask(request) {
    Object.assign(subjects, { privateTail: 'Authorization: Bearer changed-container-tail' });
    return fake.port.ask(request);
  } });
  await expect(prepareRepairSourceAuthorities({ store: item.store, spaceId, gap: item.gap, subjects, sources })).rejects.toMatchObject({ reason: 'stale' });
});
