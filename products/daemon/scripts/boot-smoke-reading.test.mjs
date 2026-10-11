import { expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { nativeAddonFailure, readNativeAddonEvidence } from './boot-smoke-reading.mjs';

test('compiled diagnostic acceptance consumes the Jev reading rather than error-word matching', async () => {
  const evidence = { stderr: 'sqlite-vec initialized with no errors' };
  const fixture = fakePort(() => noulAnswer(0.01));
  expect(await readNativeAddonEvidence(fixture.port, evidence)).toMatchObject({ verdict: 'no', model: 'jev-1.13.0' });
  expect(fixture.requests[0].state).toEqual(evidence);
  expect(fixture.requests[0].context.site).toBe('daemon.boot-smoke.native-addon-failure');
});
test.each([0.99, 0.5])('addon failure or uncertainty refuses qualification (%s)', async probability => {
  const fixture = fakePort(() => noulAnswer(probability));
  await expect(readNativeAddonEvidence(fixture.port, { stderr: 'synthetic diagnostic' })).rejects.toThrow('failure or remain uncertain');
});
test('oversized evidence refuses without concealing the tail', async () => {
  const fixture = fakePort(() => noulAnswer(0.01));
  await expect(readNativeAddonEvidence(fixture.port, { stderr: 'x'.repeat(48_001) })).rejects.toThrow('budget');
  expect(fixture.requests).toHaveLength(0);
});
test('the semantic battery has opposing calibration fixtures, not a claimed live result', () => {
  expect(nativeAddonFailure.fixtures.map(f => f.expect.native_addon_failure)).toEqual(['no', 'yes', 'no', 'yes']);
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
