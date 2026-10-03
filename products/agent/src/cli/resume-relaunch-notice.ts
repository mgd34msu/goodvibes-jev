import type { SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';

/**
 * RESUME-ON-RELAUNCH.
 *
 * The dogfood finding: relaunching the agent after a normal (non-crash) exit
 * silently starts fresh with no offer or notice about the prior session, the
 * only way back was knowing the exact `goodvibes-agent sessions resume <id>`
 * command, or digging into `/health continuity`. This module builds an
 * honest, one-line boot notice that surfaces the resume affordance without
 * ever auto-resuming or blocking startup.
 *
 * Honesty rules (never claim restorability the app can't deliver):
 *  - no last-session pointer on disk -> no notice (clean first run)
 *  - a pointer exists but the session it names is missing/unreadable (stale
 *    or dangling) -> say so plainly and point at `/session list`, never a
 *    resume action that would dead-end
 *  - a pointer exists and the session resolves -> an actionable one-liner
 *    naming the EXISTING `/session resume <id>` path (this is surfacing, not
 *    new resume logic)
 *  - never auto-resume: the user always chooses, and declining is
 *    frictionless (just start typing, the saved session stays put)
 */

/** Minimal session facts needed to render an honest resume notice. */
export interface ResumableSessionSummary {
  readonly sessionId: string;
  readonly title: string;
  readonly timestamp: number;
  readonly messageCount: number;
}

export interface ResumeRelaunchNoticeInput {
  /** The session id recorded in the last-session pointer file, or null when no pointer exists. */
  readonly pointerSessionId: string | null;
  /**
   * The resolved session the pointer refers to, or null when the pointer
   * exists but the session it names could not be found/read (stale or
   * dangling pointer).
   */
  readonly session: ResumableSessionSummary | null;
  readonly now?: number;
}

/**
 * Formats an elapsed duration the way a human would describe "how long ago".
 *
 * F4 fix: this used Math.round at every tier, which rounds UP near a
 * boundary, a session from 45 minutes ago (2,700,000ms) rounded to "1h ago"
 * (round(45/60) = 1), which reads as roughly twice as stale as it really is.
 * Every tier below now floors instead, so a duration is never described as
 * further in the past than it actually is: 45m through 59m59s all read as
 * "Nm ago", and the "1h" label only appears once a full hour has actually
 * elapsed. Minutes are floored to at least 1 once past the 45s "moments"
 * cutoff, so a duration just past that cutoff never reads as "0m ago".
 */
export function formatRelaunchAge(elapsedMs: number): string {
  const elapsed = Math.max(0, elapsedMs);
  const seconds = Math.floor(elapsed / 1000);
  if (seconds < 45) return 'moments';
  const minutes = Math.max(1, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 36) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Builds the boot-time resume notice text, or null when nothing should be
 * shown (no pointer at all, a clean first run, or the caller already routed
 * an explicit resume/onboarding command elsewhere).
 */
export function buildResumeRelaunchNotice(input: ResumeRelaunchNoticeInput): string | null {
  if (!input.pointerSessionId) return null;

  if (!input.session) {
    return [
      '[Resume] Your last session pointer is unavailable (the saved session may have been moved, renamed, or deleted).',
      '  Starting fresh. Run /session list to see any sessions that are still on disk.',
    ].join('\n');
  }

  // F5: a 0-message session has nothing to resume into, offering a resume
  // action for it is a dead-end same as a stale pointer, but less honest,
  // since the session itself does resolve. Stay silent, exactly like the
  // no-pointer (clean first run) case above, rather than dangle a resume
  // command in front of an empty conversation.
  if (input.session.messageCount <= 0) return null;

  const { session } = input;
  const age = formatRelaunchAge((input.now ?? Date.now()) - session.timestamp);
  const label = session.title.trim() || session.sessionId;
  const messageWord = session.messageCount === 1 ? 'message' : 'messages';

  return [
    `[Resume] Your last session is available: "${label}", ${age} ago, ${session.messageCount} ${messageWord}.`,
    `  Resume it: /session resume ${session.sessionId}`,
    '  Or just start typing to begin a new session, the saved one stays put.',
  ].join('\n');
}

/**
 * Resolves the pointer session id to its display facts via the existing
 * SessionManager, honestly returning null when the session is missing or
 * unreadable rather than throwing.
 */
export function resolveResumableSession(
  sessionManager: Pick<SessionManager, 'list'>,
  pointerSessionId: string,
): ResumableSessionSummary | null {
  const found = sessionManager.list().find((session) => session.name === pointerSessionId);
  if (!found) return null;
  return {
    sessionId: found.name,
    title: found.title,
    timestamp: found.timestamp,
    messageCount: found.messageCount,
  };
}

export interface SurfaceResumeRelaunchNoticeDeps {
  readonly getLastSessionPointer: () => string | null;
  /** True when a crash-recovery prompt is already showing (that flow owns its own restore path and takes priority). */
  readonly isRecoveryPending: () => boolean;
  readonly findSession: (sessionId: string) => ResumableSessionSummary | null;
  readonly print: (text: string) => void;
  readonly now?: () => number;
}

/**
 * Decides whether to surface the resume notice and prints it. Never throws,
 * never blocks startup, and never auto-resumes, the user always chooses by
 * running the printed command or by just typing to start fresh.
 */
export function surfaceResumeRelaunchNotice(deps: SurfaceResumeRelaunchNoticeDeps): void {
  try {
    if (deps.isRecoveryPending()) return;
    const pointerSessionId = deps.getLastSessionPointer();
    if (!pointerSessionId) return;
    const session = deps.findSession(pointerSessionId);
    const notice = buildResumeRelaunchNotice({
      pointerSessionId,
      session,
      now: deps.now ? deps.now() : Date.now(),
    });
    if (notice) deps.print(notice);
  } catch {
    // Never block startup on a resume-notice failure.
  }
}
