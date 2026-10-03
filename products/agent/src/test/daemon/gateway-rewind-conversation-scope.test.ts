/**
 * Conversation scope of the unified rewind (rewind.plan/apply), Task 3 of the
 * release-train adoption sweep (CONVERSATION REWIND PORT).
 *
 * This Agent DOES have a genuine in-process mutable conversation store, its
 * own ConversationManager (src/core/conversation.ts, extends the SDK's shared
 * base class exactly like goodvibes-tui's), the shape RewindConversationPort
 * assumes ("a daemon-hosted mutable conversation store"). It is not
 * channel-scoped or otherwise unrewindable: one process, one live
 * conversation, registered at bootstrap (see bootstrap-core.ts's
 * registerSessionConversation call and services.ts's conversationRewindPort
 * wiring), against the same seam
 * (src/runtime/conversation-rewind-port.ts here mirrors the TUI's file of the
 * same name so rewind truncation semantics cannot drift between the two
 * front-ends).
 *
 * These tests prove the port is threaded LIVE through the composed daemon
 * (real gatewayMethods.invoke('rewind.plan'/'rewind.apply') calls), not just
 * unit-tested in isolation, registering a real ConversationManager,
 * completing a "turn" (recordTurnAnchor, the same call bootstrap.ts's
 * TURN_COMPLETED handler makes), then rewinding to that anchor and observing
 * the conversation actually truncate.
 *
 * ── Whose composition this drives ────────────────────────────────────────
 *
 * `buildDaemonGatewayCatalog(services)` builds the catalog THE DAEMON composes
 * over this graph. The Agent's own `services.gatewayMethods` carries no handler
 * for any of these, which is itself pinned in
 * daemon/gateway-ws-only-invokable.test.ts.
 *
 * These verbs are served to every surface by one process, and this suite is
 * where the contract THIS surface depends on stays honest. Driving it through
 * the daemon's composition is the difference between verifying a contract and
 * asserting that a client answers its own question.
 */
import { describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation.ts';
import { recordTurnAnchor } from '@goodvibes-jev/engine/sdk/platform/rewind';
import { registerSessionConversation, unregisterSessionConversation } from '../../runtime/conversation-rewind-port.ts';
import { getTestRuntimeServices } from '../helpers/runtime-services.ts';
import { buildDaemonGatewayCatalog } from '../helpers/daemon-gateway.ts';

interface RewindPlanResult {
  readonly sessionId: string;
  readonly turnId: string | null;
  readonly scope: string;
  readonly token: string;
  readonly conversation: { readonly available: boolean; readonly messagesToDrop: number; readonly messagesRemaining: number } | null;
  readonly warnings: readonly string[];
}

interface RewindApplyResult {
  readonly receipt: {
    readonly conversation: { readonly rewound: boolean; readonly droppedMessages: number; readonly undoSnapshotId: string | null } | null;
  } | null;
  readonly refused: boolean;
}

describe('rewind.plan/apply conversation scope (live conversationRewindPort, SDK 1.6.1)', () => {
  test('rewind.plan reports the conversation store as available (a real port is wired) but nothing to drop for an unregistered session', async () => {
    const services = getTestRuntimeServices();
    const result = await buildDaemonGatewayCatalog(services).invoke('rewind.plan', {
      methodId: 'rewind.plan',
      body: { sessionId: 'no-such-session-ever-registered', scope: 'conversation' },
    } as never) as RewindPlanResult;

    // available:true reflects "a conversation store IS wired on this
    // runtime" (see the SDK's UnifiedRewindService.plan), not "this session
    // has messages", the port genuinely resolves this unregistered session
    // to null and honestly reports zero rather than fabricating a count.
    expect(result.conversation?.available).toBe(true);
    expect(result.conversation?.messagesToDrop).toBe(0);
    expect(result.conversation?.messagesRemaining).toBe(0);
  });

  test('rewind.plan then rewind.apply truncates a real registered conversation to a recorded turn anchor', async () => {
    const services = getTestRuntimeServices();
    const sessionId = `gateway-rewind-conversation-scope-${Date.now()}`;
    const conversation = new ConversationManager(() => 80);

    try {
      conversation.addUserMessage('first turn prompt');
      conversation.addAssistantMessage('first turn reply');
      const turn1MessageCount = conversation.getMessageCount();
      recordTurnAnchor(sessionId, {
        turnId: 'turn-1',
        label: 'first turn prompt',
        messageCount: turn1MessageCount,
        at: Date.now(),
      });

      conversation.addUserMessage('second turn prompt');
      conversation.addAssistantMessage('second turn reply');
      expect(conversation.getMessageCount()).toBeGreaterThan(turn1MessageCount);

      registerSessionConversation(sessionId, conversation);

      const plan = await buildDaemonGatewayCatalog(services).invoke('rewind.plan', {
        methodId: 'rewind.plan',
        body: { sessionId, turnId: 'turn-1', scope: 'conversation' },
      } as never) as RewindPlanResult;

      expect(plan.conversation).toBeTruthy();
      expect(plan.conversation?.available).toBe(true);
      expect(plan.conversation?.messagesRemaining).toBe(turn1MessageCount);
      expect(plan.conversation?.messagesToDrop).toBeGreaterThan(0);
      expect(plan.token).toBeTruthy();

      const applied = await buildDaemonGatewayCatalog(services).invoke('rewind.apply', {
        methodId: 'rewind.apply',
        body: { sessionId, turnId: 'turn-1', scope: 'conversation', confirm: true, token: plan.token },
      } as never) as RewindApplyResult;

      expect(applied.refused).toBe(false);
      expect(applied.receipt?.conversation?.rewound).toBe(true);
      expect(applied.receipt?.conversation?.droppedMessages).toBeGreaterThan(0);
      expect(applied.receipt?.conversation?.undoSnapshotId).toBeTruthy();

      // The real registered conversation object was actually truncated, not
      // just a reported count, proves the port is live, not a stub.
      expect(conversation.getMessageCount()).toBe(turn1MessageCount);
    } finally {
      unregisterSessionConversation(sessionId);
    }
  });

  test('rewind.apply without confirm refuses rather than fabricating a truncation', async () => {
    const services = getTestRuntimeServices();
    const sessionId = `gateway-rewind-conversation-scope-refuse-${Date.now()}`;
    const conversation = new ConversationManager(() => 80);

    try {
      conversation.addUserMessage('only turn');
      conversation.addAssistantMessage('only reply');
      recordTurnAnchor(sessionId, { turnId: 'turn-1', label: 'only turn', messageCount: conversation.getMessageCount(), at: Date.now() });
      registerSessionConversation(sessionId, conversation);

      const applied = await buildDaemonGatewayCatalog(services).invoke('rewind.apply', {
        methodId: 'rewind.apply',
        body: { sessionId, turnId: 'turn-1', scope: 'conversation' },
      } as never) as RewindApplyResult;

      expect(applied.refused).toBe(true);
      expect(applied.receipt).toBeNull();
    } finally {
      unregisterSessionConversation(sessionId);
    }
  });
});
