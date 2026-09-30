import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { prepareGeneratedFactSupport, KnowledgeGeneratedFactSupportHeldError, type GeneratedFactSupportInput, type GeneratedFactSupportHoldReason } from '../sdk/src/platform/knowledge/semantic/verification/generated-fact-support.js';
import { registry } from '../sdk/src/platform/knowledge/semantic/verification/judgment-registry.js';
import { generatedFactFieldSupport, generatedFactSubjectAttachment } from '../sdk/src/platform/knowledge/semantic/verification/batteries.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
function input(sourceId = 'source'): GeneratedFactSupportInput {
  return {
    spaceId: 'support-test',
    claim: { id: 'claim', kind: 'specification', title: 'AC-7 ports', summary: 'AC-7 has four HDMI inputs.', value: '4', evidence: 'AC-7 has four HDMI inputs.', labels: ['hdmi'], aliases: ['HDMI inputs'], subject: 'AC-7', targetHints: [{ id: 'subject', kind: 'knowledge_entity', title: 'AC-7' }] },
    source: { id: sourceId, connectorId: 'synthetic', sourceType: 'manual', title: 'Synthetic manufacturer manual', status: 'indexed', tags: [], metadata: { knowledgeSpaceId: 'support-test', privateInternalField: 'SOURCE_PRIVATE_METADATA' }, createdAt: 1, updatedAt: 1 },
    extraction: { id: `extract-${sourceId}`, sourceId, extractorId: 'synthetic', format: 'text', excerpt: 'AC-7 has four HDMI inputs. The device does not support Bluetooth. Power consumption is 25 W. Battery life is up to 12 hours in standby mode only.', sections: [], links: [], estimatedTokens: 40, structure: {}, metadata: { knowledgeSpaceId: 'support-test', privateInternalField: 'EXTRACTION_PRIVATE_METADATA' }, createdAt: 1, updatedAt: 1 },
    subjects: [{ id: 'subject', kind: 'knowledge_entity', slug: 'ac-7', title: 'AC-7', aliases: ['AC7'], status: 'active', confidence: 90, metadata: { knowledgeSpaceId: 'support-test', manufacturer: 'Synthetic', model: 'AC-7', privateInternalField: 'SUBJECT_PRIVATE_METADATA' }, createdAt: 1, updatedAt: 1 }],
  };
}
function readings(answer: (name: string, state: unknown) => unknown = () => noulAnswer(0.97)) {
  const fake = fakePort((name, _question, state) => answer(name, state));
  installJudgmentPort(fake.port);
  return fake;
}
function fieldName(state: unknown): string { return (state as { field?: { name: string } }).field?.name ?? 'attachment'; }
async function held(promise: Promise<unknown>, reason: GeneratedFactSupportHoldReason) {
  let caught: unknown;
  try { await promise; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
  expect((caught as KnowledgeGeneratedFactSupportHeldError).reason).toBe(reason);
}

describe('generated fact field support and subject attachment', () => {
  test('both high-stakes batteries are registered with labelled positive and adversarial fixtures', () => {
    expect(registry.list().map((battery) => battery.name)).toEqual([generatedFactFieldSupport.name, generatedFactSubjectAttachment.name]);
    for (const battery of [generatedFactFieldSupport, generatedFactSubjectAttachment]) {
      expect(battery.accuracyFloor).toBe(0.95);
      const item = Object.values(battery.items)[0]!;
      expect(item.band.yes.actAt).toBe(0.85);
      const labels = battery.fixtures.flatMap((fixture) => Object.values(fixture.expect));
      expect(labels).toContain('yes'); expect(labels).toContain('no');
    }
    const names = generatedFactFieldSupport.fixtures.map((fixture) => fixture.name).join(' ');
    for (const threat of ['number', 'unit', 'negation', 'qualifier', 'model', 'accessory', 'quote', 'label', 'alias']) expect(names).toContain(threat);
  });

  test('single-source paths read every persisted field and exact attachment; receipts are deeply immutable', async () => {
    const fake = readings();
    const plans = await prepareGeneratedFactSupport([input()]);
    const plan = plans[0]!;
    expect(fake.requests).toHaveLength(10);
    expect(plan.receipts.map((receipt) => receipt.field)).toEqual(['kind', 'title', 'summary', 'value', 'evidence', 'subject', 'labels[0]', 'aliases[0]', 'targetHints[0]', 'subjectAttachment']);
    for (const receipt of plan.receipts) {
      expect(receipt.outcome).toBe('act'); expect(receipt.verdict).toBe('yes'); expect(receipt.probability).toBe(0.97);
      expect(receipt.sourceId).toBe('source'); expect(receipt.extractionId).toBe('extract-source');
      expect(receipt.sourceHash).toHaveLength(64); expect(receipt.extractionHash).toHaveLength(64); expect(receipt.claimHash).toHaveLength(64); expect(receipt.stateHash).toHaveLength(64);
      expect(receipt.receiptId).toMatch(/^fact-support-/); expect(receipt.decisionId).toBeUndefined();
      expect(Object.isFrozen(receipt.evidenceReference)).toBe(true); expect(Object.isFrozen(receipt)).toBe(true);
    }
    expect(Object.isFrozen(plans)).toBe(true); expect(Object.isFrozen(plan.claim.labels)).toBe(true);
    const serialized = JSON.stringify(fake.requests);
    for (const forbidden of ['SOURCE_PRIVATE_METADATA', 'EXTRACTION_PRIVATE_METADATA', 'SUBJECT_PRIVATE_METADATA']) expect(serialized).not.toContain(forbidden);
    expect(serialized).toContain('25 W'); expect(serialized).toContain('does not support Bluetooth');
  });

  test('preserves actual decision IDs and distinct source receipts for the same canonical fact', async () => {
    const fake = readings(); let counter = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), decisionId: `decision-${++counter}` }; } });
    const [first, second] = await prepareGeneratedFactSupport([input('a'), input('b')]);
    expect(first!.claimId).toBe(second!.claimId);
    expect(first!.receipts[0]!.sourceId).toBe('a'); expect(second!.receipts[0]!.sourceId).toBe('b');
    expect(first!.receipts[0]!.receiptId).not.toBe(second!.receipts[0]!.receiptId);
    expect(first!.receipts.every((receipt) => receipt.decisionId?.startsWith('decision-'))).toBe(true);
  });

  test('identical exact inputs can share readings without overwriting per-source history', async () => {
    const fake = readings(); const [first, duplicate] = await prepareGeneratedFactSupport([input(), input()]);
    expect(fake.requests).toHaveLength(10); expect(first).toEqual(duplicate);
  });

  test('every later held or no field rejects the complete pass', async () => {
    for (const name of ['kind', 'title', 'summary', 'value', 'evidence', 'subject', 'labels[0]', 'aliases[0]', 'targetHints[0]', 'attachment']) {
      for (const probability of [0.8, 0.5, 0.02]) {
        readings((_name, state) => noulAnswer(fieldName(state) === name ? probability : 0.99));
        await held(prepareGeneratedFactSupport([input()], { concurrency: 1 }), probability === 0.02 ? 'no-support' : 'unsettled');
      }
    }
  });

  test('unsupported authoritative, quote, quantity, unit, qualifier, negation, variant and accessory fixtures remain negative', async () => {
    // This verifies battery fixture/gate plumbing, not live semantic calibration.
    for (const battery of [generatedFactFieldSupport, generatedFactSubjectAttachment]) {
      const fake = fakePort((_name, _question, state) => {
        const fixture = battery.fixtures.find((entry) => JSON.stringify(entry.state) === JSON.stringify(state));
        return noulAnswer(Object.values(fixture!.expect)[0] === 'yes' ? 0.99 : 0.01);
      });
      const checks = await battery.checkFixtures(fake.port);
      expect(checks.every((check) => check.correct)).toBe(true);
    }
  });

  test('foreign source, extraction and subject content never reaches any model', async () => {
    for (const part of ['source', 'extraction', 'subject'] as const) {
      const item = input('foreign');
      const foreign = { knowledgeSpaceId: 'other-space', marker: 'FOREIGN_PRIVATE_CONTENT' };
      const changed = part === 'source' ? { ...item, source: { ...item.source, metadata: foreign } }
        : part === 'extraction' ? { ...item, extraction: { ...item.extraction!, metadata: foreign } }
          : { ...item, subjects: [{ ...item.subjects[0]!, metadata: foreign }] };
      const fake = readings();
      await held(prepareGeneratedFactSupport([input(), changed]), 'foreign-space'); expect(fake.requests).toHaveLength(0);
    }
  });

  test('missing, mismatched, title-only or empty extraction cannot use source summary or generated evidence', async () => {
    const item = input();
    for (const extraction of [null, { ...item.extraction!, sourceId: 'unrelated' }, { ...item.extraction!, excerpt: '', summary: 'Generated claim is true.' }, { ...item.extraction!, excerpt: '', title: 'AC-7 has four HDMI inputs.' }]) {
      const fake = readings();
      await expect(prepareGeneratedFactSupport([{ ...item, extraction }])).rejects.toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError);
      expect(fake.requests).toHaveLength(0);
    }
  });

  test('generated projections and unusable source statuses cannot manufacture independent support', async () => {
    const item = input();
    for (const flag of ['generatedProjection', 'generatedKnowledgePage']) {
      const fake = readings();
      await held(prepareGeneratedFactSupport([{ ...item, source: { ...item.source, metadata: { ...item.source.metadata, [flag]: true } } }]), 'missing-evidence');
      expect(fake.requests).toHaveLength(0);
    }
    for (const status of ['stale', 'failed'] as const) {
      const fake = readings();
      await held(prepareGeneratedFactSupport([{ ...item, source: { ...item.source, status } }]), 'stale');
      expect(fake.requests).toHaveLength(0);
    }
  });

  test('actual extractor text paths are allowlisted and complete', async () => {
    const item = input(); const fake = readings();
    await prepareGeneratedFactSupport([{ ...item, extraction: { ...item.extraction!, excerpt: '', structure: { text: 'AC-7 has four HDMI inputs.', hidden: 'UNRELATED_STRUCTURE' } } }]);
    expect(JSON.stringify(fake.requests)).toContain('AC-7 has four HDMI inputs.');
    expect(JSON.stringify(fake.requests)).not.toContain('UNRELATED_STRUCTURE');
  });

  test('a protected later claim, full late excerpt, or subject identity prevents every request', async () => {
    for (const part of ['claim', 'extraction', 'subject'] as const) {
      const item = input('late'); const protectedText = `${'Ordinary evidence. '.repeat(4_000)} Authorization: Bearer synthetic`;
      const changed = part === 'claim' ? { ...item, claim: { ...item.claim, evidence: protectedText } }
        : part === 'extraction' ? { ...item, extraction: { ...item.extraction!, excerpt: protectedText } }
          : { ...item, subjects: [{ ...item.subjects[0]!, title: protectedText }] };
      const fake = readings();
      await expect(prepareGeneratedFactSupport([input(), changed])).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    }
  });

  test('conflicting duplicate source/extraction/subject versions hold before requests', async () => {
    const item = input();
    for (const changed of [
      { ...item, source: { ...item.source, updatedAt: 2 } },
      { ...item, extraction: { ...item.extraction!, updatedAt: 2 } },
      { ...item, subjects: [{ ...item.subjects[0]!, title: 'AC-7 Pro' }] },
    ]) {
      const fake = readings(); await held(prepareGeneratedFactSupport([item, changed]), 'stale'); expect(fake.requests).toHaveLength(0);
    }
  });

  test('no port, unavailable, malformed and out-of-range responses are fixed typed holds', async () => {
    await held(prepareGeneratedFactSupport([input()]), 'unavailable');
    for (const answer of [null, {}, { type: 'noul', noul: NaN }, { type: 'noul', noul: Infinity }, { type: 'noul', noul: 1.1 }, { type: 'noul', noul: -0.1 }, { type: 'choice', noul: 0.99 }, { type: 'noul', noul: '0.99' }]) {
      readings(() => answer); await held(prepareGeneratedFactSupport([input()]), 'malformed');
    }
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask() { throw new Error('SENSITIVE_BACKEND_DETAIL'); } });
    try { await prepareGeneratedFactSupport([input()]); throw new Error('unexpected success'); }
    catch (error) { expect(error).toBeInstanceOf(KnowledgeGeneratedFactSupportHeldError); expect(String(error)).not.toContain('SENSITIVE_BACKEND_DETAIL'); }
  });

  test('request/byte/input caps reject the entire plan, with no silent prefix truncation', async () => {
    const fake = readings();
    await held(prepareGeneratedFactSupport([input()], { maxRequests: 9 }), 'budget');
    await held(prepareGeneratedFactSupport([input()], { maxBytes: 1 }), 'budget');
    await held(prepareGeneratedFactSupport(Array.from({ length: 401 }, () => input())), 'budget');
    await held(prepareGeneratedFactSupport([input()], { concurrency: 5 }), 'budget');
    expect(fake.requests).toHaveLength(0);
  });

  test('pre-cancelled calls and cancel during readings never return plans or schedule more calls', async () => {
    const controller = new AbortController(); const fake = readings(); controller.abort();
    await held(prepareGeneratedFactSupport([input()], { signal: controller.signal }), 'aborted'); expect(fake.requests).toHaveLength(0);
    const during = new AbortController();
    installJudgmentPort({ ...fake.port, async ask(request) { during.abort(); return fake.port.ask(request); } });
    await held(prepareGeneratedFactSupport([input()], { signal: during.signal, concurrency: 1 }), 'aborted'); expect(fake.requests).toHaveLength(1);
  });

  test('bounded timeout cancels a stalled custom port even if it ignores AbortSignal', async () => {
    let calls = 0; const fake = readings();
    installJudgmentPort({ ...fake.port, async ask() { calls++; return new Promise(() => {}); } });
    await held(prepareGeneratedFactSupport([input()], { timeoutMs: 10, concurrency: 2 }), 'budget'); expect(calls).toBe(2);
  });

  test('concurrency never exceeds its bound and caller mutation cannot alter verified content', async () => {
    const item = input(); const fake = readings(); let active = 0, peak = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      active++; peak = Math.max(peak, active);
      (item.claim as { title: string }).title = 'CHANGED_CALLER_CLAIM';
      await new Promise((resolve) => setTimeout(resolve, 1)); active--; return fake.port.ask(request);
    } });
    const plans = await prepareGeneratedFactSupport([item], { concurrency: 2 });
    expect(peak).toBe(2); expect(plans[0]!.claim.title).toBe('AC-7 ports'); expect(JSON.stringify(fake.requests)).not.toContain('CHANGED_CALLER_CLAIM');
  });

  test('accessors, cycles, unsupported claim fields and metadata-shaped hints never reach the model', async () => {
    const fake = readings(); const item = input(); let accessed = false;
    const withAccessor = { ...item, claim: { ...item.claim, get value() { accessed = true; return 'unsafe'; } } };
    await expect(prepareGeneratedFactSupport([withAccessor])).rejects.toThrow(); expect(accessed).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    await expect(prepareGeneratedFactSupport([{ ...item, claim: { ...item.claim, value: cycle } }])).rejects.toThrow();
    await expect(prepareGeneratedFactSupport([{ ...item, claim: { ...item.claim, unrelatedMetadata: 'no' } } as GeneratedFactSupportInput])).rejects.toThrow();
    await expect(prepareGeneratedFactSupport([{ ...item, claim: { ...item.claim, targetHints: [{ id: 'subject', title: 'AC-7', kind: 'knowledge_entity', unrelatedMetadata: 'no' }] } }])).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  test('sparse input and persisted-field arrays hold rather than skipping their holes', async () => {
    const fake = readings();
    await held(prepareGeneratedFactSupport(new Array<GeneratedFactSupportInput>(1)), 'malformed');
    const value = input();
    for (const field of ['labels', 'aliases', 'targetHints'] as const) {
      await held(prepareGeneratedFactSupport([{ ...value, claim: { ...value.claim, [field]: new Array<string>(1) } }]), 'malformed');
    }
    expect(fake.requests).toHaveLength(0);
  });

  test('identifier-shaped strings do not bypass the conservative protected-input boundary', async () => {
    const fake = readings(); const candidate = input();
    await expect(prepareGeneratedFactSupport([{ ...candidate, claim: { ...candidate.claim, id: 'claim-4111111111111111' } }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });

});
