/**
 * The remote-access reconnect loop stops at a failure that cannot clear.
 *
 * `reconnect` kept looping after `_attemptConnect` had already reported a
 * non-retryable failure as terminal, so it retried every remaining attempt
 * and then reported the terminal failure a second time. And a failure the
 * adapter could not categorise (`unknown`) was never retried whatever it
 * said; it is now read through the engine's failure reading.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ReconnectEngine, type ConnectOutcome, type TransportAdapter } from '../sdk/src/platform/runtime/remote/reconnect.js';
import { authoredErrorReadingsPort, errorText, type AuthoredPrivacy } from './_helpers/authored-error-readings.js';

const FAST = { maxAttempts: 4, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitter: 0 };
const IDENTITY = { sessionId: 's1', clientId: 'c1' } as never;

function engineFailingWith(outcomes: readonly ConnectOutcome[]) {
  let calls = 0;
  const terminal: string[] = [];
  const adapter: TransportAdapter = {
    connect: async () => outcomes[Math.min(calls++, outcomes.length - 1)]!,
    disconnect: async () => {},
    requestReplay: async () => {},
  };
  const engine = new ReconnectEngine(adapter, IDENTITY, undefined, {
    onConnected: () => {},
    onTerminalFailure: (error) => { terminal.push(error); },
  }, FAST);
  return { engine, terminal, calls: () => calls };
}

const failure = (category: string, error: string, retryable = true): ConnectOutcome =>
  ({ success: false, category, error, retryable }) as ConnectOutcome;

describe('a failure that cannot clear ends the reconnect loop', () => {
  test('a non-retryable failure is tried once and reported once', async () => {
    const run = engineFailingWith([failure('authentication', '401 Unauthorized', false)]);
    expect(await run.engine.reconnect(async () => 'token')).toBe(false);
    expect(run.calls()).toBe(1);
    expect(run.terminal).toEqual(['401 Unauthorized']);
  });

  test('a category outside the retry policy is tried once and reported once', async () => {
    const run = engineFailingWith([failure('client', 'bad request')]);
    expect(await run.engine.reconnect(async () => 'token')).toBe(false);
    expect(run.calls()).toBe(1);
    expect(run.terminal).toHaveLength(1);
  });

  test('a retryable failure is retried up to the policy and reported once at the end', async () => {
    const run = engineFailingWith([failure('network', 'connection refused')]);
    expect(await run.engine.reconnect(async () => 'token')).toBe(false);
    expect(run.calls()).toBe(4);
    expect(run.terminal).toHaveLength(1);
  });
});

describe('an uncategorised failure is read, not assumed', () => {
  const privacy: AuthoredPrivacy = {
    parts: [[errorText('socket hang up')], [errorText('invalid pairing token')]],
    fields: { attempt: 'other', maxAttempts: 'other', delayMs: 'other', error: 'content',
      category: 'other', retryable: 'other', isReconnect: 'other', sessionId: 'other',
      epoch: 'other', lastAckedOffset: 'other' },
  };
  const failures = [
    { message: 'socket hang up', reading: { category: 'network', transientNetwork: true } },
    { message: 'invalid pairing token', reading: { category: 'authentication' } },
  ] as const;
  let readings = authoredErrorReadingsPort(privacy, failures);
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    forgetFailureReadings();
    readings = authoredErrorReadingsPort(privacy, failures);
    previous = installJudgmentPort(readings.port);
  });
  afterEach(() => {
    installJudgmentPort(previous);
    forgetFailureReadings();
  });

  function expectOneFailureReading(message: string) {
    const requests = readings.requests.filter((request) => request.context?.battery === 'engine.failure-reading');
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error('Expected the actual reconnect failure reading');
    expect(request.state).toBe(`Message: ${message}`);
    expect(request.context).toEqual({ battery: 'engine.failure-reading', batteryVersion: 2,
      pattern: 'battery', site: 'remote.reconnect.failure' });
    expect(Object.keys(request.questions).sort()).toEqual(['before_response', 'billing', 'category',
      'connection_failure', 'context_exceeded', 'provider_unusable', 'rate_limited', 'transient_network']);
  }

  test('wording read as a dropped connection is retried', async () => {
    const run = engineFailingWith([failure('unknown', 'socket hang up'), failure('unknown', 'socket hang up'), { success: true, token: {} as never, epoch: 1, replayFromOffset: 0, negotiatedProtocol: {} as never }]);
    expect(await run.engine.reconnect(async () => 'token')).toBe(true);
    expect(run.calls()).toBe(3);
    expectOneFailureReading('socket hang up');
  });

  test('wording read as rejected credentials ends the loop', async () => {
    const run = engineFailingWith([failure('unknown', 'invalid pairing token')]);
    expect(await run.engine.reconnect(async () => 'token')).toBe(false);
    expect(run.calls()).toBe(1);
    expect(run.terminal).toEqual(['invalid pairing token']);
    expectOneFailureReading('invalid pairing token');
  });
});
