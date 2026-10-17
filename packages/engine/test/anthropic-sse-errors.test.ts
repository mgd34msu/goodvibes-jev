import { expect, test } from 'bun:test';
import { createAnthropicSSEState, readAnthropicSSEStream } from '../sdk/src/platform/providers/anthropic-sse-assembler.js';
import { ProviderError } from '../sdk/src/platform/types/errors.js';

const text = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } };
function stream(events: unknown[]) {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}`).join('\r\n\r\n')).body!.getReader();
}

test('an error after text rejects with its retryable provider status', async () => {
  const state = createAnthropicSSEState();
  const error = await readAnthropicSSEStream(stream([text, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]), state, undefined, 'Anthropic').catch(error => error);
  expect(error).toBeInstanceOf(ProviderError);
  expect(error.statusCode).toBe(529);
  expect(error.recoverable).toBe(true);
});

test('premature EOF cannot turn partial output into success', async () => {
  await expect(readAnthropicSSEStream(stream([text]), createAnthropicSSEState(), undefined, 'Anthropic')).rejects.toThrow('before message_stop');
});

test('a complete stream preserves the final event without a trailing newline', async () => {
  const state = createAnthropicSSEState();
  await readAnthropicSSEStream(stream([text, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }]), state, undefined, 'Anthropic');
  expect(state.responseText).toBe('partial');
  expect(state.stopReason).toBe('completed');
});
