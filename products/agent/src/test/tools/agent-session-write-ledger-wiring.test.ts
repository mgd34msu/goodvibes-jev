/**
 * The session write ledger is fed from the runtime tool-event stream.
 *
 * Only a write that SUCCEEDED earns a read waiver: the path is staged when the
 * call is received (the only event carrying arguments) and committed when the
 * call reports success. A failed or cancelled write never created a file, so it
 * must not unlock a read.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import type { ToolEvent } from '@/runtime/index.ts';
import {
  attachAgentSessionWriteLedger,
  wasWrittenInAgentSession,
  clearAgentSessionWrites,
} from '@/tools/agent-session-write-ledger.ts';

const TARGET = '/home/buzzkill/.goodvibes-screen.png';

let bus: RuntimeEventBus;
let detach: () => void;

function emit(event: ToolEvent): void {
  bus.emit('tools', createEventEnvelope(event.type, event, {
    sessionId: 'test-session',
    traceId: 'test-trace',
    source: 'agent-session-write-ledger.test',
    turnId: 'turn-1',
  }));
}

function received(tool: string, args: Record<string, unknown>, callId = 'call-1'): ToolEvent {
  return { type: 'TOOL_RECEIVED', callId, turnId: 'turn-1', tool, args } as ToolEvent;
}

function outcome(type: 'TOOL_SUCCEEDED' | 'TOOL_FAILED' | 'TOOL_CANCELLED', callId = 'call-1'): ToolEvent {
  const base = { callId, turnId: 'turn-1', tool: 'write', durationMs: 1 };
  if (type === 'TOOL_FAILED') return { ...base, type, error: 'boom' } as ToolEvent;
  if (type === 'TOOL_CANCELLED') return { ...base, type } as ToolEvent;
  return { ...base, type, result: { kind: 'text', byteSize: 0 } } as ToolEvent;
}

/** Bus dispatch is per-microtask, so let the queue drain before asserting. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  clearAgentSessionWrites();
  bus = new RuntimeEventBus();
  detach = attachAgentSessionWriteLedger(bus);
});

afterEach(() => {
  detach();
  clearAgentSessionWrites();
});

describe('session write ledger wiring', () => {
  test('a successful write commits the path', async () => {
    emit(received('write', { path: TARGET }));
    emit(outcome('TOOL_SUCCEEDED'));
    await settle();
    expect(wasWrittenInAgentSession(TARGET)).toBe(true);
  });

  test('a received-but-unfinished write commits nothing', async () => {
    emit(received('write', { path: TARGET }));
    await settle();
    expect(wasWrittenInAgentSession(TARGET)).toBe(false);
  });

  test('a failed write commits nothing', async () => {
    emit(received('write', { path: TARGET }));
    emit(outcome('TOOL_FAILED'));
    await settle();
    expect(wasWrittenInAgentSession(TARGET)).toBe(false);
  });

  test('a cancelled write commits nothing', async () => {
    emit(received('write', { path: TARGET }));
    emit(outcome('TOOL_CANCELLED'));
    await settle();
    expect(wasWrittenInAgentSession(TARGET)).toBe(false);
  });

  test('the edit tool also records its target', async () => {
    emit(received('edit', { file_path: TARGET }));
    emit(outcome('TOOL_SUCCEEDED'));
    await settle();
    expect(wasWrittenInAgentSession(TARGET)).toBe(true);
  });

  test('a batch write records every path in the batch', async () => {
    emit(received('write', { files: [{ path: '/tmp/.a' }, { path: '/tmp/.b' }] }));
    emit(outcome('TOOL_SUCCEEDED'));
    await settle();
    expect(wasWrittenInAgentSession('/tmp/.a')).toBe(true);
    expect(wasWrittenInAgentSession('/tmp/.b')).toBe(true);
  });

  test('a shell command that happens to name a path records nothing', async () => {
    emit(received('exec', { command: 'cp x .y', path: TARGET }));
    emit(outcome('TOOL_SUCCEEDED'));
    await settle();
    expect(wasWrittenInAgentSession(TARGET)).toBe(false);
  });

  test('a read call records nothing', async () => {
    emit(received('read', { path: TARGET }));
    emit(outcome('TOOL_SUCCEEDED'));
    await settle();
    expect(wasWrittenInAgentSession(TARGET)).toBe(false);
  });

  test('detaching stops recording', async () => {
    detach();
    emit(received('write', { path: TARGET }));
    emit(outcome('TOOL_SUCCEEDED'));
    await settle();
    expect(wasWrittenInAgentSession(TARGET)).toBe(false);
  });
});
