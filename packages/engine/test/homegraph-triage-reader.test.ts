import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort, JudgmentResult } from '@goodvibes-jev/judgment';
import { fakePort, choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { prepareHomeGraphTriageReadings, HomeGraphTriageHeldError, type TriageReadInput, type TriageHoldReason } from '../sdk/src/platform/knowledge/home-graph/triage/reader.js';
import { homeGraphTriageApplicability, homeGraphBatteryFacts, homeGraphManualFact } from '../sdk/src/platform/knowledge/home-graph/triage/batteries.js';
import { registry } from '../sdk/src/platform/knowledge/home-graph/triage/judgment-registry.js';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const input = (code = 'homegraph.device.unknown_battery'): TriageReadInput => ({ reference: 'issue-1', issue: { code, severity: 'warning', message: 'Synthetic quality issue' }, subject: { kind: 'ha_device', title: 'Software-only schedule', homeAssistant: { objectKind: 'automation' } } });
const good = (action = 'reject', probability = 0.97, fact = 0.99) => {
  const fake = fakePort((name, question) => name === 'action' ? choiceAnswer(question, action, probability) : noulAnswer(fact));
  installJudgmentPort(fake.port); return fake;
};
async function held(work: Promise<unknown>, reason: TriageHoldReason) {
  let caught: unknown; try { await work; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(HomeGraphTriageHeldError); expect((caught as HomeGraphTriageHeldError).reason).toBe(reason);
}
describe('registered Home Graph triage readings', () => {
  test('registers applicability and independent battery/manual facts with contrary-evidence fixtures', () => {
    expect(registry.list()).toHaveLength(3);
    for (const battery of [homeGraphTriageApplicability, homeGraphBatteryFacts, homeGraphManualFact]) { expect(battery.accuracyFloor).toBe(0.95); expect(battery.fixtures.length).toBeGreaterThan(1); }
    const names = [homeGraphTriageApplicability, homeGraphBatteryFacts, homeGraphManualFact].flatMap((battery) => battery.fixtures.map((fixture) => fixture.name)).join(' ');
    for (const word of ['backup', 'missing', 'injected', 'name']) expect(names).toContain(word);
  });
  test('reject requires separately supported exact facts; preserves real IDs/model and freezes plans', async () => {
    const fake = good(); let count = 0;
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), decisionId: `decision-${++count}` }; } });
    const [plan] = await prepareHomeGraphTriageReadings([input()]);
    expect(fake.requests).toHaveLength(2); expect(plan!.facts).toEqual({ batteryPowered: false, batteryType: 'none' });
    expect(plan!.decisionIds).toEqual(['decision-1', 'decision-2']); expect(plan!.origin).toBe('automatic-judgment');
    expect(plan!.probability).toBe(0.97); expect(plan!.model).toBe(fake.port.model);
    expect(Object.isFrozen(plan!.facts)).toBe(true); expect(Object.isFrozen(plan!.batteries)).toBe(true);
  });
  test('manual fact is separate, custom reject creates no arbitrary facts, and review never asks fact questions', async () => {
    good(); expect((await prepareHomeGraphTriageReadings([input('homegraph.device.missing_manual')]))[0]!.facts).toEqual({ manualRequired: false });
    const custom = good(); expect((await prepareHomeGraphTriageReadings([input('homegraph.custom')]))[0]!.facts).toEqual({}); expect(custom.requests).toHaveLength(1);
    const review = good('review'); expect((await prepareHomeGraphTriageReadings([input()]))[0]!.facts).toEqual({}); expect(review.requests).toHaveLength(1);
  });
  test('probability boundaries and stricter owner floors never normalize guessed 0–100 readings', async () => {
    for (const probability of [0.5, 0.8, 0.84999]) { good('reject', probability); await held(prepareHomeGraphTriageReadings([input()], { minConfidence: 0 }), 'unsettled'); }
    good('reject', 0.85); expect((await prepareHomeGraphTriageReadings([input()], { minConfidence: 1 }))[0]!.probability).toBe(0.85);
    good('reject', 0.89999); await held(prepareHomeGraphTriageReadings([input()], { minConfidence: 90 }), 'owner-threshold');
    good('reject', 95); await held(prepareHomeGraphTriageReadings([input()]), 'malformed');
  });
  test('unsupported or uncertain battery/manual fact holds the entire selected pass', async () => {
    for (const fact of [0.01, 0.5, 0.8]) {
      good('reject', 0.99, fact); await held(prepareHomeGraphTriageReadings([input(), { ...input('homegraph.device.missing_manual'), reference: 'issue-2' }]), fact === 0.01 ? 'unsupported-fact' : 'unsettled');
    }
  });
  test('protected late input and getters are held before any port request; nothing is clipped', async () => {
    const fake = good();
    await expect(prepareHomeGraphTriageReadings([input(), { ...input(), reference: 'issue-2', subject: { title: `${'safe '.repeat(9000)} Authorization: Bearer synthetic` } }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
    let getterCalls = 0; const subject = { get title() { getterCalls++; return 'safe'; } };
    await expect(prepareHomeGraphTriageReadings([{ ...input(), subject }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(getterCalls).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  test('missing and failed providers differ from uncertainty; malformed readings hold', async () => {
    await held(prepareHomeGraphTriageReadings([input()]), 'unconfigured');
    const fake = good(); installJudgmentPort({ ...fake.port, ask: async () => { throw new Error('offline'); } });
    await held(prepareHomeGraphTriageReadings([input()]), 'unavailable');
    installJudgmentPort({ ...fake.port, async ask(request) { const result = await fake.port.ask(request); return { ...result, answers: { action: { type: 'choice', choice: 'reject', confidence: 0.99, probabilities: { reject: 0.01, review: 0.99 } } } } as unknown as JudgmentResult<typeof request.questions>; } });
    await held(prepareHomeGraphTriageReadings([input()]), 'malformed');
  });
  test('whole-pass deadline and cancellation settle even for a port that ignores its signal', async () => {
    const fake = good(); installJudgmentPort({ ...fake.port, ask: async () => new Promise(() => {}) });
    await held(prepareHomeGraphTriageReadings([input()], { timeoutMs: 10 }), 'budget');
    const controller = new AbortController(); const work = prepareHomeGraphTriageReadings([input()], { signal: controller.signal }); controller.abort();
    await held(work, 'aborted');
  });
});
