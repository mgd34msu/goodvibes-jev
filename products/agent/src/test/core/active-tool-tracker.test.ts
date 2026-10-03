/**
 * active-tool-tracker.test.ts, the running call the throbber names: its
 * arguments from TOOL_RECEIVED, its start from TOOL_EXECUTING, gone when it
 * settles, and bounded when calls never report back.
 */

import { describe, expect, test } from 'bun:test';
import { trackActiveTool } from '../../core/active-tool-tracker.ts';

type Handler = (ev: never) => void;

function fakeTools() {
  const listeners = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return () => {};
    },
    emit(event: string, payload: Record<string, unknown>) {
      for (const h of listeners.get(event) ?? []) h(payload as never);
    },
  };
}

describe('active tool tracker', () => {
  test('names the running call with its arguments, and forgets it when it settles', () => {
    const tools = fakeTools();
    const tracker = trackActiveTool(tools as never);
    expect(tracker.current()).toBeNull();
    tools.emit('TOOL_RECEIVED', { callId: 'c1', tool: 'exec', args: { command: 'bun test' } });
    tools.emit('TOOL_EXECUTING', { callId: 'c1', tool: 'exec', startedAt: 5 });
    expect(tracker.current()).toEqual({ name: 'exec', args: { command: 'bun test' }, startedAtMs: 5 });
    tools.emit('TOOL_SUCCEEDED', { callId: 'c1' });
    expect(tracker.current()).toBeNull();
  });

  test('with two calls running the newest is named; when it ends the other is', () => {
    const tools = fakeTools();
    const tracker = trackActiveTool(tools as never);
    tools.emit('TOOL_EXECUTING', { callId: 'a', tool: 'read', startedAt: 1 });
    tools.emit('TOOL_EXECUTING', { callId: 'b', tool: 'find', startedAt: 2 });
    expect(tracker.current()?.name).toBe('find');
    tools.emit('TOOL_FAILED', { callId: 'b' });
    expect(tracker.current()?.name).toBe('read');
    tools.emit('TOOL_CANCELLED', { callId: 'a' });
    expect(tracker.current()).toBeNull();
  });

  test('among many running calls the newest is named, and clear forgets them all', () => {
    const tools = fakeTools();
    const tracker = trackActiveTool(tools as never);
    for (let i = 0; i < 200; i++) {
      tools.emit('TOOL_RECEIVED', { callId: `c${i}`, tool: 'read', args: { path: `f${i}` } });
      tools.emit('TOOL_EXECUTING', { callId: `c${i}`, tool: 'read', startedAt: i });
    }
    expect(tracker.current()).toEqual({ name: 'read', args: { path: 'f199' }, startedAtMs: 199 });
    tracker.clear();
    expect(tracker.current()).toBeNull();
  });
});
