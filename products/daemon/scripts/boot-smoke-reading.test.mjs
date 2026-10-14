import { expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { nativeAddonFailure, readNativeAddonEvidence } from './boot-smoke-reading.mjs';

test('compiled diagnostic acceptance consumes the Jev reading rather than error-word matching', async () => {
  const evidence = { stderr: 'sqlite-vec initialized with no errors' };
  const fixture = fakePort(() => noulAnswer(0.01));
  expect(await readNativeAddonEvidence(fixture.port, evidence)).toMatchObject({ verdict: 'no', model: 'jev-1.13.0', requestedModel: 'jev-latest' });
  expect(fixture.requests[0].state).toEqual(evidence);
  expect(fixture.requests[0].context.site).toBe('daemon.boot-smoke.native-addon-failure');
});
test.each([0.99, 0.5, 0.42])('addon failure or uncertainty refuses qualification (%s)', async probability => {
  const fixture = fakePort(() => noulAnswer(probability));
  await expect(readNativeAddonEvidence(fixture.port, { stderr: 'synthetic diagnostic' })).rejects.toThrow('failure or remain uncertain');
});
test('oversized evidence refuses without concealing the tail', async () => {
  const fixture = fakePort(() => noulAnswer(0.01));
  await expect(readNativeAddonEvidence(fixture.port, { stderr: 'x'.repeat(48_001) })).rejects.toThrow('budget');
  expect(fixture.requests).toHaveLength(0);
});
test('the semantic battery has opposing calibration fixtures, not a claimed live result', () => {
  expect(nativeAddonFailure.fixtures.map(f => f.expect.native_addon_failure)).toEqual(['no', 'yes', 'no', 'yes', 'yes']);
});

test('unavailable vec0 cannot pass through successful memory HTTP or lexical fallback', async () => {
  const { proveNativeMemoryRoundTrip } = await import('./boot-smoke-reading.mjs');
  const calls = [];
  await expect(proveNativeMemoryRoundTrip(async method => {
    calls.push(method);
    if (method === 'memory.records.add') return { record: { id: 'synthetic' } };
    return { vector: { backend: 'sqlite-vec', enabled: true, available: false, indexedRecords: 0, error: 'synthetic native loader failure' } };
  })).rejects.toThrow();
  expect(calls).toEqual(['memory.records.add', 'memory.vector.stats']);
});


test('complete protected evidence and accessors refuse before dispatch', async () => {
  const fixture = fakePort(() => noulAnswer(0.01));
  await expect(readNativeAddonEvidence(fixture.port, { stderr: 'normal', password: 'synthetic-private-value' })).rejects.toThrow();
  let getters = 0;
  const evidence = Object.defineProperty({}, 'stderr', { get() { getters++; return 'normal'; } });
  await expect(readNativeAddonEvidence(fixture.port, evidence)).rejects.toThrow();
  expect(getters).toBe(0); expect(fixture.requests).toHaveLength(0);
});

test.each(['evidence', 'model', 'ask'])('changed native diagnostic %s cannot authorize acceptance', async field => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const fixture = fakePort(() => noulAnswer(0.01));
  const evidence = { stderr: 'sqlite-vec initialized successfully' };
  const port = { model: fixture.port.model, async ask(request) { entered.resolve(); await release.promise; return fixture.port.ask(request); } };
  const pending = readNativeAddonEvidence(port, evidence);
  await entered.promise;
  if (field === 'evidence') evidence.stderr = 'sqlite-vec failed to initialize';
  else if (field === 'model') port.model = 'other-model';
  else port.ask = fixture.port.ask;
  release.resolve();
  await expect(pending).rejects.toThrow();
});

test('abort settles a noncooperative diagnostic port without accepting a late reading', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const fixture = fakePort(() => noulAnswer(0.01));
  const controller = new AbortController();
  const port = { model: fixture.port.model, async ask(request) { entered.resolve(); await release.promise; return fixture.port.ask(request); } };
  const pending = readNativeAddonEvidence(port, { stderr: 'normal' }, controller.signal);
  await entered.promise; controller.abort(new Error('native-check-cancelled'));
  await expect(pending).rejects.toThrow('native-check-cancelled');
  release.resolve();
});

test('the native addon decision inherits the latest model without a definition pin', () => {
  expect(nativeAddonFailure.model).toBeUndefined();
});


test('private or accessor response fields refuse before decision-log attachments', async () => {
  const fixture = fakePort(() => noulAnswer(0.01));
  let getters = 0, attachments = 0;
  for (const decorate of [
    result => ({ ...result, password: 'synthetic-private-value' }),
    result => Object.defineProperty(result, 'hidden', { get() { getters++; return 'synthetic-private'; } }),
  ]) {
    const port = { model: fixture.port.model, async ask(request) { return decorate(await fixture.port.ask(request)); },
      recorder: { recordReadings() { attachments++; }, recordAction() { attachments++; } } };
    await expect(readNativeAddonEvidence(port, { stderr: 'normal' })).rejects.toThrow();
  }
  expect(getters).toBe(0); expect(attachments).toBe(0);
});
