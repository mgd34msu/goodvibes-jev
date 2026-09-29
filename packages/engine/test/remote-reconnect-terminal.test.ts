/**
 * The remote-access reconnect loop stops at a failure that cannot clear.
 *
 * `reconnect` kept looping after `_attemptConnect` had already reported a
 * non-retryable failure as terminal, so it retried every remaining attempt
 * and then reported the terminal failure a second time. And a failure the
 * adapter could not categorise (`unknown`) was never retried whatever it
 * said; it is now read through the engine's failure reading.
 */
import { describe, expect, test } from 'bun:test';
import { ReconnectEngine, type ConnectOutcome, type TransportAdapter } from '../sdk/src/platform/runtime/remote/reconnect.js';
import { useFailureReadings } from './_helpers/failure-readings.js';

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
  const readings = useFailureReadings([
    ['socket hang up', { category: 'network', transientNetwork: true }],
    ['invalid pairing token', { category: 'authentication' }],
  ]);

  test('wording read as a dropped connection is retried', async () => {
    const run = engineFailingWith([failure('unknown', 'socket hang up'), failure('unknown', 'socket hang up'), { success: true, token: {} as never, epoch: 1, replayFromOffset: 0, negotiatedProtocol: {} as never }]);
    expect(await run.engine.reconnect(async () => 'token')).toBe(true);
    expect(run.calls()).toBe(3);
    expect(readings.requests).toHaveLength(1);
  });

  test('wording read as rejected credentials ends the loop', async () => {
    const run = engineFailingWith([failure('unknown', 'invalid pairing token')]);
    expect(await run.engine.reconnect(async () => 'token')).toBe(false);
    expect(run.calls()).toBe(1);
    expect(run.terminal).toEqual(['invalid pairing token']);
  });
});
