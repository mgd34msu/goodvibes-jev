import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, bindJudgmentPortAuthority } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { createRepairFactUsefulnessReader, prepareRepairFactUsefulness, KnowledgeRepairFactUsefulnessHeldError,
  REPAIR_FACT_USEFULNESS_LIMITS as LIMITS, type RepairFactUsefulnessInput, type RepairFactUsefulnessHoldReason } from '../sdk/src/platform/knowledge/semantic/repair-usefulness/reader.js';
import { repairFactUsefulness } from '../sdk/src/platform/knowledge/semantic/repair-usefulness/battery.js';
import { registry } from '../sdk/src/platform/knowledge/semantic/repair-usefulness/judgment-registry.js';

let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const input = (reference = 'fact-1'): RepairFactUsefulnessInput => ({
  reference, query: 'What are the complete AC-7 features and specifications?',
  subjects: [{ title: 'AC-7', kind: 'device', aliases: ['Acme AC-7'], identity: { manufacturer: 'Acme', model: 'AC-7' } }],
  fact: { title: 'HDMI inputs', kind: 'specification', summary: 'The device has four HDMI inputs.',
    value: { ports: 4, unit: 'HDMI inputs' }, evidence: 'AC-7 has four HDMI inputs.', subject: 'AC-7', labels: ['ports'], aliases: ['HDMI'] },
  evidence: [{ source: { title: 'AC-7 manual', sourceType: 'manual', url: 'https://example.com/AC-7',
    sourceUri: 'https://example.com/AC-7', canonicalUri: 'https://example.com/AC-7' }, extraction: { format: 'text', title: 'AC-7 specs' },
    text: 'AC-7 has four HDMI inputs. AC-8 has eight HDMI inputs.' }],
});
const distinctInput = (reference: string): RepairFactUsefulnessInput => ({ ...input(reference),
  query: `What are the AC-7 features and specifications in configuration ${reference.slice(5)}?` });
function readings(probability = 0.99) {
  const fake = fakePort((name) => {
    if (name !== 'repairUseful') throw new Error('Unexpected repair usefulness question');
    return noulAnswer(probability);
  });
  installJudgmentPort(fake.port); return fake;
}
async function held(promise: Promise<unknown>, reason: RepairFactUsefulnessHoldReason) {
  const result: unknown = await promise.catch((error: unknown) => error);
  expect(result).toBeInstanceOf(KnowledgeRepairFactUsefulnessHeldError);
  expect((result as KnowledgeRepairFactUsefulnessHeldError).reason).toBe(reason);
}
function heldNow(fn: () => void, reason: RepairFactUsefulnessHoldReason) {
  let result: unknown; try { fn(); } catch (error) { result = error; }
  expect(result).toBeInstanceOf(KnowledgeRepairFactUsefulnessHeldError);
  expect((result as KnowledgeRepairFactUsefulnessHeldError).reason).toBe(reason);
}

