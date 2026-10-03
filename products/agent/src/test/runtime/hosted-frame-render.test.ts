/**
 * hosted-frame-render.test.ts
 *
 * When a turn's loop runs in the daemon, this surface has no provider response
 * to render, only the hosted session's event frames. These tests hand the
 * mapping those frames directly and check what lands in the conversation, so a
 * rendering defect shows up here rather than as a turn that looked wrong on
 * someone's screen.
 */

import { describe, expect, test } from 'bun:test';
import { createHostedFrameRenderer, type HostedFrameConversation } from '../../runtime/client/hosted-frame-render.ts';

/** A tool result as it lands in the conversation, in the shape a test asserts on. */
interface RecordedToolResult {
  readonly callId: string;
  readonly success: boolean;
  readonly output?: string | undefined;
  readonly error?: string | undefined;
}

type Recorded =
  | { readonly kind: 'assistant'; readonly content: string; readonly opts?: Record<string, unknown> | undefined }
  | { readonly kind: 'tool-results'; readonly results: readonly RecordedToolResult[] }
  | { readonly kind: 'system'; readonly content: string }
  | { readonly kind: 'stream-start' }
  | { readonly kind: 'stream-update'; readonly content: string }
  | { readonly kind: 'stream-final' };

/** A conversation that records what it was told, in order. */
function recorder(): { conversation: HostedFrameConversation; entries: Recorded[]; renders: () => number } {
  const entries: Recorded[] = [];
  let renders = 0;
  const conversation: HostedFrameConversation = {
    addAssistantMessage: (content, opts) => {
      entries.push({ kind: 'assistant', content, opts: opts as Record<string, unknown> | undefined });
    },
    addToolResults: (results) => {
      entries.push({ kind: 'tool-results', results: results as unknown as readonly RecordedToolResult[] });
    },
    addSystemMessage: (content) => { entries.push({ kind: 'system', content }); },
    startStreamingBlock: () => { entries.push({ kind: 'stream-start' }); },
    updateStreamingBlock: (content) => { entries.push({ kind: 'stream-update', content }); },
    finalizeStreamingBlock: () => { entries.push({ kind: 'stream-final' }); },
  };
  return { conversation, entries, renders: () => renders };
}

function frame(type: string, payload: Record<string, unknown> = {}): { type: string; payload: Record<string, unknown> } {
  return { type, payload };
}

