/**
 * mail-refusal, the one place that turns an email-surface error into the honest
 * outcome the operator should read, shared by MailView, MailMessagePeek and
 * MailAccountSettings so all three say the same thing about the same failure.
 *
 * This mirrors CalendarView's `unconfiguredNote` exactly, and is extracted to a
 * module (rather than living inside the view, as calendar's does) precisely because
 * three components need it, including the settings panel, which derives its
 * ready/needs-setup status from the same classification the views render. One
 * classifier means the status pill in settings can never disagree with the note in
 * the view about the same daemon response.
 *
 * It lives in src/lib rather than src/views/mail for the same reason
 * provider-status.ts and daemon-health.ts do: it is a pure deriver over a wire
 * response with no JSX, consumed by BOTH a view and a component. Keeping it under
 * views would have made src/components/settings/MailAccountSettings the only file in
 * the repo importing upward out of src/views, a layering inversion for no gain.
 *
 * Returning `null` means "this is a genuine error", the caller falls back to a
 * plain ErrorState with a retry. That distinction is the whole point: a surface the
 * operator has not set up yet is not a fault, and must not be dressed as one.
 */
import {
  isEmailAuthFailedError,
  isEmailUnconfiguredError,
  isMethodNotInvokableError,
  isMethodUnavailableError,
} from './errors';

export type MailRefusalKind = 'not-available' | 'needs-setup' | 'auth-failed';

export interface MailRefusalNote {
  readonly kind: MailRefusalKind;
  readonly title: string;
  readonly description: string;
}

/**
 * The setup pointer sends the operator to Settings rather than offering a form
 * here, deliberately: mail credentials are daemon-owned state, written through
 * config.set so the daemon keeps using them with this browser shut and the agent
 * and the TUI see the same account. The copy follows the empty-state rule of the
 * design document: one sentence saying what is missing and what turns it on.
 */
const SETUP_POINTER = 'Add your mail account in Settings and your inbox shows up here.';

export function mailRefusalNote(error: unknown): MailRefusalNote | null {
  // Order matters: capability-absent is checked FIRST. Today every email call
  // returns 404/501 (the four verbs ship invokable:false and the daemon serves no
  // /api/email route), and telling the operator to go configure an account that
  // nothing would read yet would be a wild goose chase. Capability first, then
  // configuration, then credentials, each step only reachable once the prior one
  // is genuinely satisfied.
  if (isMethodUnavailableError(error) || isMethodNotInvokableError(error)) {
    return {
      kind: 'not-available',
      title: 'Mail isn’t available on this daemon yet',
      description: 'This daemon has no mail service yet, and updating the daemon turns it on.',
    };
  }
  if (isEmailUnconfiguredError(error)) {
    return {
      kind: 'needs-setup',
      title: 'Mail isn’t configured',
      description: SETUP_POINTER,
    };
  }
  if (isEmailAuthFailedError(error)) {
    return {
      kind: 'auth-failed',
      title: 'The mail server refused the saved password',
      description: 'Replace the app password in Settings and your inbox shows up here.',
    };
  }
  return null;
}
