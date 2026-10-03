/**
 * approvals-view.test.ts
 *
 * The panel's contract: the daemon's record is the list every
 * surface reads, the asks this process still holds are unioned in rather than
 * dropped, and an unreachable host never renders as an empty list.
 *
 * Plus how transitions arrive: the `control.approval_update` stream carries
 * them the moment the daemon records them, and the periodic re-read is retained
 * underneath for every case where a stream cannot be had.
 */
import { describe, expect, test } from 'bun:test';
import type { SharedApprovalRecord } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { DaemonReachability, DaemonVerbCaller } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import {
  applyApprovalUpdate,
  createApprovalsView,
  describeApprovalsUnavailable,
  unionApprovalRecords,
} from '../../runtime/client/approvals-view.ts';

function approval(overrides: Partial<SharedApprovalRecord> & { id: string }): SharedApprovalRecord {
  return {
    callId: `call-${overrides.id}`,
    status: 'pending',
    request: {
      callId: `call-${overrides.id}`,
      tool: 'bash',
      args: {},
      category: 'exec',
      analysis: { risk: 'low', reasons: [] },
    } as unknown as SharedApprovalRecord['request'],
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
    audit: [],
    ...overrides,
  };
}

function verbs(options: {
  readonly probe: DaemonReachability;
  readonly invoke?: (methodId: string) => Promise<unknown>;
}): DaemonVerbCaller {
  return {
    probe: () => options.probe,
    invoke: async <T,>(methodId: string): Promise<T> => {
      if (!options.invoke) throw new Error(`no invoke wired for '${methodId}'`);
      return await options.invoke(methodId) as T;
    },
  };
}

describe('approvals view: the daemon record is the panel', () => {
  test('a pending ask on the daemon appears in the panel', async () => {
    const view = createApprovalsView({
      verbs: verbs({
        probe: { available: true },
        invoke: async () => ({ approvals: [approval({ id: 'host-1', sessionId: 'session-a' })] }),
      }),
      localBroker: { listApprovals: () => [] },
    });

    // Before any read the panel does NOT claim the host is fine and empty.
    const beforeRead = view.snapshot();
    expect(beforeRead.hostRecordRead).toBe(false);
    expect(beforeRead.unavailableReason).toContain('has not been read yet');

    const snapshot = await view.refresh();
    expect(snapshot.hostRecordRead).toBe(true);
    expect(snapshot.unavailableReason).toBeNull();
    expect(snapshot.approvals.map((row) => row.id)).toEqual(['host-1']);
    expect(describeApprovalsUnavailable(snapshot)).toBeNull();

    // snapshot() serves the same list without a second round trip.
    expect(view.snapshot().approvals.map((row) => row.id)).toEqual(['host-1']);
  });

  test('an ask the local broker still holds is unioned in, not replaced by the host list', async () => {
    const view = createApprovalsView({
      verbs: verbs({
        probe: { available: true },
        invoke: async () => ({ approvals: [approval({ id: 'host-1', sessionId: 'session-a' })] }),
      }),
      localBroker: { listApprovals: () => [approval({ id: 'bridge-1', sessionId: 'session-b' })] },
    });

    const snapshot = await view.refresh();
    expect(snapshot.approvals.map((row) => row.id)).toEqual(['host-1', 'bridge-1']);
    expect(snapshot.localOnlyCount).toBe(1);
  });

  test('an ask both sides know about is counted once', async () => {
    const shared = approval({ id: 'host-1', sessionId: 'session-a', callId: 'call-shared' });
    // Same session and tool call, different record id, the daemon's own
    // coalescing identity, which is how one ask ends up on both sides.
    const deduped = createApprovalsView({
      verbs: verbs({
        probe: { available: true },
        invoke: async () => ({ approvals: [shared] }),
      }),
      localBroker: {
        listApprovals: () => [approval({ id: 'local-mirror', sessionId: 'session-a', callId: 'call-shared' })],
      },
    });

    const snapshot = await deduped.refresh();
    expect(snapshot.approvals.map((row) => row.id)).toEqual(['host-1']);
    expect(snapshot.localOnlyCount).toBe(0);
  });
});

