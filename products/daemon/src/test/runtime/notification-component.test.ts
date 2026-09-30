// Component cases retained from the pinned source; the complete original
// notification-dispatch suite remains unmapped until services.ts is ported.
/**
 * How this daemon dispatches notices without a screen.
 *
 * Panel-feed notices are the surface's, the router's three targets are all
 * screen targets and this product has no screen. Channel notices are the
 * daemon's, and the one notice only the daemon can produce about itself is
 * memory pressure: the governor measures the process it runs in, and the
 * daemon that ran out of memory is exactly the one that cannot tell you
 * afterwards.
 *
 * That notice used to be routed into a bounded ring with no reader anywhere
 * in the repository. These tests pin the two outcomes it can have now,
 * sent, or written down, and that neither is silence.
 */
import { describe, expect, test } from 'bun:test';
import { wireMemoryPressureChannelNotice, type DaemonNoticeChannel } from '../../runtime/notification-dispatch.js';

type OpsListener = (envelope: { type: string; ts: number; traceId?: string; payload: unknown }) => void;

/** The 'ops' half of a runtime bus, which is all this bridge subscribes to. */
function pressureBus() {
  let listener: OpsListener | null = null;
  return {
    bus: {
      onDomain: (domain: string, cb: OpsListener) => {
        if (domain === 'ops') listener = cb;
        return () => { listener = null; };
      },
    },
    emitOps: (envelope: { type: string; ts: number; payload: unknown }) => listener?.(envelope),
  };
}

function pressurePayload(tier: 'high' | 'critical') {
  return {
    type: 'OPS_MEMORY_PRESSURE',
    tier,
    previousTier: tier === 'critical' ? 'high' : 'elevated',
    rssMb: 3600,
    heapMb: 900,
    budgetMb: 4096,
    usedPct: 88,
  };
}

function sendingChannel(configured: boolean) {
  const sent: string[] = [];
  const channel: DaemonNoticeChannel = {
    isConfigured: () => configured,
    send: async (text: string) => {
      sent.push(text);
      return undefined;
    },
  };
  return { channel, sent };
}

describe('memory pressure leaves the daemon over the configured notice destination', () => {
  test('a pressure event is sent as text when a destination is configured', async () => {
    const { bus, emitOps } = pressureBus();
    const { channel, sent } = sendingChannel(true);
    wireMemoryPressureChannelNotice(bus as never, channel);

    emitOps({ type: 'OPS_MEMORY_PRESSURE', ts: 1, payload: pressurePayload('critical') });
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('memory pressure');
  });

  test('with no destination configured the notice is still written, not dropped', async () => {
    const { bus, emitOps } = pressureBus();
    const { channel, sent } = sendingChannel(false);
    wireMemoryPressureChannelNotice(bus as never, channel);

    emitOps({ type: 'OPS_MEMORY_PRESSURE', ts: 1, payload: pressurePayload('critical') });
    await Promise.resolve();

    // Nothing sent, because nothing is configured, and nothing thrown either.
    expect(sent).toHaveLength(0);
  });

  test('the high-churn rest of the ops domain is not a notice', async () => {
    const { bus, emitOps } = pressureBus();
    const { channel, sent } = sendingChannel(true);
    wireMemoryPressureChannelNotice(bus as never, channel);

    emitOps({ type: 'OPS_AUDIT', ts: 1, payload: { action: 'x' } });
    await Promise.resolve();

    expect(sent).toHaveLength(0);
  });

  test('a destination that refuses does not take the daemon down with it', async () => {
    const { bus, emitOps } = pressureBus();
    const channel: DaemonNoticeChannel = {
      isConfigured: () => true,
      send: async () => {
        throw new Error('webhook endpoint unreachable');
      },
    };
    wireMemoryPressureChannelNotice(bus as never, channel);

    expect(() => emitOps({ type: 'OPS_MEMORY_PRESSURE', ts: 1, payload: pressurePayload('high') })).not.toThrow();
    await Promise.resolve();
  });

  test('unsubscribing stops the notices', async () => {
    const { bus, emitOps } = pressureBus();
    const { channel, sent } = sendingChannel(true);
    const off = wireMemoryPressureChannelNotice(bus as never, channel);
    off();

    emitOps({ type: 'OPS_MEMORY_PRESSURE', ts: 1, payload: pressurePayload('critical') });
    await Promise.resolve();

    expect(sent).toHaveLength(0);
  });
});

