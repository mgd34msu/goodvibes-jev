/**
 * lineage.ts, the honest-lineage view model for companion chat.
 *
 * The daemon never deletes conversation history. When a response is regenerated or a
 * message is edited and the conversation branches, the affected messages are marked
 * SUPERSEDED (a `supersededAt` timestamp + a `supersededReason`) and RETAINED in the
 * message list, `companion.chat.messages.list` returns them alongside the active chain.
 * A replacement user message also carries `revisionOf` back to the original it
 * was edited from.
 *
 * This module turns that flat, server-authoritative list into a render model that keeps
 * the promise the SDK makes: the active conversation reads cleanly, and every superseded
 * message stays VIEWABLE as retained history rather than silently vanishing. Because the
 * model is derived purely from the server list (not from ephemeral client state), it
 * survives reloads and reflects exactly what the daemon retained.
 *
 * Grouping rule: a superseded message is a fork's old branch. A contiguous run of
 * superseded messages is attached to the next ACTIVE message that follows it, that
 * active message is the fork's new branch head (the regenerated response, or the edited
 * user message). The UI renders the active message normally and offers to reveal the
 * attached retained history inline.
 */

import { messageCreatedAt } from './message-utils';
import { asRecord, bestId, firstString } from '../../lib/object';
import type { ChatMessage } from './types';

export type SupersededReason = 'regenerate' | 'edit' | 'unknown';

/** True when a message is retained history behind a fork (has a supersededAt marker). */
export function isSuperseded(message: unknown): boolean {
  const value = asRecord(message).supersededAt;
  if (typeof value === 'number') return value > 0;
  // Some wire encodings send an ISO string; any non-empty string counts as "present".
  return typeof value === 'string' && value.trim().length > 0;
}

/** Why a message was superseded, read defensively from the wire record. */
export function supersededReason(message: unknown): SupersededReason {
  const raw = firstString(message, ['supersededReason']).toLowerCase();
  if (raw === 'regenerate') return 'regenerate';
  if (raw === 'edit') return 'edit';
  return 'unknown';
}

/** The id of the message this one was edited from (the forward lineage link), if any. */
export function revisionOf(message: unknown): string {
  return firstString(message, ['revisionOf']);
}

/**
 * One rendered node of the active conversation: an active message plus any retained
 * history attached to it (the superseded run immediately preceding it in the list).
 */
export interface LineageNode {
  /** The active (non-superseded) message to render as the live conversation. */
  readonly message: ChatMessage;
  /** Superseded messages retained behind the fork this node heads, oldest first. */
  readonly priorMessages: readonly ChatMessage[];
  /** Why the attached run was superseded ('regenerate' | 'edit'); undefined when none. */
  readonly reason?: SupersededReason;
  /** The original message id when this node's message replaced an edited one. */
  readonly revisionOf?: string;
}

/**
 * Build the honest-lineage render model from a server-ordered message list.
 *
 * Active messages become top-level nodes in order. A contiguous run of superseded
 * messages is buffered and attached as `priorMessages` to the next active node (the fork
 * head). A trailing superseded run with no following active message, which the daemon
 * should not produce, since a fork always ends with a new active branch, but which is
 * handled here so history is never dropped, is attached to the last active node, or, if
 * there is none, surfaced as its own history-only node so it stays viewable.
 */
export function buildLineage(messages: readonly ChatMessage[]): LineageNode[] {
  const nodes: LineageNode[] = [];
  let pending: ChatMessage[] = [];
  let pendingReason: SupersededReason | undefined;

  for (const message of messages) {
    if (isSuperseded(message)) {
      pending.push(message);
      // The reason of the run is taken from its members (they share one fork reason).
      const reason = supersededReason(message);
      if (reason !== 'unknown') pendingReason = reason;
      continue;
    }
    nodes.push({
      message,
      priorMessages: pending,
      reason: pending.length ? (pendingReason ?? 'unknown') : undefined,
      revisionOf: revisionOf(message) || undefined,
    });
    pending = [];
    pendingReason = undefined;
  }

  if (pending.length) {
    const last = nodes.at(-1);
    if (last) {
      // Merge the trailing run into the last active node so nothing is lost.
      nodes[nodes.length - 1] = {
        ...last,
        priorMessages: [...last.priorMessages, ...pending],
        reason: last.reason ?? pendingReason ?? 'unknown',
      };
    } else {
      // No active message at all, surface the retained history as its own node.
      nodes.push({
        message: pending.at(-1)!,
        priorMessages: pending.slice(0, -1),
        reason: pendingReason ?? 'unknown',
      });
    }
  }

  return nodes;
}

/**
 * Stable key for a lineage node, the message's real id alone when present, so the node
 * does NOT remount (losing any open <details> disclosure, retained-history reveal, the
 * compaction-handoff fold, or a folded tool-activity group) if the list re-renders with
 * the same message at a different array position (an optimistic-to-fetched merge can do
 * this). Falls back to an ordinal-based key, clearly shaped so it can never collide with
 * a real id, only when the message truly has none.
 */
export function lineageNodeKey(node: LineageNode, index: number): string {
  return bestId(node.message) || `node-${index}`;
}

/** A human, honest label for a retained-history run given its reason and size. */
export function retainedHistoryLabel(reason: SupersededReason | undefined, count: number): string {
  const plural = count === 1 ? '' : 's';
  if (reason === 'edit') return count <= 1 ? 'Edited: view original' : `Edited: view ${count} retained message${plural}`;
  if (reason === 'regenerate') {
    return count <= 1 ? 'Regenerated: view previous response' : `Regenerated: view ${count} previous message${plural}`;
  }
  return `View ${count} retained message${plural}`;
}

/** Order a run oldest-first defensively, in case the server list is not pre-sorted. */
export function sortByCreatedAt(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages].sort((left, right) => messageCreatedAt(left) - messageCreatedAt(right));
}
