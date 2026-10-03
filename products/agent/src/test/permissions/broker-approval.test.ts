import { describe, expect, test } from 'bun:test';
import { ApprovalBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { PermissionPromptDecision } from '@goodvibes-jev/engine/sdk/platform/permissions';
import {
  handleBrokerApprovalChange,
  type BrokerApprovalBroker,
} from '../../permissions/broker-approval.ts';
import type { PendingPermissionState } from '../../shell/blocking-input.ts';

function makeRequest(callId: string, tool = 'exec') {
  return {
    callId,
    tool,
    args: {},
    category: 'execute',
    analysis: {
      classification: tool,
      riskLevel: 'medium',
      summary: `Review ${tool} request`,
      reasons: ['Inspect the target and intent before approving this action.'],
    },
  } as never;
}

/** Narrow fake broker for the pure-reducer tests (mirrors the TUI's equivalent fixture). */
function makeFakeBroker(records: Record<string, { status: string; request: unknown }>): BrokerApprovalBroker & {
  resolved: Array<{ id: string; approved: boolean; actor: string }>;
} {
  const resolved: Array<{ id: string; approved: boolean; actor: string }> = [];
  return {
    resolved,
    getApproval: (id: string) => (records[id] as never) ?? null,
    resolveApproval: async (id: string, input: { readonly approved: boolean; readonly actor: string }) => {
      resolved.push({ id, approved: input.approved, actor: input.actor });
      return null;
    },
  } as never;
}

describe('permissions/broker-approval: pure reducer (fake broker)', () => {
  test('a broker-originated ask with no local prompt opens a card built from broker state', () => {
    let pending: PendingPermissionState | null = null;
    let renders = 0;
    const broker = makeFakeBroker({ 'ap-1': { status: 'pending', request: makeRequest('call-1') } });

    handleBrokerApprovalChange({
      approval: { id: 'ap-1', callId: 'call-1', status: 'pending', request: makeRequest('call-1') },
      getPending: () => pending,
      setPending: (next) => { pending = next; },
      broker,
      render: () => { renders += 1; },
      defer: (cb) => cb(),
    });

    expect(pending).not.toBeNull();
    expect(pending!.callId).toBe('call-1');
    expect(renders).toBe(1);
  });

  test('approving the card resolves the broker record as approved with actor "agent"', () => {
    let pending: PendingPermissionState | null = null;
    const broker = makeFakeBroker({ 'ap-1': { status: 'pending', request: makeRequest('call-1') } });

    handleBrokerApprovalChange({
      approval: { id: 'ap-1', callId: 'call-1', status: 'pending', request: makeRequest('call-1') },
      getPending: () => pending, setPending: (next) => { pending = next; },
      broker, render: () => {}, defer: (cb) => cb(),
    });

    pending!.resolve(true, false);
    expect(broker.resolved).toEqual([{ id: 'ap-1', approved: true, actor: 'agent' }]);
  });

  test('denying the card resolves the broker record as denied', () => {
    let pending: PendingPermissionState | null = null;
    const broker = makeFakeBroker({ 'ap-1': { status: 'pending', request: makeRequest('call-1') } });

    handleBrokerApprovalChange({
      approval: { id: 'ap-1', callId: 'call-1', status: 'pending', request: makeRequest('call-1') },
      getPending: () => pending, setPending: (next) => { pending = next; },
      broker, render: () => {}, defer: (cb) => cb(),
    });

    pending!.resolve(false, false);
    expect(broker.resolved).toEqual([{ id: 'ap-1', approved: false, actor: 'agent' }]);
  });

  test('does not double-open when a card is already up for the same call', () => {
    const localCard = { callId: 'call-2' } as PendingPermissionState;
    let pending: PendingPermissionState | null = localCard;
    const broker = makeFakeBroker({ 'ap-2': { status: 'pending', request: makeRequest('call-2') } });

    handleBrokerApprovalChange({
      approval: { id: 'ap-2', callId: 'call-2', status: 'pending', request: makeRequest('call-2') },
      getPending: () => pending, setPending: (next) => { pending = next; },
      broker, render: () => {}, defer: (cb) => cb(),
    });

    expect(pending).toBe(localCard);
  });

  test('clears the active card once its approval resolves elsewhere (no stale prompt)', () => {
    const card = { callId: 'call-3' } as PendingPermissionState;
    let pending: PendingPermissionState | null = card;
    let renders = 0;
    const broker = makeFakeBroker({});

    handleBrokerApprovalChange({
      approval: { id: 'ap-3', callId: 'call-3', status: 'approved', request: makeRequest('call-3') },
      getPending: () => pending, setPending: (next) => { pending = next; },
      broker, render: () => { renders += 1; }, defer: (cb) => cb(),
    });

    expect(pending).toBeNull();
    expect(renders).toBe(1);
  });

  test('clears the active card once it expires (no stale prompt after timeout)', () => {
    const card = { callId: 'call-5' } as PendingPermissionState;
    let pending: PendingPermissionState | null = card;
    const broker = makeFakeBroker({});

    handleBrokerApprovalChange({
      approval: { id: 'ap-5', callId: 'call-5', status: 'expired', request: makeRequest('call-5') },
      getPending: () => pending, setPending: (next) => { pending = next; },
      broker, render: () => {}, defer: (cb) => cb(),
    });

    expect(pending).toBeNull();
  });

  test('a resolved ask that is not the active card is ignored', () => {
    const card = { callId: 'call-4' } as PendingPermissionState;
    let pending: PendingPermissionState | null = card;
    const broker = makeFakeBroker({});

    handleBrokerApprovalChange({
      approval: { id: 'ap-x', callId: 'other-call', status: 'approved', request: makeRequest('other-call') },
      getPending: () => pending, setPending: (next) => { pending = next; },
      broker, render: () => {}, defer: (cb) => cb(),
    });

    expect(pending).toBe(card);
  });

  test('a claimed (not yet resolved) ask is still active and does not clear the card', () => {
    const card = { callId: 'call-6' } as PendingPermissionState;
    let pending: PendingPermissionState | null = card;
    const broker = makeFakeBroker({});

    handleBrokerApprovalChange({
      approval: { id: 'ap-6', callId: 'call-6', status: 'claimed', request: makeRequest('call-6') },
      getPending: () => pending, setPending: (next) => { pending = next; },
      broker, render: () => {}, defer: (cb) => cb(),
    });

    expect(pending).toBe(card);
  });
});

/**
 * A plain mutable holder for the pending card, mirroring how main.ts's own
 * `permissionPromptRef`-style refs work in production. Used instead of a bare
 * `let` here so reads after an async/closure boundary see the CURRENT value
 * rather than TypeScript's control-flow-narrowed type at the point the
 * variable was last assigned in this lexical scope.
 */
function makePendingRef(): { current: PendingPermissionState | null } {
  return { current: null };
}

/**
 * A one-shot "it happened" latch. ApprovalBroker.requestApproval is itself
 * async (it awaits its own store load/persist before publishing), so a card
 * opening as a REAL broker's side effect is never observable synchronously
 * right after calling requestApproval, these tests await this latch instead
 * of guessing a tick count.
 */
function makeLatch(): { promise: Promise<void>; signal: () => void } {
  let signalFn!: () => void;
  const promise = new Promise<void>((resolve) => { signalFn = resolve; });
  return { promise, signal: signalFn };
}

describe('permissions/broker-approval: real ApprovalBroker (in-memory)', () => {
  test('a broker approval raised with no local prompt (a daemon/other-surface ask) appears in the agent surface', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    const pendingRef = makePendingRef();
    const opened = makeLatch();
    let renders = 0;
    broker.subscribe((approval) => handleBrokerApprovalChange({
      approval, broker,
      render: () => { renders += 1; opened.signal(); },
      getPending: () => pendingRef.current,
      setPending: (next) => { pendingRef.current = next; },
      defer: (cb) => cb(), // synchronous re-check; the broker's own publish is still async
    }));

    // No `localPrompt`, this is exactly how an ask raised by another surface
    // (or a daemon-side subsystem) against this same broker instance looks:
    // nothing in THIS process opens a card for it automatically.
    const decisionPromise = broker.requestApproval({
      request: makeRequest('call-remote'),
      sessionId: 'sess-1',
    });

    await opened.promise;
    const card = pendingRef.current;
    if (card === null) throw new Error('expected a broker-originated card to open');
    expect(card.callId).toBe('call-remote');
    expect(renders).toBeGreaterThan(0);

    // Answering from the agent resolves the real broker record.
    card.resolve(true, false);
    const decision: PermissionPromptDecision = await decisionPromise;
    expect(decision.approved).toBe(true);
    expect(broker.getApproval(broker.listApprovals()[0]!.id)?.status).toBe('approved');
  });

  test('approving from the agent resolves the broker record as approved', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    const pendingRef = makePendingRef();
    const opened = makeLatch();
    broker.subscribe((approval) => handleBrokerApprovalChange({
      approval, broker, render: () => { opened.signal(); },
      getPending: () => pendingRef.current, setPending: (next) => { pendingRef.current = next; },
      defer: (cb) => cb(),
    }));

    void broker.requestApproval({ request: makeRequest('call-approve'), sessionId: 'sess-2' });
    await opened.promise;
    const approvalId = broker.listApprovals().find((a) => a.callId === 'call-approve')!.id;

    const card = pendingRef.current;
    if (card === null) throw new Error('expected a card to open');
    card.resolve(true, false);
    // Allow the broker's own resolveApproval promise chain to settle.
    await Promise.resolve();
    expect(broker.getApproval(approvalId)?.status).toBe('approved');
  });

  test('denying from the agent resolves the broker record as denied', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    const pendingRef = makePendingRef();
    const opened = makeLatch();
    broker.subscribe((approval) => handleBrokerApprovalChange({
      approval, broker, render: () => { opened.signal(); },
      getPending: () => pendingRef.current, setPending: (next) => { pendingRef.current = next; },
      defer: (cb) => cb(),
    }));

    void broker.requestApproval({ request: makeRequest('call-deny'), sessionId: 'sess-3' });
    await opened.promise;
    const approvalId = broker.listApprovals().find((a) => a.callId === 'call-deny')!.id;

    const card = pendingRef.current;
    if (card === null) throw new Error('expected a card to open');
    card.resolve(false, false);
    await Promise.resolve();
    expect(broker.getApproval(approvalId)?.status).toBe('denied');
  });

  test('an approval resolved on another surface is removed from the agent UI (no stale prompt)', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    const pendingRef = makePendingRef();
    const opened = makeLatch();
    let renders = 0;
    broker.subscribe((approval) => handleBrokerApprovalChange({
      approval, broker, render: () => { renders += 1; opened.signal(); },
      getPending: () => pendingRef.current, setPending: (next) => { pendingRef.current = next; },
      defer: (cb) => cb(),
    }));

    void broker.requestApproval({ request: makeRequest('call-elsewhere'), sessionId: 'sess-4' });
    await opened.promise;
    expect(pendingRef.current).not.toBeNull();
    const approvalId = broker.listApprovals().find((a) => a.callId === 'call-elsewhere')!.id;

    // Another surface (webui, a channel like Telegram via approval-reply.ts)
    // resolves the SAME record directly through the broker, never through
    // this agent's card.
    await broker.resolveApproval(approvalId, { approved: true, actor: 'operator', actorSurface: 'webui' });

    expect(pendingRef.current).toBeNull();
    expect(renders).toBeGreaterThan(1);
  });

  test('an approval that expires is removed from the agent UI (no stale prompt)', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    const pendingRef = makePendingRef();
    const opened = makeLatch();
    broker.subscribe((approval) => handleBrokerApprovalChange({
      approval, broker, render: () => { opened.signal(); },
      getPending: () => pendingRef.current, setPending: (next) => { pendingRef.current = next; },
      defer: (cb) => cb(),
    }));

    const decisionPromise = broker.requestApproval({
      request: makeRequest('call-expire'),
      sessionId: 'sess-5',
      timeoutMs: 10,
    });
    await opened.promise;
    expect(pendingRef.current).not.toBeNull();

    const decision = await decisionPromise;
    expect(decision.approved).toBe(false);
    expect(pendingRef.current).toBeNull();
  });

  test('the existing local permission-prompt path is unaffected: a local ask opens exactly one card, never a duplicate broker card', async () => {
    const broker = new ApprovalBroker({ storePath: ':memory:' });
    const pendingRef = makePendingRef();
    const localOpened = makeLatch();
    // Real default (microtask) defer here, exactly like main.ts's production
    // subscription, this is the race the module's doc comment describes: the
    // broker calls localPrompt AFTER it publishes, so the deferred broker-card
    // open must see the local card already in place and no-op.
    broker.subscribe((approval) => handleBrokerApprovalChange({
      approval, broker, render: () => {},
      getPending: () => pendingRef.current, setPending: (next) => { pendingRef.current = next; },
    }));

    // Mirrors main.ts's rawRequestPermission: sets the SAME ref the broker
    // subscription reads, synchronously (relative to the broker's publish),
    // inside the Promise executor.
    const localPrompt = (request: Parameters<typeof broker.requestApproval>[0]['request']) => new Promise<PermissionPromptDecision>((resolve) => {
      pendingRef.current = {
        ...request,
        resolve: (approved: boolean, remember = false) => resolve({ approved, remember }),
      } as PendingPermissionState;
      localOpened.signal();
    });

    const decisionPromise = broker.requestApproval({
      request: makeRequest('call-local'),
      sessionId: 'sess-6',
      localPrompt,
    });

    await localOpened.promise;
    const localCard = pendingRef.current;
    if (localCard === null) throw new Error('expected a local card to be open');
    expect(localCard.callId).toBe('call-local');

    // Let the broker's deferred (queueMicrotask) broker-card open re-check run.
    await Promise.resolve();
    await Promise.resolve();

    // Still exactly the local card, no second/replacement card was opened.
    expect(pendingRef.current).toBe(localCard);

    localCard.resolve(true, false);
    const decision = await decisionPromise;
    expect(decision.approved).toBe(true);
  });
});
