import { describe, expect, test } from 'bun:test';
import {
  buildChildFailureEnvelope,
  classifyChildFailureReason,
  describeChildPhase,
  isChildFailureTerminal,
} from '../sdk/src/platform/tools/agent/child-failure-envelope.js';
import type { AgentRecord } from '../sdk/src/platform/tools/agent/manager.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

// Free-text errors are read by engine.tools.child-failure-reason; these fakes
// stand in for Jev. Wording no entry names reads as `error`.
const failureReadings = useToolReadings([
  ['rate limit exceeded', { childFailure: 'api_error' }],
  ['API error: status 500', { childFailure: 'api_error' }],
  ['workstream budget exhausted', { childFailure: 'budget_exhausted' }],
  ['went silent', { childFailure: 'watchdog_timeout' }],
]);

function makeRecord(over: Partial<AgentRecord>): AgentRecord {
  return {
    id: 'agent-1',
    task: 'do the thing',
    template: 'engineer',
    tools: [],
    status: 'failed',
    startedAt: 0,
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...over,
  } as AgentRecord;
}

describe('child-failure reason classification', () => {
  test('a reason code stamped at the source decides in code, without a reading', async () => {
    expect(await classifyChildFailureReason(makeRecord({ error: 'Exceeded maximum turn limit (50)', failureReason: 'max_turns' }))).toBe('max_turns');
    expect(await classifyChildFailureReason(makeRecord({ error: 'Circuit breaker tripped after 10 consecutive all-error turns', failureReason: 'circuit_breaker' }))).toBe('circuit_breaker');
    expect(await classifyChildFailureReason(makeRecord({ error: 'Agent went silent for 120s (timeout: 60s)', failureReason: 'watchdog_timeout' }))).toBe('watchdog_timeout');
    expect(await classifyChildFailureReason(makeRecord({ error: 'workstream budget exhausted', failureReason: 'budget_exhausted' }))).toBe('budget_exhausted');
    expect(await classifyChildFailureReason(makeRecord({ status: 'cancelled', terminationKind: 'kill' }))).toBe('killed');
    expect(await classifyChildFailureReason(makeRecord({ status: 'cancelled', terminationKind: 'interrupt' }))).toBe('interrupted');
    expect(await classifyChildFailureReason(makeRecord({}))).toBe('error');
    expect(failureReadings.requests).toHaveLength(0);
  });

  test('a free-text error is read over the closed set of reason codes', async () => {
    expect(await classifyChildFailureReason(makeRecord({ error: 'rate limit exceeded' }))).toBe('api_error');
    expect(await classifyChildFailureReason(makeRecord({ error: 'workstream budget exhausted: 10 of 10' }))).toBe('budget_exhausted');
    expect(await classifyChildFailureReason(makeRecord({ error: 'Agent went silent for 90s' }))).toBe('watchdog_timeout');
    expect(await classifyChildFailureReason(makeRecord({ error: 'something odd' }))).toBe('error');
    // An unrecognised failureReason is not a stamped code, so the text is read.
    expect(await classifyChildFailureReason(makeRecord({ error: 'rate limit exceeded', failureReason: 'other' }))).toBe('api_error');
    expect(failureReadings.requests.length).toBeGreaterThan(0);
  });
});

describe('isChildFailureTerminal', () => {
  test('only failed/cancelled are terminal failures', () => {
    expect(isChildFailureTerminal(makeRecord({ status: 'failed' }))).toBe(true);
    expect(isChildFailureTerminal(makeRecord({ status: 'cancelled' }))).toBe(true);
    expect(isChildFailureTerminal(makeRecord({ status: 'running' }))).toBe(false);
    expect(isChildFailureTerminal(makeRecord({ status: 'completed' }))).toBe(false);
  });
});

describe('describeChildPhase', () => {
  test('is honest and derived from the record', () => {
    expect(describeChildPhase(makeRecord({ status: 'pending' }))).toBe('spawning');
    expect(describeChildPhase(makeRecord({ contractRole: 'unit' }))).toBe('contract:unit');
    expect(describeChildPhase(makeRecord({ progress: 'Turn 3 · Thinking…' }))).toBe('Turn 3 · Thinking…');
  });
});

describe('buildChildFailureEnvelope', () => {
  test('carries agentId, phase, reason, and genuine partial outputs', async () => {
    const record = makeRecord({
      id: 'agent-42',
      status: 'failed',
      error: 'Agent went silent for 120s (timeout: 60s)',
      failureReason: 'watchdog_timeout',
      progress: 'Turn 4 · Running tests',
      fullOutput: 'I edited three files and started the test run.',
      usage: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        llmCallCount: 4, turnCount: 4, reasoningSummaryCount: 0,
      },
    });
    const envelope = await buildChildFailureEnvelope(record, {
      transcriptTail: [
        { role: 'user', content: 'run the tests' },
        { role: 'assistant', content: 'running now' },
        { role: 'tool', callId: 'c1', toolName: 'exec', content: 'started' },
      ],
    });
    expect(envelope.agentId).toBe('agent-42');
    expect(envelope.phase).toBe('Turn 4 · Running tests');
    expect(envelope.reason.code).toBe('watchdog_timeout');
    expect(envelope.reason.message).toContain('went silent');
    expect(envelope.partialOutputs.lastOutput).toContain('three files');
    expect(envelope.partialOutputs.turnsCompleted).toBe(4);
    expect(envelope.partialOutputs.transcriptTail).toEqual([
      'user: run the tests',
      'assistant: running now',
      'tool(exec): started',
    ]);
    expect(envelope.partialOutputs.note).toBeUndefined();
  });

  test('does not fabricate output when the child produced nothing', async () => {
    const record = makeRecord({ status: 'failed', error: 'API error: status 500' });
    const envelope = await buildChildFailureEnvelope(record);
    expect(envelope.reason.code).toBe('api_error');
    expect(envelope.partialOutputs.lastOutput).toBeUndefined();
    expect(envelope.partialOutputs.transcriptTail).toBeUndefined();
    expect(envelope.partialOutputs.note).toContain('no committed output');
  });

  test('does not echo the failure message as if it were genuine output', async () => {
    const record = makeRecord({ status: 'failed', error: 'chain failed: X', fullOutput: 'chain failed: X' });
    const envelope = await buildChildFailureEnvelope(record);
    expect(envelope.partialOutputs.lastOutput).toBeUndefined();
    expect(envelope.partialOutputs.note).toContain('no committed output');
  });
});