describe('approvals view: an unreachable host is never an empty list', () => {
  test('an unresolvable host renders the reason, not zero', async () => {
    const view = createApprovalsView({
      verbs: verbs({
        probe: {
          available: false,
          reason: 'the connected host is disabled (daemon.enabled=false), nothing to reach.',
        },
      }),
      localBroker: { listApprovals: () => [] },
    });

    const snapshot = await view.refresh();
    expect(snapshot.hostRecordRead).toBe(false);
    expect(snapshot.approvals).toHaveLength(0);
    expect(snapshot.unavailableReason).toContain('daemon.enabled=false');

    const line = describeApprovalsUnavailable(snapshot);
    expect(line).not.toBeNull();
    expect(line).toContain('could not be read');
    expect(line).toContain('daemon.enabled=false');
    // The load-bearing half: the owner is told the absence is not an answer.
    expect(line).toContain('not the same as nothing waiting');
  });

  test('a verb that throws reports the failure and still shows this process\'s own asks', async () => {
    const view = createApprovalsView({
      verbs: verbs({
        probe: { available: true },
        invoke: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3421'); },
      }),
      localBroker: { listApprovals: () => [approval({ id: 'bridge-1' })] },
    });

    const snapshot = await view.refresh();
    expect(snapshot.hostRecordRead).toBe(false);
    expect(snapshot.unavailableReason).toContain('ECONNREFUSED');
    expect(snapshot.approvals.map((row) => row.id)).toEqual(['bridge-1']);

    const line = describeApprovalsUnavailable(snapshot);
    expect(line).toContain('ECONNREFUSED');
    expect(line).toContain('1 ask raised in this process is shown below');
  });

  test('a reply this build cannot read is reported, not silently emptied', async () => {
    const view = createApprovalsView({
      verbs: verbs({
        probe: { available: true },
        invoke: async () => ({ approvals: [approval({ id: 'host-1' }), { unexpected: true }] }),
      }),
      localBroker: { listApprovals: () => [] },
    });

    const snapshot = await view.refresh();
    expect(snapshot.approvals.map((row) => row.id)).toEqual(['host-1']);
    expect(snapshot.hostRecordRead).toBe(false);
    expect(snapshot.unavailableReason).toContain('could not read');
  });
});

describe('approvals view: the union rule, driven directly', () => {
  test('host rows come first and local rows are appended, both keys deduping', () => {
    const result = unionApprovalRecords(
      [approval({ id: 'h1', callId: 'c1' }), approval({ id: 'h2', callId: 'c2' })],
      [
        approval({ id: 'h1', callId: 'c1' }),        // same id
        approval({ id: 'mirror', callId: 'c2' }),    // same coalescing key
        approval({ id: 'l1', callId: 'c9' }),        // genuinely local
      ],
    );
    expect(result.approvals.map((row) => row.id)).toEqual(['h1', 'h2', 'l1']);
    expect(result.localOnlyCount).toBe(1);
  });

  test('a record with no call id is never coalesced away by another with no call id', () => {
    const result = unionApprovalRecords(
      [approval({ id: 'h1', callId: '' })],
      [approval({ id: 'l1', callId: '' })],
    );
    expect(result.approvals.map((row) => row.id)).toEqual(['h1', 'l1']);
  });
});

