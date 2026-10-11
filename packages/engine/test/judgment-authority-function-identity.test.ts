import { afterEach, beforeEach, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, captureJudgmentPort, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { noul, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
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

for (const key of ['model', 'ask', 'health', 'recorder', 'recordReadings', 'recordAction', 'identity', 'signal', 'assertCurrent'] as const)
  test(`canonical capture rejects a late ${key} accessor before executing it`, async () => {
    const fake = fakePort(() => noulAnswer(0.99)); let touched = 0, recorded = 0;
    const recorder = { recordReadings() { recorded++; }, recordAction() { recorded++; } };
    const port = { ...fake.port, recorder };
    const frame = { identity: {}, signal: new AbortController().signal, assertCurrent() {} };
    bindJudgmentPortAuthority(port, () => frame); installJudgmentPort(port);
    const owner = captureJudgmentPort('test.late-accessor');
    const target = key === 'recordReadings' || key === 'recordAction' ? recorder
      : key === 'identity' || key === 'signal' || key === 'assertCurrent' ? frame : port;
    Object.defineProperty(target, key, { configurable: true, get() { touched++; return undefined; } });
    await expect(owner.port.ask(request)).rejects.toThrow('no longer current');
    expect(() => owner.port.recorder?.recordAction('synthetic', 'act')).toThrow('no longer current');
    expect(fake.requests).toHaveLength(0); expect(recorded).toBe(0); expect(touched).toBe(0);
  });

for (const target of ['port', 'recorder', 'prototype', 'attributes'] as const)
  test(`consumed canonical restriction rejects changed ${target} ownership before access`, () => {
    const fake = fakePort(() => noulAnswer(0.99)); let touched = 0;
    const recorder = { recordReadings() {}, recordAction() {} }, port = { ...fake.port, recorder };
    installJudgmentPort(port);
    const restriction = captureJudgmentPort('test.consumed-accessor').consumeObservation();
    if (target === 'port') Object.defineProperty(port, 'model', { get() { touched++; return fake.port.model; } });
    if (target === 'recorder') Object.defineProperty(recorder, 'recordAction', { get() { touched++; return () => {}; } });
    if (target === 'prototype') Object.setPrototypeOf(port, { get model() { touched++; return fake.port.model; } });
    if (target === 'attributes') Object.defineProperty(port, 'model', { enumerable: false });
    expect(() => restriction.assertCurrent()).toThrow('no longer current'); expect(touched).toBe(0);
  });

test('original port getter retains its receiver and cannot replace the next sibling during acquisition', () => {
  const fake = fakePort(() => noulAnswer(0.99)); let originalReads = 0, replacementReads = 0;
  const port = { get model() {
    expect(this).toBe(port); originalReads++;
    Object.defineProperty(this, 'ask', { configurable: true, get() { replacementReads++; return fake.port.ask; } });
    return fake.port.model;
  }, ask: fake.port.ask };
  installJudgmentPort(port);
  expect(() => captureJudgmentPort('test.original-getter')).toThrow('no longer current');
  expect(originalReads).toBe(1); expect(replacementReads).toBe(0); expect(fake.requests).toHaveLength(0);
});

test('original recorder getter cannot replace its next sibling before acquisition', () => {
  const fake = fakePort(() => noulAnswer(0.99)); let originalReads = 0, replacementReads = 0;
  const recorder = { get recordReadings() {
    expect(this).toBe(recorder); originalReads++;
    Object.defineProperty(this, 'recordAction', { configurable: true, get() { replacementReads++; return () => {}; } });
    return () => {};
  }, recordAction() {} };
  installJudgmentPort({ ...fake.port, recorder });
  expect(() => captureJudgmentPort('test.original-recorder-getter')).toThrow('no longer current');
  expect(originalReads).toBe(1); expect(replacementReads).toBe(0); expect(fake.requests).toHaveLength(0);
});

test('an original port getter cannot replace a recorder sibling during a retained check', () => {
  const fake = fakePort(() => noulAnswer(0.99)); let mutate = false, touched = 0;
  const recorder = { recordReadings() {}, recordAction() {} };
  const port = { get model() {
    expect(this).toBe(port);
    if (mutate) Object.defineProperty(recorder, 'recordAction', { configurable: true, get() { touched++; return () => {}; } });
    return fake.port.model;
  }, ask: fake.port.ask, recorder };
  installJudgmentPort(port); const owner = captureJudgmentPort('test.retained-original-getter'); mutate = true;
  expect(() => owner.consumeObservation()).toThrow('no longer current'); expect(touched).toBe(0);
});

test('native recording port original model getter remains usable through reading and consumption', async () => {
  const fake = fakePort(() => noulAnswer(0.99));
  using log = new SqliteDecisionLog(':memory:');
  installJudgmentPort(withDecisionLog(fake.port, log));
  const owner = captureJudgmentPort('test.native-recording-getter'), answer = await owner.port.ask(request);
  expect(answer.decisionId).toBeDefined(); expect(fake.requests).toHaveLength(1);
  if (answer.decisionId === undefined) throw new Error('Native recording fixture did not record its reading');
  owner.port.recorder?.recordReadings(answer.decisionId, {});
  owner.port.recorder?.recordAction(answer.decisionId, 'synthetic retained reading');
  const restriction = owner.consumeObservation(); expect(() => restriction.assertCurrent()).not.toThrow();
  expect(() => owner.assertCurrent()).toThrow('no longer current');
});

for (const field of ['model', 'recordAction'] as const)
  for (const retirement of ['installation', 'binding', 'source', 'caller'] as const)
    for (const consumed of [false, true])
      test(`original ${field} getter ${retirement} retirement is fenced during ${consumed ? 'consumed restriction' : 'observation'}`, () => {
        const fake = fakePort(() => noulAnswer(0.99)), source = new AbortController(), caller = new AbortController();
        let armed = false, siblingReads = 0, sourceChecks = 0;
        const frame = { identity: {}, signal: source.signal, assertCurrent() { sourceChecks++; } };
        const action = () => {};
        const retire = () => {
          if (!armed) return;
          if (retirement === 'installation') installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
          if (retirement === 'binding') bindJudgmentPortAuthority(port, () => frame);
          if (retirement === 'source') source.abort();
          if (retirement === 'caller') caller.abort();
        };
        const recorder = { recordReadings() {}, get recordAction() { if (field === 'recordAction') retire(); return action; } };
        const port = { get model() { if (field === 'model') retire(); return fake.port.model; },
          get ask() { siblingReads++; return fake.port.ask; }, recorder };
        bindJudgmentPortAuthority(port, () => frame); installJudgmentPort(port);
        const owner = captureJudgmentPort('test.original-getter-retirement', { signal: caller.signal });
        const check = consumed ? owner.consumeObservation().assertCurrent : owner.assertCurrent;
        const beforeSiblings = siblingReads, beforeSource = sourceChecks; armed = true;
        if (consumed && (retirement === 'source' || retirement === 'caller')) expect(check).not.toThrow();
        else {
          expect(check).toThrow('no longer current');
          if (field === 'model') expect(siblingReads).toBe(beforeSiblings);
        }
        expect(sourceChecks).toBe(beforeSource); expect(fake.requests).toHaveLength(0);
      });

for (const retirement of ['consumed', 'source', 'caller'] as const)
  test(`ordinary ${retirement} observation refuses before reading original getters`, () => {
    const fake = fakePort(() => noulAnswer(0.99)), source = new AbortController(), caller = new AbortController();
    let reads = 0;
    const port = { get model() { reads++; return fake.port.model; }, ask: fake.port.ask };
    bindJudgmentPortAuthority(port, () => ({ identity: {}, signal: source.signal, assertCurrent() {} }));
    installJudgmentPort(port);
    const owner = captureJudgmentPort('test.original-getter-retired-observation', { signal: caller.signal });
    if (retirement === 'consumed') owner.consumeObservation();
    if (retirement === 'source') source.abort();
    if (retirement === 'caller') caller.abort();
    const before = reads;
    expect(() => owner.assertCurrent()).toThrow('no longer current');
    expect(reads).toBe(before); expect(fake.requests).toHaveLength(0);
  });

for (const outer of ['assertCurrent', 'consumeObservation'] as const)
  test(`the final original getter cannot consume a reading inside outer ${outer}`, () => {
    const fake = fakePort(() => noulAnswer(0.99)); let armed = false, reads = 0;
    let owner: ReturnType<typeof captureJudgmentPort> | undefined;
    let nested: ReturnType<ReturnType<typeof captureJudgmentPort>['consumeObservation']> | undefined;
    const action = () => {};
    const recorder = { recordReadings() {}, get recordAction() {
      if (armed && ++reads === 3) {
        armed = false;
        if (!owner) throw new Error('Missing acquired fixture observation');
        nested = owner.consumeObservation();
      }
      return action;
    } };
    installJudgmentPort({ ...fake.port, recorder }); owner = captureJudgmentPort('test.reentrant-consumption');
    reads = 0; armed = true;
    expect(() => owner?.[outer]()).toThrow('no longer current');
    expect(nested).toBeDefined();
    if (!nested) throw new Error('Original getter did not consume its observation');
    expect(() => nested?.assertCurrent()).not.toThrow();
    expect(() => owner?.assertCurrent()).toThrow('no longer current'); expect(fake.requests).toHaveLength(0);
  });
