/**
 * What a finished agent says (agents/completion-answer.ts): a completed run's
 * output; silence when there is none; for a contract unit's agent with nothing
 * to report, the line that the contract's checks follow; an error or status
 * for a run that did not complete.
 */
import { describe, expect, test } from 'bun:test';
import { CONTRACT_CHECKS_FOLLOW, renderAgentCompletionAnswer } from '../sdk/src/platform/agents/completion-answer.js';

describe('renderAgentCompletionAnswer', () => {
  test('a completed run says its output, then its streamed content', () => {
    expect(renderAgentCompletionAnswer({ status: 'completed', fullOutput: ' The answer. ' })).toBe('The answer.');
    expect(renderAgentCompletionAnswer({ status: 'completed', streamingContent: 'Streamed.' })).toBe('Streamed.');
  });

  test('nothing produced is silence, except a contract unit agent whose contract still checks the work', () => {
    expect(renderAgentCompletionAnswer({ status: 'completed', fullOutput: '' })).toBe('');
    expect(renderAgentCompletionAnswer({ status: 'completed', contractId: 'ctr-1a2b3c4d', contractRole: 'unit' })).toBe(CONTRACT_CHECKS_FOLLOW);
    expect(renderAgentCompletionAnswer({ status: 'completed', contractId: 'ctr-1a2b3c4d', contractRole: 'owner' })).toBe('');
  });

  test('a run that did not complete says its error, else its status', () => {
    expect(renderAgentCompletionAnswer({ status: 'failed', error: 'provider unavailable' })).toBe('provider unavailable');
    expect(renderAgentCompletionAnswer({ status: 'cancelled' })).toBe('cancelled');
  });
});