describe('rendering a daemon-hosted turn from its event frames', () => {
  test('text deltas stream into the conversation and close as one assistant message', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});

    renderer.apply(frame('STREAM_START', { turnId: 't1' }));
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', content: 'Hel', accumulated: 'Hel' }));
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', content: 'lo', accumulated: 'Hello' }));
    renderer.apply(frame('TURN_COMPLETED', { turnId: 't1', response: 'Hello', stopReason: 'completed' }));

    expect(entries.filter((e) => e.kind === 'stream-update').map((e) => (e as { content: string }).content))
      .toEqual(['Hel', 'Hello']);
    const assistant = entries.filter((e) => e.kind === 'assistant');
    expect(assistant).toHaveLength(1);
    expect((assistant[0] as { content: string }).content).toBe('Hello');
    expect(renderer.isTurnFinished()).toBe(true);
  });

  test('a tool call closes the assistant message it belongs to, and its result follows', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});

    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', accumulated: 'Reading the file' }));
    renderer.apply(frame('TOOL_RECEIVED', {
      turnId: 't1', callId: 'call-1', tool: 'read_file', args: { path: '/tmp/notes.md' },
    }));
    renderer.apply(frame('TOOL_SUCCEEDED', {
      turnId: 't1', callId: 'call-1', tool: 'read_file', durationMs: 12,
      result: { kind: 'text', byteSize: 5, preview: 'hello' },
    }));
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', accumulated: 'It says hello.' }));
    renderer.apply(frame('TURN_COMPLETED', { turnId: 't1', response: 'It says hello.' }));

    const ordered = entries.filter((e) => e.kind === 'assistant' || e.kind === 'tool-results');
    // The text that preceded the call, carrying the call; then the result; then
    // the text that came after. Out of that order the transcript reads wrong.
    expect(ordered.map((e) => e.kind)).toEqual(['assistant', 'tool-results', 'assistant']);
    const first = ordered[0] as { content: string; opts?: { toolCalls?: { id: string; name: string }[] } };
    expect(first.content).toBe('Reading the file');
    expect(first.opts?.toolCalls?.[0]?.id).toBe('call-1');
    expect(first.opts?.toolCalls?.[0]?.name).toBe('read_file');
    const results = (ordered[1] as { results: readonly RecordedToolResult[] }).results;
    expect(results[0]?.callId).toBe('call-1');
    expect(results[0]?.success).toBe(true);
    expect(results[0]?.output).toBe('hello');
    expect((ordered[2] as { content: string }).content).toBe('It says hello.');
  });

  test('a failed tool arrives as a failed result carrying the reason', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});

    renderer.apply(frame('TOOL_RECEIVED', { turnId: 't1', callId: 'c9', tool: 'write_file', args: {} }));
    renderer.apply(frame('TOOL_FAILED', {
      turnId: 't1', callId: 'c9', tool: 'write_file', error: 'permission denied', durationMs: 3,
    }));

    const results = (entries.find((e) => e.kind === 'tool-results') as
      { results: readonly RecordedToolResult[] }).results;
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toBe('permission denied');
  });

  test('a truncated tool result says it is a preview instead of passing as the whole output', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});

    renderer.apply(frame('TOOL_RECEIVED', { turnId: 't1', callId: 'c1', tool: 'read_file', args: {} }));
    renderer.apply(frame('TOOL_SUCCEEDED', {
      turnId: 't1', callId: 'c1', tool: 'read_file', durationMs: 1,
      result: { kind: 'text', byteSize: 4096, preview: 'first hundred chars' },
    }));

    const results = (entries.find((e) => e.kind === 'tool-results') as
      { results: readonly RecordedToolResult[] }).results;
    expect(results[0]?.output).toContain('first hundred chars');
    expect(results[0]?.output).toContain('4096 bytes total');
  });

  test('usage from the turn lands on the message that ends it, not on an intermediate one', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});

    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', accumulated: 'working' }));
    renderer.apply(frame('TOOL_RECEIVED', { turnId: 't1', callId: 'c1', tool: 'ls', args: {} }));
    renderer.apply(frame('LLM_RESPONSE_RECEIVED', {
      turnId: 't1', provider: 'anthropic', model: 'claude-opus-5', inputTokens: 1200, outputTokens: 64,
    }));
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', accumulated: 'done' }));
    renderer.apply(frame('TURN_COMPLETED', { turnId: 't1', response: 'done' }));

    const assistants = entries.filter((e) => e.kind === 'assistant') as
      { content: string; opts?: { usage?: { inputTokens: number; outputTokens: number }; model?: string } }[];
    expect(assistants[0]?.opts?.usage).toBeUndefined();
    expect(assistants[1]?.opts?.usage?.inputTokens).toBe(1200);
    expect(assistants[1]?.opts?.usage?.outputTokens).toBe(64);
    expect(assistants[1]?.opts?.model).toBe('claude-opus-5');
  });

  test('a turn with no usage frame produces no usage rather than zeros', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', accumulated: 'hi' }));
    renderer.apply(frame('TURN_COMPLETED', { turnId: 't1', response: 'hi' }));
    const assistant = entries.find((e) => e.kind === 'assistant') as { opts?: { usage?: unknown } };
    expect(assistant.opts?.usage).toBeUndefined();
  });

  test('a non-streaming turn still renders, from the completion frame', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});
    renderer.apply(frame('TURN_COMPLETED', { turnId: 't1', response: 'the whole answer' }));
    const assistant = entries.find((e) => e.kind === 'assistant') as { content: string };
    expect(assistant.content).toBe('the whole answer');
  });

  test('a turn the daemon reports failing keeps its partial text and says what happened', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', accumulated: 'partial' }));
    renderer.apply(frame('TURN_ERROR', { turnId: 't1', error: 'provider_exhausted' }));

    expect((entries.find((e) => e.kind === 'assistant') as { content: string }).content).toBe('partial');
    const system = entries.find((e) => e.kind === 'system') as { content: string };
    expect(system.content).toContain('provider_exhausted');
    expect(renderer.isTurnFinished()).toBe(true);
  });

  test('a stream that dies mid-turn keeps the partial text and states the turn may still be running', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', accumulated: 'half an answer' }));
    renderer.abandon('The connection to the hosting daemon ended before this turn finished.');

    expect((entries.find((e) => e.kind === 'assistant') as { content: string }).content).toBe('half an answer');
    expect((entries.find((e) => e.kind === 'system') as { content: string }).content)
      .toContain('ended before this turn finished');
  });

  test('frames arriving after the turn ended are ignored', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});
    renderer.apply(frame('TURN_COMPLETED', { turnId: 't1', response: 'done' }));
    const afterEnd = entries.length;
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', accumulated: 'late' }));
    renderer.apply(frame('TURN_COMPLETED', { turnId: 't1', response: 'again' }));
    expect(entries.length).toBe(afterEnd);
  });

  test('an unrecognised frame changes nothing', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});
    renderer.apply(frame('SOMETHING_NEW', { turnId: 't1' }));
    renderer.apply(frame('TOOL_PREHOOKED', { turnId: 't1', callId: 'c1', tool: 'ls' }));
    expect(entries).toEqual([]);
  });

  test('a delta with no accumulated field still builds the running text', () => {
    const { conversation, entries } = recorder();
    const renderer = createHostedFrameRenderer(conversation, () => {});
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', content: 'one ' }));
    renderer.apply(frame('STREAM_DELTA', { turnId: 't1', content: 'two' }));
    const updates = entries.filter((e) => e.kind === 'stream-update').map((e) => (e as { content: string }).content);
    expect(updates).toEqual(['one ', 'one two']);
  });
});
