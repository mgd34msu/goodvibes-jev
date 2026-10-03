// ---------------------------------------------------------------------------
// conversation-rewind-port.ts, this Agent's ConversationManager as the SDK
// unified rewind service's RewindConversationPort.
//
// The SDK's UnifiedRewindService (platform/rewind) joins files rewind (workspace
// checkpoints) with conversation rewind through two ports. The conversation port
// is "a daemon-hosted mutable conversation store": preview() reports how many
// messages would truncate to a recorded turn boundary, and rewind() performs the
// truncation and captures the pre-/post-truncation snapshots so the reversal can
// be undone and re-applied. The truncation boundary is the message count recorded
// for the anchor's turnId at TURN_COMPLETED (the SDK's platform/rewind anchor
// registry), the same
// join key files rewind uses against the workspace checkpoint.
//
// Ported from goodvibes-tui's src/runtime/conversation-rewind-port.ts (same
// port shape, same registry pattern) so the two front-ends' rewind semantics
// cannot drift. This Agent has no in-process /rewind command today (see
// src/test/daemon/gateway-rewind-conversation-scope.test.ts for the honesty
// note on that), so the only consumer of this port here is the composed
// daemon's rewind.plan/apply verbs, resolving the live conversation per
// anchor.sessionId from the registry below.
// ---------------------------------------------------------------------------

import type {
  RewindAnchor,
  RewindConversationOutcome,
  RewindConversationPort,
  RewindConversationPreview,
} from '@goodvibes-jev/engine/sdk/platform/rewind';
import type { ConversationManager } from '../core/conversation.ts';
import { resolveTurnAnchor } from '@goodvibes-jev/engine/sdk/platform/rewind';

type ConversationJson = Parameters<ConversationManager['fromJSON']>[0];

/** The port plus the reversal accessors an in-process undo/redo surface would need. */
export interface ConversationRewindPort extends RewindConversationPort {
  /** Restore the pre-truncation conversation (the undo direction). */
  restoreBefore(undoSnapshotId: string): boolean;
  /** Restore the post-truncation conversation (the redo direction). */
  restoreAfter(undoSnapshotId: string): boolean;
}

/** One truncation's captured state, the target conversation and its snapshots. */
interface SnapshotPair {
  readonly conv: ConversationManager;
  readonly before: ConversationJson;
  readonly after: ConversationJson;
}

/**
 * Build a conversation rewind port. `resolveConversation` maps an anchor's
 * sessionId to the live ConversationManager, for this Agent (a single-session
 * process) that is the one bound conversation when the sessionId matches, and
 * null otherwise. A null resolution means no live conversation for that
 * session, reported as "nothing to drop" rather than a fabricated count.
 */
export function createConversationRewindPort(
  resolveConversation: (sessionId: string) => ConversationManager | null,
): ConversationRewindPort {
  const snapshots = new Map<string, SnapshotPair>();

  function keepFor(anchor: RewindAnchor): { conv: ConversationManager | null; keep: number; total: number } {
    const conv = resolveConversation(anchor.sessionId);
    if (!conv) return { conv: null, keep: 0, total: 0 };
    const total = conv.getMessageCount();
    const rec = anchor.turnId ? resolveTurnAnchor(anchor.sessionId, anchor.turnId) : null;
    const keep = rec ? Math.min(rec.messageCount, total) : total;
    return { conv, keep, total };
  }

  function restore(snapshot: SnapshotPair | undefined, which: 'before' | 'after'): boolean {
    if (!snapshot) return false;
    snapshot.conv.fromJSON(snapshot[which]);
    snapshot.conv.rebuildHistory();
    return true;
  }

  return {
    async preview(anchor: RewindAnchor): Promise<RewindConversationPreview> {
      const { keep, total } = keepFor(anchor);
      return { messagesToDrop: Math.max(0, total - keep), messagesRemaining: keep };
    },

    async rewind(anchor: RewindAnchor): Promise<RewindConversationOutcome> {
      const { conv, keep, total } = keepFor(anchor);
      const undoSnapshotId = `rwc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      if (!conv) return { droppedMessages: 0, undoSnapshotId };
      const before = conv.toJSON() as ConversationJson;
      conv.removeMessagesAfter(keep);
      conv.rebuildHistory();
      const after = conv.toJSON() as ConversationJson;
      snapshots.set(undoSnapshotId, { conv, before, after });
      return { droppedMessages: Math.max(0, total - keep), undoSnapshotId };
    },

    restoreBefore(undoSnapshotId: string): boolean {
      return restore(snapshots.get(undoSnapshotId), 'before');
    },

    restoreAfter(undoSnapshotId: string): boolean {
      return restore(snapshots.get(undoSnapshotId), 'after');
    },
  };
}

// ---------------------------------------------------------------------------
// Live per-session conversation registry, the daemon-hosted mutable store the
// composed daemon's rewind.plan/apply verbs resolve conversations from. This
// Agent registers its active session's ConversationManager at bootstrap; a
// session with no registration reports conversation rewind as "nothing to
// drop".
// ---------------------------------------------------------------------------

const liveConversations = new Map<string, ConversationManager>();

/** Register a session's live conversation so the daemon rewind verbs can serve it. */
export function registerSessionConversation(sessionId: string, conversation: ConversationManager): void {
  if (sessionId) liveConversations.set(sessionId, conversation);
}

/** Drop a session's conversation registration. */
export function unregisterSessionConversation(sessionId: string): void {
  liveConversations.delete(sessionId);
}

/**
 * The conversation registered for a session id, or null.
 *
 * A reader over the SAME map the rewind port resolves through, exported here
 * rather than rebuilt beside it: a second registry would let a daemon push land
 * in one conversation while a rewind truncated another. The push destination
 * (runtime/agent-conversation-sender.ts) is the second consumer, it addresses a
 * message by the conversation or session the daemon named, and falls back to the
 * primary conversation when it named neither.
 */
export function findSessionConversation(sessionId: string): ConversationManager | null {
  if (!sessionId) return null;
  return liveConversations.get(sessionId) ?? null;
}

/**
 * The conversation rewind port the composed daemon threads into
 * registerGatewayVerbGroups, it resolves each anchor's live conversation from
 * the registry above, so the daemon's own rewind verbs serve conversation scope
 * live in this process.
 */
export function createSessionConversationRewindPort(): ConversationRewindPort {
  return createConversationRewindPort((sessionId) => liveConversations.get(sessionId) ?? null);
}
