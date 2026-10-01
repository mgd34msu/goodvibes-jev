import { describe, expect, test } from 'bun:test';
import {
  hostedLiveMessageFromTurnFrame,
  hostedToolCallFromFrame,
  isTerminalTurnFrame,
  readHostedStreamFrame,
  streamDeltaAccumulated,
} from './hosted-session-stream';

describe('readHostedStreamFrame', () => {
  test('decodes a well-formed envelope', () => {
    const frame = readHostedStreamFrame({ type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: { accumulated: 'hi' } });
    expect(frame).toEqual({ type: 'STREAM_DELTA', sessionId: 'hosted-1', payload: { accumulated: 'hi' } });
  });

  test('null when there is no sessionId, a frame this client cannot attribute to any session', () => {
    expect(readHostedStreamFrame({ type: 'STREAM_DELTA', payload: {} })).toBeNull();
    expect(readHostedStreamFrame({})).toBeNull();
    expect(readHostedStreamFrame(undefined)).toBeNull();
  });

  test('a missing payload degrades to an empty object, never a crash', () => {
    const frame = readHostedStreamFrame({ type: 'TURN_COMPLETED', sessionId: 's-1' });
    expect(frame?.payload).toEqual({});
  });
});

describe('streamDeltaAccumulated', () => {
  test('reads payload.accumulated for a STREAM_DELTA frame', () => {
    const frame = readHostedStreamFrame({ type: 'STREAM_DELTA', sessionId: 's-1', payload: { accumulated: 'partial text' } })!;
    expect(streamDeltaAccumulated(frame)).toBe('partial text');
  });

  test('null for a non-STREAM_DELTA frame', () => {
    const frame = readHostedStreamFrame({ type: 'TURN_COMPLETED', sessionId: 's-1', payload: {} })!;
    expect(streamDeltaAccumulated(frame)).toBeNull();
  });
});

describe('hostedLiveMessageFromTurnFrame', () => {
  test('TURN_COMPLETED renders the response as an assistant message', () => {
    const frame = readHostedStreamFrame({ type: 'TURN_COMPLETED', sessionId: 's-1', payload: { response: 'done' } })!;
    const message = hostedLiveMessageFromTurnFrame(frame, () => 42);
    expect(message).toEqual({ role: 'assistant', content: 'done', at: 42 });
  });

  test('TURN_ERROR renders a system note naming the error', () => {
    const frame = readHostedStreamFrame({ type: 'TURN_ERROR', sessionId: 's-1', payload: { error: 'boom' } })!;
    const message = hostedLiveMessageFromTurnFrame(frame, () => 1);
    expect(message?.role).toBe('system');
    expect(message?.content).toContain('boom');
  });

  test('TURN_CANCEL renders a system note', () => {
    const frame = readHostedStreamFrame({ type: 'TURN_CANCEL', sessionId: 's-1', payload: {} })!;
    const message = hostedLiveMessageFromTurnFrame(frame, () => 1);
    expect(message?.role).toBe('system');
    expect(message?.content.length).toBeGreaterThan(0);
  });

  test('null for a non-terminal frame (e.g. STREAM_DELTA)', () => {
    const frame = readHostedStreamFrame({ type: 'STREAM_DELTA', sessionId: 's-1', payload: {} })!;
    expect(hostedLiveMessageFromTurnFrame(frame)).toBeNull();
  });
});

describe('isTerminalTurnFrame', () => {
  test('true for COMPLETED/ERROR/CANCEL', () => {
    for (const type of ['TURN_COMPLETED', 'TURN_ERROR', 'TURN_CANCEL']) {
      const frame = readHostedStreamFrame({ type, sessionId: 's-1', payload: {} })!;
      expect(isTerminalTurnFrame(frame)).toBe(true);
    }
  });

  test('false for an in-flight event', () => {
    const frame = readHostedStreamFrame({ type: 'STREAM_DELTA', sessionId: 's-1', payload: {} })!;
    expect(isTerminalTurnFrame(frame)).toBe(false);
  });
});

describe('hostedToolCallFromFrame', () => {
  test('TOOL_EXECUTING → executing', () => {
    const frame = readHostedStreamFrame({ type: 'TOOL_EXECUTING', sessionId: 's-1', payload: { callId: 'c1', turnId: 't1', tool: 'exec' } })!;
    expect(hostedToolCallFromFrame(frame)).toEqual({ callId: 'c1', turnId: 't1', tool: 'exec', state: 'executing' });
  });

  test('TOOL_SUCCEEDED → succeeded', () => {
    const frame = readHostedStreamFrame({ type: 'TOOL_SUCCEEDED', sessionId: 's-1', payload: { callId: 'c1', turnId: 't1', tool: 'exec' } })!;
    expect(hostedToolCallFromFrame(frame)?.state).toBe('succeeded');
  });

  test('TOOL_FAILED → failed, carries the error', () => {
    const frame = readHostedStreamFrame({ type: 'TOOL_FAILED', sessionId: 's-1', payload: { callId: 'c1', turnId: 't1', tool: 'exec', error: 'nope' } })!;
    expect(hostedToolCallFromFrame(frame)).toEqual({ callId: 'c1', turnId: 't1', tool: 'exec', state: 'failed', error: 'nope' });
  });

  test('a tool lifecycle stage this view does not render (e.g. TOOL_RECEIVED) is null', () => {
    const frame = readHostedStreamFrame({ type: 'TOOL_RECEIVED', sessionId: 's-1', payload: { callId: 'c1', turnId: 't1', tool: 'exec' } })!;
    expect(hostedToolCallFromFrame(frame)).toBeNull();
  });

  test('a frame missing callId/tool is null, never a partial call', () => {
    const frame = readHostedStreamFrame({ type: 'TOOL_EXECUTING', sessionId: 's-1', payload: {} })!;
    expect(hostedToolCallFromFrame(frame)).toBeNull();
  });
});
