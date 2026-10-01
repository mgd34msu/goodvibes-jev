/**
 * search-jump.ts, pure helpers behind ChatSearch's jump-to-message wiring.
 *
 * Kept framework-free and separate from ChatView.tsx so the two things that
 * actually needed pinning down are each independently testable without
 * mounting the whole chat view tree:
 *
 *   1. THE PASS-THROUGH, ChatSearch's onSelect payload carries both
 *      sessionId and messageId (see ChatSearch.tsx's ChatSearchSelectPayload),
 *      but session-level results legitimately carry messageId '' (no specific
 *      matched message, see ChatSearch's module doc). The bug this module
 *      fixes was ChatView destructuring only `{ sessionId }` and silently
 *      dropping messageId even for message-content results.
 *
 *   2. THE SCROLL TRIGGER, the session switch (onActiveSessionChange) and
 *      the messages fetch it kicks off are both async, so the target message
 *      may not be loaded yet on the render right after a result is selected.
 *      isScrollTargetReady is re-checked on every render as messages arrive;
 *      it only reports "ready" once the target message is actually present
 *      among the loaded ACTIVE messages for the now-active session, never a
 *      guess. A message that exists only as retained/superseded history
 *      (hidden behind the lineage disclosure, see lineage.ts) is correctly
 *      never "ready": there is nothing rendered to scroll to.
 */

import { bestId } from './message-utils';
import type { LineageNode } from './lineage';

/** A pending jump-to-message target: the session + message a search result named. */
export interface ScrollTarget {
  sessionId: string;
  messageId: string;
}

/**
 * Turn a ChatSearch onSelect payload into a ScrollTarget to arm, or null to
 * disarm any pending one. Session-level results (messageId '') never arm a
 * scroll target.
 */
export function resolveScrollTarget(payload: { sessionId: string; messageId: string }): ScrollTarget | null {
  return payload.messageId ? { sessionId: payload.sessionId, messageId: payload.messageId } : null;
}

/**
 * True once `target`'s message is present among the loaded, ACTIVE
 * (non-superseded) messages for the currently active session, i.e. it is
 * safe to look the message up in the DOM and scroll to it.
 */
export function isScrollTargetReady(
  target: ScrollTarget | null,
  activeSessionId: string,
  lineageNodes: readonly LineageNode[],
): boolean {
  if (!target) return false;
  if (target.sessionId !== activeSessionId) return false;
  return lineageNodes.some((node) => bestId(node.message) === target.messageId);
}

/** Find the rendered message element for `messageId` among `container`'s direct children. */
export function findMessageElement(
  container: Element | null | undefined,
  messageId: string,
): HTMLElement | undefined {
  if (!container) return undefined;
  return [...container.children].find(
    (child) => child.getAttribute('data-message-id') === messageId,
  ) as HTMLElement | undefined;
}
