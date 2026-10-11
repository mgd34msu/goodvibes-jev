import { afterEach, beforeEach, expect, test } from 'bun:test';
import { captureJudgmentPort, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { noul, SqliteDecisionLog, withDecisionLog, type JudgmentPort, type JudgmentRetryProgress } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

const request = { state: { synthetic: true }, questions: { yes: noul('Synthetic question?') } };
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

test('request-only cancellation fences later battery attachments', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(withDecisionLog(fake.port, log));
  const source = captureJudgmentPort('test.scoped'); const abort = new AbortController();
  const result = await source.port.ask({ ...request, signal: abort.signal });
  expect(result.decisionId).toBeDefined();
  abort.abort(new Error('synthetic-private-reason'));
  expect(() => source.port.recorder!.recordReadings(result.decisionId!, { yes: true })).toThrow('no longer current');
  expect(() => source.port.recorder!.recordAction(result.decisionId!, 'publish')).toThrow('no longer current');
  expect(log.query()).toMatchObject([{ status: 'answered', notes: [] }]);
  expect(() => source.assertCurrent()).not.toThrow();
  await source.port.ask(request); expect(log.query()).toHaveLength(2);
});

test('a request getter cannot revoke and then start the borrowed port', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort(withDecisionLog(fake.port, log));
  const source = captureJudgmentPort('test.scoped');
  await expect(source.port.ask({ questions: request.questions, get state() {
    installJudgmentPort(undefined); return { synthetic: true };
  } })).rejects.toMatchObject({ name: 'JudgmentAuthorityRetiredError' });
  expect(fake.requests).toHaveLength(0); expect(log.query()).toHaveLength(0);
});

test('late progress callbacks never publish after source retirement', async () => {
  const fake = fakePort(() => noulAnswer(0.99));
  let report: ((progress: JudgmentRetryProgress) => void) | undefined;
  const base: JudgmentPort = { ...fake.port, async ask(input) { report = input.onRetry; return fake.port.ask(input); } };
  installJudgmentPort(base);
  const source = captureJudgmentPort('test.scoped'); let reports = 0;
  await source.port.ask({ ...request, onRetry: () => { reports++; } });
  installJudgmentPort(undefined);
  expect(() => report!({ logicalRequestId: 'synthetic', elapsedMs: 1, nextDelayMs: 1, attempt: {
    attempt: 1, endpointIndex: 0, endpointKind: 'hosted', requestedModel: 'synthetic', latencyMs: 1, outcome: 'unavailable',
  } })).toThrow('no longer current');
  expect(reports).toBe(0);
});

test('a result accessor cannot retire the source and then publish success', async () => {
  const fake = fakePort(() => noulAnswer(0.99));
  const base: JudgmentPort = { ...fake.port, async ask(input) {
    const result = await fake.port.ask(input);
    return { ...result, get decisionId() { installJudgmentPort(undefined); return 'synthetic-id'; } };
  } };
  installJudgmentPort(base);
  await expect(captureJudgmentPort('test.scoped').port.ask(request)).rejects.toMatchObject({ name: 'JudgmentAuthorityRetiredError' });
});

test('changing callback getters cannot replace the admitted callbacks during request copy', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); let escaped = 0; let accesses = 0;
  const base: JudgmentPort = { ...fake.port, async ask(input) {
    await input.beforeAsyncAttempt?.();
    return fake.port.ask(input);
  } };
  installJudgmentPort(base);
  const input = { ...request };
  Object.defineProperty(input, 'beforeAsyncAttempt', { enumerable: true, get() {
    accesses++; return accesses === 1 ? undefined : () => { escaped++; };
  } });
  await captureJudgmentPort('test.scoped').port.ask(input);
  expect(accesses).toBe(2); expect(escaped).toBe(0); expect(fake.requests).toHaveLength(1);
});
