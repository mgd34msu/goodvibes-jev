/**
 * forensics-classifier.test.ts
 *
 * classifyFailure's ladder: the structural rungs are code and need no
 * judgment port; the error-message rung reads the wording through the shared
 * failure reading (engine.failure-reading) and maps its category onto
 * turn_timeout or llm_error, falling through when the category says neither.
 * The collector publishes the read classification, and publishes no report
 * when the message cannot be read.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetFailureReadings, installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { classifyFailure, summariseFailure } from '../sdk/src/platform/runtime/forensics/classifier.ts';
import { RuntimeEventBus, createEventEnvelope, ForensicsCollector, ForensicsRegistry } from './_helpers/runtime-seam.ts';
import type { TurnEvent } from './_helpers/runtime-seam.ts';
import { useFailureReadings } from './_helpers/failure-readings.ts';

describe('structural rungs need no reading', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => {
    forgetFailureReadings();
    previous = installJudgmentPort(undefined);
  });
  afterEach(() => {
    installJudgmentPort(previous);
  });

  test('each flag or stop reason decides before the message is read', async () => {
    const message = 'Request timed out after 60000ms';
    expect(await classifyFailure({ wasCancelled: true, errorMessage: message })).toBe('cancelled');
    expect(await classifyFailure({ stopReason: 'max_tokens', errorMessage: message })).toBe('max_tokens');
    expect(await classifyFailure({ stopReason: 'context_overflow' })).toBe('max_tokens');
    expect(await classifyFailure({ hasCompactionError: true, errorMessage: message })).toBe('compaction_error');
    expect(await classifyFailure({ stopReason: 'hook_denied', errorMessage: message })).toBe('permission_denied');
    expect(await classifyFailure({ hasToolFailure: true, errorMessage: message })).toBe('tool_failure');
    expect(await classifyFailure({ hasCascadeEvents: true, errorMessage: message })).toBe('cascade_failure');
  });

  test('an error stop reason with no message is an LLM error', async () => {
    expect(await classifyFailure({ stopReason: 'provider_exhausted' })).toBe('llm_error');
  });

  test('an error message with no judgment port installed throws', async () => {
    await expect(classifyFailure({ errorMessage: 'Request timed out after 60000ms' })).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('the error-message rung', () => {
  const log = useFailureReadings([
    ['timed out', { category: 'timeout', transientNetwork: true }],
    ['Rate limit reached', { category: 'rate_limit', rateLimited: true }],
    ['Overloaded', { category: 'service' }],
    ['fetch failed', { category: 'network', transientNetwork: true, beforeResponse: true }],
    ['Incorrect API key', { category: 'authentication', providerUnusable: true }],
    ['credit balance is too low', { category: 'billing', billing: true }],
    ['Unsupported parameter', { category: 'bad_request' }],
  ]);

  test('a timeout reads as a turn timeout', async () => {
    expect(await classifyFailure({ errorMessage: 'Request timed out after 60000ms' })).toBe('turn_timeout');
  });

  test('provider, transport and account failures read as LLM errors', async () => {
    for (const message of [
      'Rate limit reached for requests per minute.',
      'Overloaded',
      'TypeError: fetch failed',
      'Incorrect API key provided: sk-...abcd.',
      'Your credit balance is too low to access the API.',
    ]) {
      expect(await classifyFailure({ errorMessage: message })).toBe('llm_error');
    }
  });

  test('a category that says neither falls through to the stop-reason rungs', async () => {
    expect(await classifyFailure({ errorMessage: "Unsupported parameter: 'max_tokens'" })).toBe('unknown');
    expect(await classifyFailure({ errorMessage: 'File not writable: /etc/hosts', stopReason: 'provider_error' })).toBe('llm_error');
    expect(await classifyFailure({ errorMessage: 'File not writable: /etc/hosts' })).toBe('unknown');
  });

  test('one wording is read once however often it is classified', async () => {
    await classifyFailure({ errorMessage: 'Overloaded' });
    await classifyFailure({ errorMessage: 'Overloaded', stopReason: 'error' });
    expect(log.requests).toHaveLength(1);
  });

  test('the summary for a read class is unchanged', async () => {
    const message = 'Rate limit reached for requests per minute.';
    const cls = await classifyFailure({ errorMessage: message });
    expect(summariseFailure(cls, message)).toBe(`LLM API error: ${message}`);
  });
});

async function emitTurn(bus: RuntimeEventBus, payload: Record<string, unknown>): Promise<void> {
  bus.emit('turn', createEventEnvelope(payload['type'] as TurnEvent['type'], payload as TurnEvent, { sessionId: 's', source: 'test', traceId: 'trace-classifier-0001' }));
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the collector', () => {
  describe('with a reading', () => {
    useFailureReadings([['timed out', { category: 'timeout' }]]);

    test('a turn error is reported with the class its message reads as', async () => {
      const bus = new RuntimeEventBus();
      const registry = new ForensicsRegistry();
      const collector = new ForensicsCollector(bus, registry);
      await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't1', prompt: 'hi' });
      await emitTurn(bus, { type: 'TURN_ERROR', turnId: 't1', error: 'Request timed out after 60000ms' });
      expect(registry.latest()?.classification).toBe('turn_timeout');
      expect(registry.latest()?.summary).toBe('Turn exceeded configured timeout');
      collector.dispose();
    });
  });

  describe('without a judgment port', () => {
    let previous: ReturnType<typeof installJudgmentPort>;
    beforeEach(() => {
      forgetFailureReadings();
      previous = installJudgmentPort(undefined);
    });
    afterEach(() => {
      installJudgmentPort(previous);
    });

    test('a failure whose message or phases cannot be read gets no report', async () => {
      const bus = new RuntimeEventBus();
      const registry = new ForensicsRegistry();
      const collector = new ForensicsCollector(bus, registry);
      await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't2', prompt: 'hi' });
      await emitTurn(bus, { type: 'TURN_ERROR', turnId: 't2', error: 'Request timed out after 60000ms' });
      expect(registry.count()).toBe(0);
      // A cancellation needs no message reading, but its timed phases are read
      // for slowness, and with no port that reading cannot be taken either.
      await emitTurn(bus, { type: 'TURN_SUBMITTED', turnId: 't3', prompt: 'hi' });
      await emitTurn(bus, { type: 'TURN_CANCEL', turnId: 't3', reason: 'user pressed escape' });
      expect(registry.count()).toBe(0);
      collector.dispose();
    });
  });
});
