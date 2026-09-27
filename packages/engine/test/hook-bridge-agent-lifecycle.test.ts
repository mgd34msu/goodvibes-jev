/**
 * The lifecycle hook bridge fires Lifecycle:agent:cancelled from the
 * AGENT_CANCELLED event and Lifecycle:agent:failed from every AGENT_FAILED
 * event; it never reads the error wording to tell the two apart.
 */
import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.ts';
import { registerBootstrapHookBridge } from '../sdk/src/platform/runtime/bootstrap-hook-bridge.ts';
import type { HookEvent } from '../sdk/src/platform/hooks/types.ts';
import { emitAgentCancelled, emitAgentFailed } from '../sdk/src/platform/runtime/emitters/agents.ts';

function bridge(): { bus: RuntimeEventBus; fired: Array<Pick<HookEvent, 'path' | 'specific' | 'payload'>>; stop(): void } {
  const bus = new RuntimeEventBus();
  const fired: Array<Pick<HookEvent, 'path' | 'specific' | 'payload'>> = [];
  const unsubs = registerBootstrapHookBridge({
    runtimeBus: bus,
    hookDispatcher: { fire: (event: HookEvent) => { fired.push({ path: event.path, specific: event.specific, payload: event.payload }); return Promise.resolve({ ok: true }); } } as never,
    runtime: { sessionId: 'session-1' } as never,
  });
  return { bus, fired, stop: () => { for (const unsub of unsubs) unsub(); } };
}

/** The bus delivers on a later microtask. */
const delivered = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

const ctx = { sessionId: 'session-1', traceId: 'trace-1', source: 'test' };

describe('agent lifecycle hooks', () => {
  test('AGENT_CANCELLED fires the cancelled hook', async () => {
    const { bus, fired, stop } = bridge();
    try {
      emitAgentCancelled(bus, ctx, { agentId: 'ag-1', reason: 'Agent cancelled' });
      await delivered();
      expect(fired).toEqual([{ path: 'Lifecycle:agent:cancelled', specific: 'cancelled', payload: { agentId: 'ag-1', error: 'Agent cancelled' } }]);
    } finally {
      stop();
    }
  });

  test('AGENT_FAILED fires the failed hook even when the wording mentions a cancel', async () => {
    const { bus, fired, stop } = bridge();
    try {
      emitAgentFailed(bus, ctx, { agentId: 'ag-2', error: 'upstream request cancelled by the provider', durationMs: 5 });
      await delivered();
      expect(fired).toEqual([{ path: 'Lifecycle:agent:failed', specific: 'failed', payload: { agentId: 'ag-2', error: 'upstream request cancelled by the provider' } }]);
    } finally {
      stop();
    }
  });
});
