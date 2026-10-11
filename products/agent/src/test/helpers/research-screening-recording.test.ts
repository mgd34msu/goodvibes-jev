import { afterEach, expect, test } from 'bun:test';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, ordinaryResearchOwner, researchScreeningFixture } from './research-screening.ts';

afterEach(cleanupResearchScreeningFixtures);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const recordingModes = [
  { label: 'default', options: {}, recorded: true },
  { label: 'enabled', options: { recordCalls: true }, recorded: true },
  { label: 'disabled', options: { recordCalls: false }, recorded: false },
];

for (const mode of recordingModes) {
  test(`${mode.label} recording preserves actual HTTP screening and the awaited proposal hook`, async () => {
    const started = deferred(), release = deferred();
    const original = 'Keep this sentence with synthetic-masked-detail and its ending.';
    let proposed: readonly string[] | undefined;
    const fixture = researchScreeningFixture({
      ...mode.options,
      spans: exactSensitiveSpans(['synthetic-masked-detail']),
      async beforeProposal(source) {
        proposed = source.parts;
        started.resolve();
        await release.promise;
      },
    });
    const source = fixture.owner.capture([original]);
    let finished = false;
    const pending = fixture.owner.screen(source).then(result => { finished = true; return result; });
    try {
      await started.promise;
      expect(proposed).toEqual([original]);
      expect(finished).toBe(false);
      expect(fixture.calls.map(call => call.path)).toEqual(mode.recorded ? ['/v1/chat/completions'] : []);
    } finally {
      release.resolve();
    }
    const result = await pending;
    expect(result.status).toBe('settled');
    if (result.status !== 'settled') throw new Error('Synthetic screening did not settle');
    expect(fixture.owner.project(result.receipt)).toEqual(['Keep this sentence with [redacted] and its ending.']);
    expect(fixture.calls.map(call => call.path)).toEqual(mode.recorded ? ['/v1/chat/completions', '/v1/systemone'] : []);
    if (mode.recorded) {
      expect(fixture.calls[0]?.body).toMatchObject({ model: 'synthetic-span-fixture' });
      expect(fixture.calls[1]?.body).toMatchObject({ model: 'jev-1.13.0', state: { parts: [original] } });
    }
    await fixture.owner.release(source);
    expect(() => fixture.owner.project(result.receipt)).toThrow();
  });
}

for (const recordCalls of [true, false]) {
  test(`recordCalls=${recordCalls} preserves an unsettled verification hold`, async () => {
    const fixture = researchScreeningFixture({ recordCalls, complete: 0.5 });
    const source = fixture.owner.capture(['Keep this ordinary sentence.']);
    expect(await fixture.owner.screen(source)).toEqual({ status: 'held', reason: 'unsettled' });
    expect(fixture.calls.map(call => call.path)).toEqual(recordCalls ? ['/v1/chat/completions', '/v1/systemone'] : []);
    await fixture.owner.release(source);
  });

  for (const credential of [false, true]) {
    test(`recordCalls=${recordCalls} preserves the actual query-role answer credential=${credential}`, async () => {
      const parameters: string[] = [];
      const fixture = researchScreeningFixture({ recordCalls, role(parameter) { parameters.push(parameter); return credential ? 1 : 0; } });
      const original = 'https://example.test/document?reference=synthetic-value#section';
      const source = fixture.owner.captureResearchReference(original);
      const result = await fixture.owner.screenResearchReference(source);
      expect(result.status).toBe('settled');
      if (result.status !== 'settled') throw new Error('Synthetic reference did not settle');
      expect(parameters).toEqual(['reference']);
      expect(fixture.owner.projectResearchReference(result.receipt)).toEqual(credential ? { status: 'omitted' } : { status: 'preserved', url: original });
      expect(fixture.calls.map(call => call.path)).toEqual(recordCalls ? ['/v1/systemone'] : []);
      if (recordCalls) expect(fixture.calls[0]?.body).toMatchObject({ model: 'jev-1.13.0', state: { parameter: 'reference' } });
      await fixture.owner.release(source);
    });
  }
}

test('unrecorded screening still refuses a revoked owner after its proposal hook', async () => {
  let current = true, proposed = 0;
  const fixture = researchScreeningFixture({ recordCalls: false,
    assertCurrent() { if (!current) throw new Error('Synthetic owner retired'); },
    async beforeProposal() { proposed++; current = false; },
  });
  const source = fixture.owner.capture(['Keep this ordinary sentence.']);
  expect(await fixture.owner.screen(source)).toEqual({ status: 'held', reason: 'stale' });
  expect(proposed).toBe(1);
  expect(fixture.calls).toEqual([]);
  await fixture.owner.release(source);
});

test('the ordinary owner screens through its real services and cleanup retires its receipts', async () => {
  const owner = ordinaryResearchOwner();
  expect(ordinaryResearchOwner()).toBe(owner);
  expect(Object.hasOwn(owner, 'calls')).toBe(false);
  const source = owner.capture(['Keep this ordinary sentence.']);
  const result = await owner.screen(source);
  expect(result.status).toBe('settled');
  if (result.status !== 'settled') throw new Error('Synthetic ordinary source did not settle');
  expect(owner.project(result.receipt)).toEqual(['Keep this ordinary sentence.']);
  await cleanupResearchScreeningFixtures();
  expect(() => owner.project(result.receipt)).toThrow();
  expect(() => owner.capture(['New source after closure.'])).toThrow();
  const replacement = ordinaryResearchOwner();
  expect(replacement).not.toBe(owner);
  const next = replacement.capture(['New ordinary source.']);
  const screened = await replacement.screen(next);
  expect(screened.status).toBe('settled');
  if (screened.status !== 'settled') throw new Error('Replacement ordinary source did not settle');
  expect(replacement.project(screened.receipt)).toEqual(['New ordinary source.']);
  await replacement.release(next);
});
