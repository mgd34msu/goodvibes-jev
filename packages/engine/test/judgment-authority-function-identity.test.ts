import { afterEach, beforeEach, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, captureJudgmentPort, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { noul, type JudgmentPort } from '@goodvibes-jev/judgment';
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const request = { state: {}, questions: { yes: noul('Synthetic question') } };
for (const mode of ['ask', 'health', 'recorder', 'recordReadings', 'recordAction'] as const) test(`canonical capture rejects same-object ${mode} replacement`, async () => {
  const fake = fakePort(() => noulAnswer(0.99)); let retained = 0;
  const port = { ...fake.port, health: () => ({} as never), recorder: {
    recordReadings: () => { retained += 1; }, recordAction: () => { retained += 1; },
  } };
  installJudgmentPort(port); const owner = captureJudgmentPort('test.function-identity');
  if (mode === 'ask') port.ask = async () => { throw new Error('replacement called'); };
  if (mode === 'health') port.health = () => ({} as never);
  if (mode === 'recorder') port.recorder = { recordReadings() {}, recordAction() {} };
  if (mode === 'recordReadings') port.recorder.recordReadings = () => {};
  if (mode === 'recordAction') port.recorder.recordAction = () => {};
  await expect(owner.port.ask(request)).rejects.toThrow('no longer current');
  expect(() => owner.port.recorder!.recordAction('synthetic', 'act')).toThrow('no longer current');
  expect(fake.requests).toHaveLength(0); expect(retained).toBe(0);
});
test('held same-object ask replacement cannot publish a result', async () => {
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { began = resolve; });
  const base = fakePort(() => noulAnswer(0.99)).port;
  const port: JudgmentPort = { model: base.model, ask: async input => { began(); await gate; return base.ask(input); } };
  installJudgmentPort(port); const owner = captureJudgmentPort('test.function-identity');
  const pending = owner.port.ask(request), refused = pending.then(() => null, error => error);
  await started;
  Object.assign(port, { ask: base.ask }); release(); expect(await refused).toBeInstanceOf(Error);
});

for (const mode of ['assertCurrent', 'identity', 'signal'] as const) test(`canonical capture rejects changed source-frame ${mode}`, async () => {
  const fake = fakePort(() => noulAnswer(0.99));
  const frame = { identity: {}, signal: new AbortController().signal, assertCurrent() {} };
  bindJudgmentPortAuthority(fake.port, () => frame); installJudgmentPort(fake.port);
  const owner = captureJudgmentPort('test.frame-identity');
  if (mode === 'assertCurrent') frame.assertCurrent = () => {};
  if (mode === 'identity') frame.identity = {};
  if (mode === 'signal') frame.signal = new AbortController().signal;
  await expect(owner.port.ask(request)).rejects.toThrow('no longer current');
  expect(fake.requests).toHaveLength(0);
});

test('consumption permanently retires observation while retaining installation restrictions', async () => {
  const source = new AbortController(), fake = fakePort(() => noulAnswer(0.99));
  bindJudgmentPortAuthority(fake.port, () => ({ identity: {}, signal: source.signal, assertCurrent() {} }));
  installJudgmentPort(fake.port); const owner = captureJudgmentPort('test.consume');
  const effect = owner.consumeObservation(); source.abort();
  expect(() => effect.assertCurrent()).not.toThrow();
  expect(() => owner.assertCurrent()).toThrow(); expect(() => owner.consumeObservation()).toThrow();
  await expect(owner.port.ask(request)).rejects.toThrow();
  installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
  expect(() => effect.assertCurrent()).toThrow();
});

for (const mode of ['assertCurrent', 'identity', 'signal'] as const) test(`consumed restriction retains source-frame ${mode} identity`, () => {
  const fake = fakePort(() => noulAnswer(0.99));
  const frame = { identity: {}, signal: new AbortController().signal, assertCurrent() {} };
  bindJudgmentPortAuthority(fake.port, () => frame); installJudgmentPort(fake.port);
  const effect = captureJudgmentPort('test.consumed-frame').consumeObservation();
  if (mode === 'assertCurrent') frame.assertCurrent = () => {};
  if (mode === 'identity') frame.identity = {};
  if (mode === 'signal') frame.signal = new AbortController().signal;
  expect(() => effect.assertCurrent()).toThrow('no longer current');
});

test('source callback cannot replace its frame during the final owner check', () => {
  const fake = fakePort(() => noulAnswer(0.99)); let mutate = false;
  const frame = { identity: {}, signal: new AbortController().signal, assertCurrent() { if (mutate) frame.identity = {}; } };
  bindJudgmentPortAuthority(fake.port, () => frame); installJudgmentPort(fake.port);
  const owner = captureJudgmentPort('test.reentrant-frame'); mutate = true;
  expect(() => owner.consumeObservation()).toThrow('no longer current');
});