describe('approvals view: transitions arrive on the push channel, with the poll underneath', () => {
  /** A subscribe seam a test drives by hand, standing in for the real stream. */
  function stream(): {
    readonly subscribe: NonNullable<Parameters<typeof createApprovalsView>[0]['subscribe']>;
    push(record: SharedApprovalRecord): void;
    drop(): void;
    opened(): number;
    closed(): number;
  } {
    let onUpdate: ((notice: { approval: unknown; createdAt: number }) => void) | null = null;
    let onTerminate: ((error: unknown) => void) | null = null;
    let opens = 0;
    let closes = 0;
    return {
      subscribe: async (handlers) => {
        opens += 1;
        onUpdate = handlers.onUpdate as typeof onUpdate;
        onTerminate = handlers.onTerminate;
        return { close: () => { closes += 1; } };
      },
      push: (record) => onUpdate?.({ approval: record, createdAt: Date.now() }),
      drop: () => onTerminate?.(new Error('the stream ended')),
      opened: () => opens,
      closed: () => closes,
    };
  }

  /** Let start()'s unawaited subscribe/refresh settle before asserting. */
  const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };

  test('an ask raised elsewhere lands on the panel without waiting for a re-read', async () => {
    const channel = stream();
    let listReads = 0;
    const view = createApprovalsView({
      verbs: verbs({
        probe: { available: true },
        invoke: async () => { listReads += 1; return { approvals: [] }; },
      }),
      localBroker: { listApprovals: () => [] },
      subscribe: channel.subscribe,
    });

    view.start();
    await settle();
    expect(view.snapshot().liveUpdates).toBe(true);

    channel.push(approval({ id: 'phone-ask', sessionId: 'session-a' }));
    expect(view.snapshot().approvals.map((row) => row.id)).toEqual(['phone-ask']);
    // The record came whole on the frame; nothing had to be read back for it.
    expect(listReads).toBe(1);

    view.stop();
    expect(channel.closed()).toBe(1);
  });

  test('a decision made on another surface clears the row', async () => {
    const channel = stream();
    const view = createApprovalsView({
      verbs: verbs({ probe: { available: true }, invoke: async () => ({ approvals: [] }) }),
      localBroker: { listApprovals: () => [] },
      subscribe: channel.subscribe,
    });

    view.start();
    await settle();
    channel.push(approval({ id: 'ask-1' }));
    expect(view.snapshot().approvals).toHaveLength(1);

    channel.push(approval({ id: 'ask-1', status: 'approved' }));
    expect(view.snapshot().approvals).toHaveLength(0);

    view.stop();
  });

  test('a claimed ask stays on the panel: someone answering is not someone answered', async () => {
    const channel = stream();
    const view = createApprovalsView({
      verbs: verbs({ probe: { available: true }, invoke: async () => ({ approvals: [] }) }),
      localBroker: { listApprovals: () => [] },
      subscribe: channel.subscribe,
    });

    view.start();
    await settle();
    channel.push(approval({ id: 'ask-1' }));
    channel.push(approval({ id: 'ask-1', status: 'claimed', claimedBy: 'phone' }));

    const snapshot = view.snapshot();
    expect(snapshot.approvals.map((row) => row.id)).toEqual(['ask-1']);
    expect(snapshot.approvals[0]?.status).toBe('claimed');

    view.stop();
  });

  test('a stream that cannot be opened leaves the panel polling, and says so', async () => {
    const view = createApprovalsView({
      verbs: verbs({ probe: { available: true }, invoke: async () => ({ approvals: [approval({ id: 'host-1' })] }) }),
      localBroker: { listApprovals: () => [] },
      subscribe: async () => null,
    });

    view.start();
    await settle();
    const snapshot = view.snapshot();
    expect(snapshot.liveUpdates).toBe(false);
    // The fallback is the whole point: the record was still read.
    expect(snapshot.approvals.map((row) => row.id)).toEqual(['host-1']);

    view.stop();
  });

  test('a dropped stream falls back to the re-read and is reopened on the next tick', async () => {
    const channel = stream();
    const view = createApprovalsView({
      verbs: verbs({ probe: { available: true }, invoke: async () => ({ approvals: [] }) }),
      localBroker: { listApprovals: () => [] },
      subscribe: channel.subscribe,
      // Short enough that a dropped stream is retried inside this test.
      refreshIntervalMs: 5,
      liveRefreshIntervalMs: 10_000,
    });

    view.start();
    await settle();
    expect(view.snapshot().liveUpdates).toBe(true);

    channel.drop();
    expect(view.snapshot().liveUpdates).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(channel.opened()).toBeGreaterThan(1);
    expect(view.snapshot().liveUpdates).toBe(true);

    view.stop();
  });

  test('with no subscribe wired the view behaves exactly as it did before push', async () => {
    const view = createApprovalsView({
      verbs: verbs({ probe: { available: true }, invoke: async () => ({ approvals: [approval({ id: 'host-1' })] }) }),
      localBroker: { listApprovals: () => [] },
    });

    view.start();
    await settle();
    expect(view.snapshot().liveUpdates).toBe(false);
    expect(view.snapshot().approvals.map((row) => row.id)).toEqual(['host-1']);

    view.stop();
  });

  test('the apply rule, driven directly', () => {
    const rows = [approval({ id: 'a' }), approval({ id: 'b' })];
    expect(applyApprovalUpdate(rows, approval({ id: 'c' })).map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(applyApprovalUpdate(rows, approval({ id: 'b', status: 'denied' })).map((row) => row.id)).toEqual(['a']);
    // Replaced in place, so the panel's order does not jump when a row updates.
    const updated = applyApprovalUpdate(rows, approval({ id: 'a', status: 'claimed' }));
    expect(updated.map((row) => row.id)).toEqual(['a', 'b']);
    expect(updated[0]?.status).toBe('claimed');
  });
});

describe('approvals view: a stream opened after stop() is not left holding the daemon', () => {
  test('stop() during the open closes the subscription when it lands', async () => {
    type Release = (subscription: { close: () => void }) => void;
    const pending: Release[] = [];
    let closes = 0;
    const view = createApprovalsView({
      verbs: verbs({ probe: { available: true }, invoke: async () => ({ approvals: [] }) }),
      localBroker: { listApprovals: () => [] },
      subscribe: async () => await new Promise<{ close: () => void }>((resolve) => { pending.push(resolve); }),
    });

    view.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.stop();
    expect(pending).toHaveLength(1);
    pending[0]?.({ close: () => { closes += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closes).toBe(1);
    expect(view.snapshot().liveUpdates).toBe(false);
  });
});