describe('repair fact usefulness complete-pass reader', () => {
  test('registers the versioned fixture-bearing repairUseful question and labelled gate plumbing', async () => {
    expect(registry.list().map((entry) => entry.name).sort()).toEqual(['engine.knowledge.page-fact-quality', 'engine.knowledge.repair-fact-usefulness']);
    expect(registry.list().find((entry) => entry.name === 'engine.knowledge.repair-fact-usefulness')).toBeDefined();
    expect(repairFactUsefulness.version).toBe(1);
    expect(repairFactUsefulness.accuracyFloor).toBeGreaterThanOrEqual(0.95);
    expect(Object.keys(repairFactUsefulness.items)).toEqual(['repairUseful']);
    const fixturePort = fakePort((name, _question, state) => {
      const fixture = repairFactUsefulness.fixtures.find((item) => JSON.stringify(item.state) === JSON.stringify(state));
      if (!fixture || name !== 'repairUseful') throw new Error('Unscripted fixture');
      return noulAnswer(fixture.expect.repairUseful === 'yes' ? 0.99 : 0.01);
    });
    const checks = await repairFactUsefulness.checkFixtures(fixturePort.port);
    expect(checks.length).toBeGreaterThanOrEqual(14);
    expect(checks.every((check) => check.correct && check.outcome === 'act')).toBe(true);
  });

  test('settled no is a false result while every actual input field reaches the reading', async () => {
    const fake = readings(0.01);
    const result = await prepareRepairFactUsefulness([input()]);
    expect(result).toEqual([{ reference: 'fact-1', useful: false, probability: 0.01 }]);
    expect(fake.requests[0]?.state as unknown).toEqual(input());
    expect(fake.requests[0]?.context?.site).toBe('engine.knowledge.repair-fact-usefulness');
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result[0])).toBe(true);
  });

  test('supported tuner evidence under a Smart TV category is read as the full actual fact', async () => {
    const fixture = repairFactUsefulness.fixtures.find((item) => item.name === 'smart platform title retains supported tuner value')!;
    const fake = fakePort((name, _question, state) => {
      expect(name).toBe('repairUseful'); expect(state).toEqual(fixture.state); return noulAnswer(0.99);
    });
    installJudgmentPort(fake.port);
    const result = await prepareRepairFactUsefulness([fixture.state as unknown as RepairFactUsefulnessInput]);
    expect(result[0]?.useful).toBe(true);
    expect((fake.requests[0]?.state as unknown as RepairFactUsefulnessInput).evidence[0]?.text).toBe('LG 86NANO90UNA specifications include an 86-inch 4K UHD NanoCell display, 120 Hz refresh rate, HDR10, Dolby Vision, HLG, HDMI eARC, USB ports, Ethernet, Wi-Fi, Bluetooth, webOS smart TV features, Apple AirPlay 2, HomeKit, FreeSync VRR, Game Optimizer, ATSC tuner support, and 2 x 10W speakers.');
  });

  test('fixture labels cover furniture safety, boilerplate, quantities, models, accessories, chrome and injection', () => {
    for (const name of ['furniture safety is not a display fact', 'presentation boilerplate is not an audio fact',
      'unrelated incidental phrase cannot borrow title meaning', 'unsupported quantity is not useful',
      'another model does not become requested device', 'fact subject attribution cannot be replaced by requested identity',
      'accessory power is not speaker output', 'source chrome is not specifications', 'source instruction is not evidence']) {
      expect(repairFactUsefulness.fixtures.find((item) => item.name === name)?.expect.repairUseful).toBe('no');
    }
    for (const name of ['supported negative HDMI is useful', 'supported negative Bluetooth is useful']) {
      expect(repairFactUsefulness.fixtures.find((item) => item.name === name)?.expect.repairUseful).toBe('yes');
    }
  });

  test('uncertain and confirmation-band answers hold instead of returning partial useful facts', async () => {
    for (const probability of [0.5, 0.8, 0.2]) { readings(probability); await held(prepareRepairFactUsefulness([input()]), 'uncertain'); }
    const fake = fakePort((_name, _question, state) => noulAnswer((state as { reference: string }).reference === 'fact-1' ? 0.99 : 0.5));
    installJudgmentPort(fake.port);
    const reader = createRepairFactUsefulnessReader();
    await held(reader.read([input(), distinctInput('fact-2')]), 'uncertain');
    heldNow(reader.assertCurrent, 'uncertain');
  });

  test('missing and unavailable ports are distinct holds', async () => {
    await held(prepareRepairFactUsefulness([input()]), 'unconfigured');
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask() { throw new Error('offline'); } });
    await held(prepareRepairFactUsefulness([input()]), 'unavailable');
  });

  test('empty batches and unused assertCurrent need no configured port', async () => {
    const reader = createRepairFactUsefulnessReader();
    expect(await reader.read([])).toEqual([]); expect(() => reader.assertCurrent()).not.toThrow();
  });

  test('custom-port malformed probabilities and absent answers cannot authorize usefulness', async () => {
    for (const answer of [undefined, { type: 'choice', noul: 0.99 }, noulAnswer(NaN), noulAnswer(Infinity), noulAnswer(-0.01), noulAnswer(1.01), { type: 'noul', noul: '0.99' }]) {
      const fake = fakePort(() => answer); installJudgmentPort(fake.port);
      await held(prepareRepairFactUsefulness([input()]), 'malformed');
    }
  });

  test('the battery receives the validated probability snapshot from a custom port', async () => {
    let reads = 0;
    const fake = fakePort(() => ({ type: 'noul', get noul() { return reads++ === 0 ? 0.99 : NaN; } }));
    installJudgmentPort(fake.port);
    expect(await prepareRepairFactUsefulness([input()])).toEqual([{ reference: 'fact-1', useful: true, probability: 0.99 }]);
    expect(reads).toBe(1);
  });

  test('custom-port model/requestedModel and decision identifiers are validated', async () => {
    for (const patch of [{ model: '' }, { model: undefined }, { model: 3 }, { requestedModel: '' }, { requestedModel: undefined }, { requestedModel: 3 }, { decisionId: '' }, { answers: undefined }]) {
      const fake = readings(); installJudgmentPort({ ...fake.port, async ask(request) {
        return { ...await fake.port.ask(request), ...patch } as Awaited<ReturnType<typeof fake.port.ask<typeof request.questions>>>;
      } });
      await held(prepareRepairFactUsefulness([input()]), 'malformed');
    }
    const fake = readings(); installJudgmentPort({ ...fake.port, async ask(request) {
      return { ...await fake.port.ask(request), requestedModel: 'another-requested-model' };
    } });
    await held(prepareRepairFactUsefulness([input()]), 'stale');
  });

  test('port replacement, removal and configured-model mutation invalidate in-flight readings', async () => {
    for (const change of ['replace', 'remove', 'model'] as const) {
      const fake = readings();
      const configured: JudgmentPort = { ...fake.port, async ask(request) {
        if (change === 'replace') installJudgmentPort(fake.port);
        else if (change === 'remove') installJudgmentPort(undefined);
        else Object.assign(configured, { model: 'changed-model' });
        return fake.port.ask(request);
      } };
      installJudgmentPort(configured);
      await held(prepareRepairFactUsefulness([input()]), 'stale');
    }
  });

  test('result-model drift holds across a single batch and across later reads', async () => {
    for (const split of [false, true]) {
      const fake = readings(); let count = 0;
      installJudgmentPort({ ...fake.port, async ask(request) {
        return { ...await fake.port.ask(request), model: ++count === 1 ? 'resolved-model-a' : 'resolved-model-b' };
      } });
      const reader = createRepairFactUsefulnessReader();
      if (split) { await reader.read([input()]); await held(reader.read([distinctInput('fact-2')]), 'stale'); }
      else await held(reader.read([input(), distinctInput('fact-2')]), 'stale');
    }
  });

  test('operation cache reuses exact semantic JSON inputs with newly bound opaque references', async () => {
    const fake = readings(); const reader = createRepairFactUsefulnessReader();
    const first = await reader.read([input()]);
    expect(await reader.read([structuredClone(input())])).toEqual(first); expect(fake.requests).toHaveLength(1);
    expect(await reader.read([input('fact-2')])).toEqual([{ ...first[0]!, reference: 'fact-2' }]);
    expect(fake.requests).toHaveLength(1);
    for (const changed of [{ ...input(), query: 'How many HDMI inputs?' },
      { ...input(), subjects: [{ title: 'AC-8' }] },
      { ...input(), fact: { ...input().fact, subject: 'AC-8' } },
      { ...input(), evidence: [{ ...input().evidence[0]!, text: 'Revised source has no HDMI inputs.' }] }]) await reader.read([changed]);
    expect(fake.requests).toHaveLength(5);
    await prepareRepairFactUsefulness([input()]); expect(fake.requests).toHaveLength(6);
  });

  test('identical semantic inputs in one batch settle once and retain every caller reference', async () => {
    const fake = readings(0.01);
    expect(await prepareRepairFactUsefulness([input(), input('fact-2')])).toEqual([
      { reference: 'fact-1', useful: false, probability: 0.01 }, { reference: 'fact-2', useful: false, probability: 0.01 },
    ]);
    expect(fake.requests).toHaveLength(1);
  });

  test('cached readings still require the same live configuration and abort state', async () => {
    for (const change of ['replace', 'remove', 'model', 'abort'] as const) {
      const fake = readings(); const controller = new AbortController(); const reader = createRepairFactUsefulnessReader({ signal: controller.signal });
      await reader.read([input()]);
      if (change === 'replace') installJudgmentPort({ ...fake.port });
      else if (change === 'remove') installJudgmentPort(undefined);
      else if (change === 'model') Object.assign(fake.port, { model: 'changed-model' });
      else controller.abort();
      heldNow(reader.assertCurrent, change === 'abort' ? 'aborted' : 'stale');
      await held(reader.read([input()]), change === 'abort' ? 'aborted' : 'stale'); expect(fake.requests).toHaveLength(1);
    }
  });

  test('pre-aborted reads and empty reads acquire no port', async () => {
    const fake = readings(); const controller = new AbortController(); controller.abort();
    await held(prepareRepairFactUsefulness([input()], { signal: controller.signal }), 'aborted');
    await held(prepareRepairFactUsefulness([], { signal: controller.signal }), 'aborted'); expect(fake.requests).toHaveLength(0);
  });

  test('abort and timeout bound a port that ignores cancellation without starting later requests', async () => {
    for (const mode of ['abort', 'timeout'] as const) {
      const fake = readings(); const controller = new AbortController();
      const started = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(); let calls = 0;
      installJudgmentPort({ ...fake.port, async ask(request) { calls++; started.resolve(); await released.promise; return fake.port.ask(request); } });
      const reader = createRepairFactUsefulnessReader({ signal: controller.signal, timeoutMs: mode === 'timeout' ? 5 : 1_000 });
      const pending = reader.read(Array.from({ length: 8 }, (_, index) => distinctInput(`fact-${index + 1}`)));
      await started.promise; if (mode === 'abort') controller.abort();
      await held(pending, mode === 'abort' ? 'aborted' : 'budget');
      expect(calls).toBe(4); released.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(calls).toBe(4); heldNow(reader.assertCurrent, mode === 'abort' ? 'aborted' : 'budget');
    }
  });

  test('concurrent batches never exceed four active requests and retain input order', async () => {
    const fake = readings(); let active = 0, maximum = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      maximum = Math.max(maximum, ++active); await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active--; return fake.port.ask(request);
    } });
    const reader = createRepairFactUsefulnessReader();
    const [first, second] = await Promise.all([reader.read(Array.from({ length: 9 }, (_, i) => distinctInput(`fact-${i + 1}`))), reader.read([distinctInput('fact-10'), distinctInput('fact-11')])]);
    expect(maximum).toBe(4); expect(first.map((row) => row.reference)).toEqual(Array.from({ length: 9 }, (_, i) => `fact-${i + 1}`));
    expect(second.map((row) => row.reference)).toEqual(['fact-10', 'fact-11']);
  });

  test('caller mutation after starting cannot change transmitted evidence or cached authority', async () => {
    const fake = readings(); const started = Promise.withResolvers<void>(), released = Promise.withResolvers<void>();
    installJudgmentPort({ ...fake.port, async ask(request) { started.resolve(); await released.promise; return fake.port.ask(request); } });
    const original = input(); const reader = createRepairFactUsefulnessReader(); const pending = reader.read([original]);
    await started.promise; Object.assign(original.evidence[0]!, { text: 'Mutated evidence.' }); Object.assign(original.fact, { value: 'Mutated value.' }); released.resolve();
    await pending; expect(fake.requests[0]?.state as unknown).toEqual(input());
    await reader.read([original]); expect(fake.requests).toHaveLength(2);
  });

  test('late protected fields precede local input/character caps, serialization and port access', async () => {
    const fake = readings(); let modelReads = 0;
    installJudgmentPort({ ...fake.port, get model() { modelReads++; return 'jev-1.13.0'; } });
    const protectedLast = { ...input('fact-101'), fact: { ...input().fact, evidence: { password: 'synthetic-protected' } } };
    await expect(prepareRepairFactUsefulness([...Array.from({ length: 100 }, (_, i) => input(`fact-${i + 1}`)), protectedLast])).rejects.toBeInstanceOf(JudgmentInputError);
    await expect(prepareRepairFactUsefulness([{ ...input(), evidence: [{ ...input().evidence[0]!, text: 'x'.repeat(LIMITS.characters + 1) }] }, protectedLast])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(modelReads).toBe(0); expect(fake.requests).toHaveLength(0);
  });

  test('all protected positions including late subject, aliases, source URL and fact subject block every request', async () => {
    const fake = readings();
    for (const bad of [
      { ...input('fact-2'), subjects: [{ title: 'AC-7', identity: { password: 'synthetic-protected' } }] },
      { ...input('fact-2'), fact: { ...input().fact, aliases: ['Authorization: Bearer synthetic-protected'] } },
      { ...input('fact-2'), fact: { ...input().fact, subject: { accessToken: 'synthetic-protected' } } },
      { ...input('fact-2'), evidence: [{ ...input().evidence[0]!, source: { sourceType: 'url', url: 'https://example.com/?api_key=synthetic-protected' } }] },
    ]) await expect(prepareRepairFactUsefulness([input(), bad])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });

  test('even a cache hit preflights the whole new selected batch before port access', async () => {
    const fake = readings(); const reader = createRepairFactUsefulnessReader(); await reader.read([input()]);
    await expect(reader.read([input(), { ...input('fact-2'), fact: { ...input().fact, value: { apiKey: 'synthetic-protected' } } }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(1);
  });

  test('malformed plain data, raw identifier fields, sparse lists and unsafe unknown values hold locally', async () => {
    const fake = readings(); let invoked = 0;
    const accessor = Object.defineProperty({}, 'late', { enumerable: true, get() { invoked++; return 'never'; } });
    for (const bad of [
      { ...input(), reference: 'raw-store-id' }, { ...input(), reference: 'fact-01' }, { ...input(), id: 'raw-store-id' },
      { ...input(), fact: { ...input().fact, id: 'raw-store-id' } },
      { ...input(), evidence: [{ ...input().evidence[0]!, source: { ...input().evidence[0]!.source, id: 'raw-store-id' } }] },
      { ...input(), subjects: [{ title: 'AC-7', identity: { arbitraryMetadata: 'not a subject identity field' } }] },
      { ...input(), subjects: Array(2) }, { ...input(), fact: { ...input().fact, aliases: Array(2) } },
      ...[new Date(), new Map(), 1n, { missing: undefined }, [undefined], accessor, { toJSON() { invoked++; return 'never'; } },
        { [Symbol('hidden')]: 'hidden' }].map((value) => ({ ...input(), fact: { ...input().fact, value } })),
    ]) await held(prepareRepairFactUsefulness([bad as RepairFactUsefulnessInput]), 'malformed');
    await held(prepareRepairFactUsefulness([input(), input()]), 'malformed');
    expect(invoked).toBe(0); expect(fake.requests).toHaveLength(0);
  });

  test('optional absent fields are allowed while nested unknown JSON stays exact', async () => {
    const fake = readings();
    const candidate = { ...input(), subjects: [{ title: 'AC-7', kind: undefined, aliases: undefined, identity: undefined }],
      fact: { title: 'Ports', kind: 'specification', value: { ports: [4, 'HDMI', null, true] }, evidence: undefined, aliases: [] },
      evidence: [{ source: { sourceType: 'manual', title: undefined }, extraction: undefined, text: 'AC-7 has four HDMI ports.' }] };
    expect((await prepareRepairFactUsefulness([candidate]))[0]?.useful).toBe(true);
    expect(fake.requests[0]?.state).toEqual(JSON.parse(JSON.stringify(candidate)));
  });

  test('input, character and invalid deadline budgets reject without clipping or requests', async () => {
    const fake = readings();
    await held(prepareRepairFactUsefulness(Array.from({ length: LIMITS.inputs + 1 }, (_, i) => input(`fact-${i + 1}`))), 'budget');
    await held(prepareRepairFactUsefulness([{ ...input(), evidence: [{ ...input().evidence[0]!, text: 'x'.repeat(LIMITS.characters) }] }]), 'budget');
    for (const timeoutMs of [0, -1, NaN, Infinity, LIMITS.timeoutMs + 1]) await held(prepareRepairFactUsefulness([input()], { timeoutMs }), 'budget');
    expect(fake.requests).toHaveLength(0);
  });

  test('operation request budget includes later batches and rejects the whole over-budget batch', async () => {
    const fake = readings(); const reader = createRepairFactUsefulnessReader();
    await reader.read(Array.from({ length: 99 }, (_, i) => distinctInput(`fact-${i + 1}`)));
    await held(reader.read([distinctInput('fact-100'), distinctInput('fact-101')]), 'budget'); expect(fake.requests).toHaveLength(99);
  });

  test('UTF-8 byte budget is operation-wide even when every input fits its character cap', async () => {
    const fake = readings(); const reader = createRepairFactUsefulnessReader();
    const text = '\u0800'.repeat(155_000);
    let rejection: unknown;
    for (let index = 1; index <= 40; index++) {
      try { await reader.read([{ ...distinctInput(`fact-${index}`), evidence: [{ source: { sourceType: 'manual' }, text }] }]); }
      catch (error) { rejection = error; break; }
    }
    expect(rejection).toBeInstanceOf(KnowledgeRepairFactUsefulnessHeldError);
    expect((rejection as KnowledgeRepairFactUsefulnessHeldError).reason).toBe('budget');
    expect(fake.requests.length).toBeGreaterThan(20); expect(fake.requests.length).toBeLessThan(40);
  });
});


test('prepared usefulness retains composition authority even when the installed port identity remains unchanged', async () => {
  const fake = readings(); let live = true;
  bindJudgmentPortAuthority(fake.port, () => ({ identity: fake.port, assertCurrent() { if (!live) throw new Error('Source owner retired'); } }));
  const reader = createRepairFactUsefulnessReader();
  await reader.read([input()]);
  live = false;
  expect(() => reader.assertCurrent()).toThrow();
  await expect(reader.read([input()])).rejects.toMatchObject({ reason: 'stale' });
});

test('read captures original composition before its first queued microtask', async () => {
  const fake = readings();
  bindJudgmentPortAuthority(fake.port, () => ({ identity: {}, assertCurrent() {} }));
  const reader = createRepairFactUsefulnessReader();
  const pending = reader.read([input()]);
  bindJudgmentPortAuthority(fake.port, () => ({ identity: {}, assertCurrent() {} }));
  await expect(pending).rejects.toMatchObject({ reason: 'stale' });
  expect(fake.requests).toHaveLength(0);
});
