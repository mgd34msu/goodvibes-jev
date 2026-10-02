/**
 * workstream-notification.ts, the desktop notification a finished workstream
 * pushes, in words rather than identifiers.
 *
 * These three notifications used to read:
 *
 *     GoodVibes, WRFC chain failed
 *     chain 7f3a91c02b4e failed: review rejected
 *
 * A desktop notification is a message TO a person, so the standing rule applies
 * to it the same way it applies to a chat message: no internal name for the
 * machinery, and no register id. `WRFC` is the first; `7f3a91c02b4e` is the
 * second, and it is not something the reader can do anything with, it is not
 * the commit, not the branch, not the session.
 *
 * What the reader can act on is why the work stopped, so that is what the body
 * now leads with. Two workstreams that end at the same moment are told apart by
 * their reasons, which is the same principle the channel renderer follows: in
 * plain words, never by an opaque identifier.
 *
 * The title names the work (owner ruling 2026-09-29): the workstream's task,
 * trimmed at a word boundary. Unless behavior.notificationsMetadataOnly is
 * explicitly false, the task and private reason are omitted. Contract checks
 * have no numeric review score to include.
 *
 * Split out of turn-event-wiring.ts as a pure function so the text is testable
 * on its own, the wiring itself cannot be asserted against without mocking a
 * process-global notifier.
 */
import { formatTurnBudgetOutcome } from './turn-budget-outcome.ts';
import type { ContractEvent } from '@goodvibes-jev/engine/sdk/events';
import { NOTIFICATION_TEXT_LIMITS, trimAtWordBoundary, readNotificationsMetadataOnly } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';

/** Terminal facts from the public contract event vocabulary. */
export type WorkstreamFailureNarrationInput =
  | Pick<Extract<ContractEvent, { type: 'CONTRACT_FAILED' }>, 'type' | 'reason' | 'failureKind' | 'turnLimit' | 'turnLimitSource'>
  | Pick<Extract<ContractEvent, { type: 'CONTRACT_CANCELLED' }>, 'type' | 'reason' | 'filesModified'>;

/** What the host remembers about the workstream, and the privacy setting. */
export interface WorkstreamNotificationContext {
  /** The workstream's task, from CONTRACT_CREATED. */
  readonly task?: string | null | undefined;
  /** behavior.notificationsMetadataOnly */
  readonly metadataOnly?: boolean | undefined;
}

export interface WorkstreamNotification {
  readonly title: string;
  readonly body: string;
}

function titled(outcome: string, context: WorkstreamNotificationContext): string {
  const prefix = `Workstream ${outcome}: `;
  const task = readNotificationsMetadataOnly(() => context.metadataOnly) ? '' : trimAtWordBoundary(context.task ?? '', NOTIFICATION_TEXT_LIMITS.desktopTitle - prefix.length);
  return task ? `${prefix}${task}` : `GoodVibes: workstream ${outcome}`;
}

/**
 * Title and body for a workstream that reached a terminal state.
 *
 * An operator cancellation is an intended stop, not a failure, it is narrated
 * as cancelled (the reason already carries the landed-work count from the
 * workstream's edit ledger) so the notification never contradicts the cancelled
 * workstream/owner/cohort surfaces. A turn-budget exhaustion is a spent ceiling
 * rather than an infrastructure error, and its limit and source are read from
 * the typed event fields, never from a regex of the prose reason.
 */
export function workstreamFailureNotification(
  payload: WorkstreamFailureNarrationInput,
  context: WorkstreamNotificationContext = {},
): WorkstreamNotification {
  const metadataOnly = readNotificationsMetadataOnly(() => context.metadataOnly);
  if (payload.type === 'CONTRACT_CANCELLED') {
    return {
      title: titled('cancelled', context),
      body: metadataOnly ? 'Cancelled' : `Cancelled: ${payload.reason}`,
    };
  }
  if (payload.failureKind === 'max_turns') {
    return {
      title: titled('hit its turn budget', context),
      body: `The workstream ${formatTurnBudgetOutcome({ limit: payload.turnLimit, source: payload.turnLimitSource })}`,
    };
  }
  const reason = payload.failureKind === 'transport' ? 'transient transport error' : metadataOnly ? '' : payload.reason;
  return {
    title: titled('failed', context),
    body: metadataOnly ? (payload.failureKind === 'transport' ? `Failed: ${reason}` : 'Failed') : `Failed: ${reason}`,
  };
}
