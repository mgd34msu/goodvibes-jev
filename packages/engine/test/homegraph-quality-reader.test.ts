import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort, JudgmentResult } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { readHomeGraphQuality, HomeGraphQualityHeldError, type HomeGraphQualityInput, type HomeGraphQualityHoldReason } from '../sdk/src/platform/knowledge/home-graph/quality/reader.js';
import { projectHomeGraphQualityInput, readHomeGraphDeclaredBoolean } from '../sdk/src/platform/knowledge/home-graph/quality/projection.js';
import { homeGraphQualityBatteries } from '../sdk/src/platform/knowledge/home-graph/quality/batteries.js';
import { registry } from '../sdk/src/platform/knowledge/home-graph/quality/judgment-registry.js';
import { missingDevicePassportFields } from '../sdk/src/platform/knowledge/home-graph/state.js';
import type { KnowledgeNodeRecord } from '../sdk/src/platform/knowledge/types.js';
let previous: JudgmentPort | undefined;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const input = (): HomeGraphQualityInput => ({ reference: 'device-1', subject: { kind: 'ha_device', title: 'Mains service hub', summary: 'Physical device with backup battery.' }, entities: [], facts: [], questions: ['batteryApplicable', 'manualApplicable'] });
const node = (metadata: Record<string, unknown> = {}): KnowledgeNodeRecord => ({ id: 'LOCAL_DEVICE_ID', kind: 'ha_device', slug: 'synthetic', title: 'Portable light', summary: 'Actual physical device.', aliases: [], status: 'active', confidence: 20, metadata, createdAt: 1, updatedAt: 1 });
function good(value = 0.99) { const fake = fakePort(() => noulAnswer(value)); installJudgmentPort(fake.port); return fake; }
async function held(work: Promise<unknown>, reason: HomeGraphQualityHoldReason) {
  let error: unknown; try { await work; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(HomeGraphQualityHeldError); expect((error as HomeGraphQualityHeldError).reason).toBe(reason);
}
describe('Home Graph registered applicability and completeness', () => {
  test('registers five independent questions with contrary-name, same-name and missing-information fixtures', () => {
    expect(registry.list()).toHaveLength(5);
    for (const battery of Object.values(homeGraphQualityBatteries)) { expect(battery.accuracyFloor).toBe(0.95); expect(battery.fixtures.length).toBeGreaterThan(2); }
    const names = Object.values(homeGraphQualityBatteries).flatMap((battery) => battery.fixtures.map((fixture) => fixture.name)).join(' ');
    for (const word of ['backup', 'same name', 'missing', 'keyword', 'accessory']) expect(names).toContain(word);
  });
  test('independent applicability readings override names and entity-domain guesses', async () => {
    const fake = fakePort((name) => noulAnswer(name === 'batteryApplicable' ? 0.99 : 0.01)); installJudgmentPort(fake.port);
    const [reading] = await readHomeGraphQuality([input()]);
    expect(reading!.answers).toEqual({ batteryApplicable: true, manualApplicable: false }); expect(fake.requests).toHaveLength(2);
    expect(reading!.batteries).toHaveLength(2); expect(Object.isFrozen(reading!.answers)).toBe(true);
  });
  test('preflights complete late device/fact text and accessors before any request', async () => {
    const fake = good();
    await expect(readHomeGraphQuality([input(), { ...input(), reference: 'device-2', facts: [{ reference: 'fact-1', title: `${'safe '.repeat(9000)} Authorization: Bearer synthetic` }] }])).rejects.toBeInstanceOf(JudgmentInputError);
    let getters = 0; const subject = { kind: 'ha_device', get title() { getters++; return 'safe'; } };
    await expect(readHomeGraphQuality([{ ...input(), subject }])).rejects.toBeInstanceOf(JudgmentInputError);
    expect(getters).toBe(0); expect(fake.requests).toHaveLength(0);
  });
  test('projection includes declared selected evidence without IDs, authority or unrelated private metadata', async () => {
    const fake = good();
    const projected = projectHomeGraphQualityInput('device-1', node({ manufacturer: 'Luma', model: 'P2', homeAssistant: { objectId: 'ha-identity', apiKey: 'DO_NOT_TRANSMIT' }, attributes: { device_class: 'battery', password: 'DO_NOT_TRANSMIT' }, review: { action: 'reject' }, private: 'DO_NOT_TRANSMIT' }), [], [node({ value: 'CR2032', evidence: 'Fitted cell', labels: ['specification'] })], ['batteryTypePresent']);
    await readHomeGraphQuality([projected]);
    const sent = JSON.stringify(fake.requests);
    for (const absent of ['LOCAL_DEVICE_ID', 'DO_NOT_TRANSMIT', 'review', 'createdAt', 'updatedAt', 'confidence']) expect(sent).not.toContain(absent);
    for (const present of ['ha-identity', 'Luma', 'P2', 'CR2032', 'Fitted cell', 'specification']) expect(sent).toContain(present);
    const raw = node(); let getters = 0; Object.defineProperty(raw, 'title', { get() { getters++; return 'x'; } });
    expect(() => projectHomeGraphQualityInput('device-1', raw, [], [], ['batteryApplicable'])).toThrow(JudgmentInputError); expect(getters).toBe(0);
  });
  test('finite numeric fact values survive projection, and all question requests share immutable evidence', async () => {
    const projected = projectHomeGraphQualityInput('device-1', node(), [], [node({ value: 2032, evidence: 'Cell designation' })], ['manufacturerPresent', 'modelPresent']);
    const fake = good(); let checked = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const state = request.state as { subject: { title: string }; facts: { value: number }[] };
      expect(Object.isFrozen(state)).toBe(true); expect(Object.isFrozen(state.subject)).toBe(true);
      expect(state.facts[0]!.value).toBe(2032); expect(state.subject.title).toBe('Portable light');
      try { state.subject.title = 'Altered'; } catch { /* Frozen writes must not change the next question. */ }
      checked++; return fake.port.ask(request);
    } });
    await readHomeGraphQuality([projected]); expect(checked).toBe(2);
  });
  test('literal flags keep every existing spelling; unknown declarations hold', () => {
    for (const value of [true, 'true', 'YES', ' 1 ']) expect(readHomeGraphDeclaredBoolean(value)).toBe(true);
    for (const value of [false, 'false', 'NO', '0', 'none', 'not_applicable', 'not applicable']) expect(readHomeGraphDeclaredBoolean(value)).toBe(false);
    expect(readHomeGraphDeclaredBoolean(undefined)).toBeUndefined();
    for (const value of ['maybe', '', 1, 0, {}]) expect(() => readHomeGraphDeclaredBoolean(value)).toThrow(HomeGraphQualityHeldError);
  });
  test('passport fact existence is semantic and independent, with direct fields/source counts preserved', async () => {
    const fake = fakePort((name) => noulAnswer(({ batteryApplicable: 0.99, manufacturerPresent: 0.99, modelPresent: 0.01, batteryTypePresent: 0.01 } as Record<string, number>)[name] ?? 0.01)); installJudgmentPort(fake.port);
    const fact = { ...node(), title: 'Built by Luma; model unknown; battery 52 percent.' };
    expect(await missingDevicePassportFields(node(), [], [fact])).toEqual(['model', 'battery type', 'manual/source']);
    expect(fake.requests).toHaveLength(4);
    const direct = good(); expect(await missingDevicePassportFields(node({ manufacturer: '', model: 'P2', batteryType: 'CR2032' }), [], [fact])).toEqual(['manual/source']); expect(direct.requests).toHaveLength(0);
  });
  test('zero facts are verified structural absence, not a guessed textual match', async () => {
    expect(await missingDevicePassportFields(node({ batteryPowered: 'no' }), [])).toEqual(['manufacturer', 'model', 'manual/source']);
  });
  test('unconfigured, unavailable, unsettled, malformed and later-held never return a partial result', async () => {
    await held(readHomeGraphQuality([input()]), 'unconfigured');
    for (const probability of [0.5, 0.8]) { good(probability); await held(readHomeGraphQuality([input()]), 'unsettled'); }
    good(99); await held(readHomeGraphQuality([input()]), 'malformed');
    const fake = good(); installJudgmentPort({ ...fake.port, ask: async () => { throw new Error('offline'); } }); await held(readHomeGraphQuality([input()]), 'unavailable');
    installJudgmentPort(fakePort((name) => noulAnswer(name === 'manualApplicable' ? 0.5 : 0.99)).port); await held(readHomeGraphQuality([input()]), 'unsettled');
    installJudgmentPort({ ...fake.port, async ask(request) { return { ...await fake.port.ask(request), model: '' } as JudgmentResult<typeof request.questions>; } }); await held(readHomeGraphQuality([input()]), 'malformed');
  });
  test('malformed and over-budget sets cannot issue a partial or silently truncated pass', async () => {
    const fake = good();
    await held(readHomeGraphQuality([input(), input()]), 'malformed');
    await held(readHomeGraphQuality([{ ...input(), questions: ['batteryApplicable', 'batteryApplicable'] }]), 'malformed');
    await held(readHomeGraphQuality([{ ...input(), facts: Array.from({ length: 501 }, (_, index) => ({ reference: `fact-${index + 1}`, title: 'Synthetic fact' })) }]), 'budget');
    expect(fake.requests).toHaveLength(0);
  });
  test('whole-pass deadline/cancellation stop ports that ignore their signal', async () => {
    const fake = good(); installJudgmentPort({ ...fake.port, ask: async () => new Promise(() => {}) });
    await held(readHomeGraphQuality([input()], { timeoutMs: 10 }), 'budget');
    const controller = new AbortController(); const work = readHomeGraphQuality([input()], { signal: controller.signal }); controller.abort(); await held(work, 'aborted');
  });
});
