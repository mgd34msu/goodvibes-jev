import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ProtectedSourceOwner, SourceScreeningHold } from '@goodvibes-jev/engine/sdk/platform/security';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { rankHarnessCatalog } from '../../tools/agent-harness-catalog-ranking.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

const reasons = ['route-unavailable', 'protected-input', 'malformed', 'unsettled', 'cancelled', 'stale', 'capacity', 'busy'] satisfies SourceScreeningHold[];
const candidate = { id: 'ordinary-candidate', description: 'An ordinary build note.' };
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
afterAll(cleanupResearchScreeningFixtures);

function read(owner: ProtectedSourceOwner, signal?: AbortSignal) {
  return rankHarnessCatalog([candidate], 'build notes', entry => entry, 'agent.screening-error-control', {
    sourceOwner: owner, requirePreservedSource: true, signal,
  });
}

async function refused(owner: ProtectedSourceOwner, signal?: AbortSignal) {
  try { await read(owner, signal); }
  catch (error) {
    if (!(error instanceof ToolInputProjectionError)) throw error;
    expect(error.name).toBe('ToolInputProjectionError');
    expect(error.message).toBe('Tool input projection held.');
    expect(error.problem).toBe('held');
    expect(error.constructor).toBe(ToolInputProjectionError);
    return error;
  }
  throw new Error('An unaccepted source result was published');
}

// Authored protocol refusals test the result boundary. The native owner and
// its receipt bindings are unchanged; genuine privacy controls below use it directly.
function authoredResult(value: unknown) {
  const native = researchScreeningFixture(), originalScreen = native.owner.screen;
  const owner = { ...native.owner };
  Object.defineProperty(owner, 'screen', { value: () => Promise.resolve(value) });
  return { native, owner, originalScreen };
}

for (const reason of reasons) {
  test(`catalog preserves only the finite source hold ${reason}`, async () => {
    const f = authoredResult(Object.freeze({ status: 'held', reason })), fake = fakePort(() => noulAnswer(0.999));
    installJudgmentPort(fake.port);
    const error = await refused(f.owner), descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    expect(descriptor).toMatchObject({ enumerable: false, configurable: false, writable: false });
    const cause: unknown = descriptor?.value;
    expect(cause).toEqual({ code: 'source-screening-held', reason });
    expect(Object.isFrozen(cause)).toBe(true);
    expect(fake.requests).toHaveLength(0); expect(f.native.calls).toHaveLength(0);
    expect(f.native.owner.screen).toBe(f.originalScreen);
    expect(Object.keys(error).sort()).toEqual(['name', 'problem']);
  });
}

test('unknown, private, coercible and proxy reasons remain value-free holds', async () => {
  let callbacks = 0;
  const hostile = { toString() { callbacks++; return 'synthetic-private-reason'; }, toJSON() { callbacks++; return 'synthetic-private-reason'; } };
  const proxy = new Proxy({}, { get() { callbacks++; throw new Error('synthetic-private-reason'); }, getPrototypeOf() { callbacks++; throw new Error('synthetic-private-reason'); } });
  for (const reason of ['synthetic-private-reason', 'toString', '__proto__', 42, null, undefined, hostile, proxy]) {
    const f = authoredResult({ status: 'held', reason }), fake = fakePort(() => noulAnswer(0.999));
    installJudgmentPort(fake.port);
    const error = await refused(f.owner);
    expect(Object.hasOwn(error, 'cause')).toBe(false);
    expect(JSON.stringify(error)).not.toContain('synthetic-private-reason');
    expect(fake.requests).toHaveLength(0); expect(f.native.calls).toHaveLength(0);
  }
  expect(callbacks).toBe(0);
});

test('result accessors and proxies hold before any getter, trap or canonical call', async () => {
  let callbacks = 0;
  const accessor = () => { callbacks++; throw new Error('synthetic-private-result'); };
  // Promise assimilation looks up then before the consumer receives a result.
  // Keep that lookup ordinary; every descriptor/prototype trap remains hostile.
  const proxy = new Proxy({}, { getPrototypeOf: accessor, ownKeys: accessor, getOwnPropertyDescriptor: accessor });
  const receiptProxy = new Proxy({}, { get: accessor, getPrototypeOf: accessor, ownKeys: accessor, getOwnPropertyDescriptor: accessor });
  const inherited: unknown = Object.create({ status: 'held', reason: 'unsettled' });
  for (const value of [
    Object.defineProperty({ status: 'held' }, 'reason', { get: accessor }),
    Object.defineProperty({ reason: 'unsettled' }, 'status', { get: accessor }),
    Object.defineProperty({ status: 'settled' }, 'receipt', { get: accessor }),
    { status: 'held', reason: 'unsettled', private: 'synthetic-private-result' },
    { status: 'settled', receipt: null }, { status: 'settled', receipt: accessor },
    { status: 'settled', receipt: receiptProxy }, { status: 'unexpected', reason: 'unsettled' },
    inherited, proxy, null, 42,
  ]) {
    const f = authoredResult(value), fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
    const error = await refused(f.owner);
    expect(Object.hasOwn(error, 'cause')).toBe(false);
    expect(JSON.stringify(error)).not.toContain('synthetic-private-result');
    expect(fake.requests).toHaveLength(0); expect(f.native.calls).toHaveLength(0);
  }
  expect(callbacks).toBe(0);
});

test('actual local uncertainty preserves unsettled before canonical consumption', async () => {
  const native = researchScreeningFixture({ complete: 0.5 }), fake = fakePort(() => noulAnswer(0.999));
  installJudgmentPort(fake.port);
  const originalScreen = native.owner.screen, error = await refused(native.owner);
  expect(Object.getOwnPropertyDescriptor(error, 'cause')?.value).toEqual({ code: 'source-screening-held', reason: 'unsettled' });
  expect(native.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
  expect(fake.requests).toHaveLength(0); expect(native.owner.screen).toBe(originalScreen);
});

test('explicit cancellation stops a pending proposal before canonical consumption', async () => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const native = researchScreeningFixture({ beforeProposal: async () => { entered.resolve(); await gate.promise; } });
  const fake = fakePort(() => noulAnswer(0.999)); installJudgmentPort(fake.port);
  const controller = new AbortController();
  const pending = read(native.owner, controller.signal).catch((error: unknown) => error); await entered.promise;
  controller.abort();
  try {
    const error = await pending;
    expect(error).toBe(controller.signal.reason);
    expect(native.calls.map(call => call.path)).toEqual(['/v1/chat/completions']);
    expect(fake.requests).toHaveLength(0);
  } finally { gate.resolve(); }
}, 60_000);

test('a genuine settled native receipt still permits the single original canonical consumption', async () => {
  const native = researchScreeningFixture(), originalScreen = native.owner.screen, fake = fakePort(() => noulAnswer(0.999));
  installJudgmentPort(fake.port);
  const result = await read(native.owner);
  expect(result.matches).toHaveLength(1); expect(result.matches[0]?.entry).toEqual(candidate);
  expect(result.matches[0]?.judgment.reading).toMatchObject({ verdict: 'yes', outcome: 'act' });
  expect(fake.requests).toHaveLength(1);
  expect(native.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
  expect(native.owner.screen).toBe(originalScreen);
});
