/**
 * rewind.ts, tolerant readers for the session rewind surface (rewind.plan / rewind.apply,
 * SDK 1.6.1). Turn anchors are derived from a session's own message list (the same
 * sessions.messages.list the detail view already loads), so a rewind targets a real turn
 * boundary the operator can recognize rather than an opaque id.
 *
 * Pure, no network, unit-testable in isolation.
 */
import { firstString } from './object';

export interface TurnAnchor {
  readonly turnId: string;
  /** A short, human label for the turn, the first non-empty message body in it. */
  readonly label: string;
}

const MAX_LABEL = 80;

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_LABEL ? `${clean.slice(0, MAX_LABEL - 1)}…` : clean;
}

/**
 * Distinct turn anchors from a session's messages, NEWEST FIRST (the most recent turn the
 * operator would rewind to leads the list), capped to `limit`. A message with no turnId is
 * skipped (it cannot anchor a rewind); a turn's label is the first non-empty message body
 * seen for it. Reversing to newest-first assumes the daemon returns messages oldest-first,
 * the shape sessions.messages.list uses.
 */
export function turnAnchorsFromMessages(items: readonly unknown[], limit = 12): TurnAnchor[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    const turnId = firstString(item, ['turnId', 'turn_id']);
    if (!turnId) continue;
    const body = firstString(item, ['body', 'content', 'text', 'message']);
    if (!seen.has(turnId)) {
      seen.set(turnId, body ? truncate(body) : '');
    } else if (!seen.get(turnId) && body) {
      seen.set(turnId, truncate(body));
    }
  }
  const anchors = Array.from(seen, ([turnId, label]) => ({ turnId, label }));
  anchors.reverse();
  return anchors.slice(0, limit);
}
