/**
 * terminal-focus-mode.ts, DECSET ?1004h OS window-focus reporting +
 * the approval-alert wiring that consumes it.
 *
 * Extracted from main.ts (architecture line-count gate: MAX_SOURCE_LINES=800
 * in scripts/check-architecture.ts), mirrors goodvibes-tui's own precedent of
 * extracting terminal-mode literals out of its entry file (see that repo's
 * src/renderer/terminal-escapes.ts docstring). Behavior is unchanged from an
 * inline version; this is purely a line-count extraction plus the one new
 * behavior added here (the approval alert).
 *
 * FOCUS_ENABLE/FOCUS_DISABLE: sourced from terminal-escapes.ts (the
 * shared home for the DECSET ?1004 literals, its own docstring names this
 * module as the importer) and re-exported here so the focus-mode callers (main.ts and
 * the tests) keep one import site for the whole focus-mode surface. This
 * convergence was pre-ruled by the port's parity matrix: a relocation of
 * the literals, no behavior change.
 *
 * installFocusModeExitGuard(): a last-resort safety net. Node/Bun fire 'exit'
 * listeners synchronously for every process-termination path this app can
 * take, explicit process.exit() calls (normal /exit, double-Ctrl+C via
 * exitApp()) AND the default uncaughtException termination, even though
 * main.ts registers no explicit uncaughtException/SIGTERM handler of its own.
 * Named a top-5 risk in the port's parity matrix: ?1004h MUST be disabled on every exit path
 * or the user's shell inherits focus-reporting escape garbage. The write is
 * harmless even if exitApp() already disabled it moments earlier (?1004l is
 * idempotent). It is GATED on focus mode having actually been enabled
 * (markFocusModeEnabled, called at the TUI's ?1004h-enable site): only the
 * interactive TUI launch turns focus reporting on, so a blocked/scriptable
 * command (serve/status/--help/…) that exits before that must leave stdout
 * pristine, a stray ?1004l on such a command's stdout is escape garbage that
 * would, e.g., corrupt `status --json` for a machine consumer.
 *
 * wrapRequestPermissionWithApprovalAlert(): fires an unfocused-user alert the
 * moment a tool call becomes a real, user-blocking permission prompt. Ported
 * concept from goodvibes-tui's core/approval-alert.ts, scoped down: that
 * module's config-gated alert-class system (alert-gating.ts's
 * behavior.notifyOnApprovalPending / notifyOnlyWhenUnfocused settings, shared
 * with budget-breach/long-task/chain-failure notifiers) is TUI-specific
 * infrastructure the port's parity matrix does not list as a PORT item, only
 * core/focus-tracker.ts is. This is the minimal, self-contained wiring the
 * matrix's own text calls for ("route focus in/out events ... to drive
 * awaiting-approval alerts").
 *
 * Text (owner ruling 2026-09-29, SDK runtime/turn-notification.ts, the same
 * words the TUI uses): the alert names what is waiting, the command for exec,
 * the file for write and edit, the URL for fetch, and the turn that asked for
 * it. When behavior.notificationsMetadataOnly is on (default off) it carries
 * the tool name and permission category only.
 */
import { logger, notifyCompletion, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { PermissionRequestHandler, PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import {
  buildApprovalNotification,
  describeToolTarget,
  readNotificationsMetadataOnly,
  resolveTurnName,
  type ConfigGet,
} from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { FocusTracker } from '@/runtime/index.ts';

import { FOCUS_DISABLE } from '../renderer/terminal-escapes.ts';
export { FOCUS_ENABLE, FOCUS_DISABLE } from '../renderer/terminal-escapes.ts';

/**
 * notifyCompletion (SDK platform/utils) only rings the bell above 5s of
 * "duration" and only pops a desktop notification above 30s, a heuristic
 * tuned for long-running-turn notifications (ported alongside
 * goodvibes-tui's alert-gating.ts FORCE_NOTIFY_DURATION_MS). The
 * approval-alert wire is a point-in-time event with no natural duration, so
 * it passes this constant as durationMs to force both the bell and the
 * desktop popup unconditionally.
 */
export const FORCE_APPROVAL_NOTIFY_DURATION_MS = 30_001;

/**
 * Whether the TUI actually enabled OS focus reporting (DECSET ?1004h) this run.
 * Set once, at the TUI launch site that writes FOCUS_ENABLE; the process exits
 * without ever clearing it, so the teardown guard fires on every abnormal-exit
 * path once focus mode is on. Left false by every blocked/scriptable command.
 */
let focusModeEnabled = false;

/** Record that OS focus reporting was enabled; call at the same site that writes FOCUS_ENABLE. */
export function markFocusModeEnabled(): void {
  focusModeEnabled = true;
}

/**
 * Registers the process-wide ?1004h teardown safety net. Call once at startup.
 * The write only fires when focus mode was actually enabled (isFocusModeEnabled),
 * so non-TUI commands never leak ?1004l onto stdout. The predicate is injectable
 * so tests can drive both branches deterministically without module-global state.
 */
export function installFocusModeExitGuard(
  stdout: Pick<NodeJS.WriteStream, 'write'> = process.stdout,
  isFocusModeEnabled: () => boolean = () => focusModeEnabled,
): void {
  process.on('exit', () => {
    if (!isFocusModeEnabled()) return; // never enabled (blocked/scriptable command), keep stdout clean
    try { stdout.write(FOCUS_DISABLE); } catch { /* stdout may already be torn down */ }
  });
}

export interface ApprovalAlertDeps {
  readonly focusTracker: Pick<FocusTracker, 'shouldAlertWhenUnfocused'>;
  readonly notify?: typeof notifyCompletion;
  /** Config reader for behavior.notificationsMetadataOnly; absent reads as the default (off). */
  readonly configGet?: ConfigGet;
  /**
   * The live conversation, read for the name of the turn that is asking: a
   * title the user set, else the message that started this turn (the last
   * user message while a turn runs). Absent means the alert names no turn.
   */
  readonly conversation?: ApprovalTurnSource;
}

/** The conversation surface the approval alert names the turn from. */
export interface ApprovalTurnSource {
  readonly title: string;
  getTitleSource(): string;
  getLastUserMessage(): string | null;
}

/** Title and body for an approval alert (SDK buildApprovalNotification). */
export function describeApprovalAlert(request: PermissionPromptRequest, deps: Pick<ApprovalAlertDeps, 'configGet' | 'conversation'>): { title: string; body: string } {
  const metadataOnly = deps.configGet ? readNotificationsMetadataOnly(deps.configGet) : false;
  const conversation = deps.conversation;
  const titleSource = conversation?.getTitleSource();
  return buildApprovalNotification({
    tool: request.tool,
    category: request.category,
    target: metadataOnly ? null : describeToolTarget(request.args, request.analysis?.target),
    turnName: metadataOnly || !conversation ? null : resolveTurnName({
      title: conversation.title,
      titleSource: titleSource === 'user' || titleSource === 'system' ? titleSource : null,
      turnText: conversation.getLastUserMessage(),
    }),
  }, { metadataOnly });
}

/**
 * Wrap a PermissionRequestHandler so every call also fires an unfocused-user
 * alert. The wrapped handler's behavior (what it resolves to) is completely
 * unchanged, this only adds a side effect at call time, fired synchronously
 * before the wrapped promise settles (reflects "a prompt just appeared", not
 * "a prompt was just resolved").
 */
export function wrapRequestPermissionWithApprovalAlert(
  original: PermissionRequestHandler,
  deps: ApprovalAlertDeps,
): PermissionRequestHandler {
  const notify = deps.notify ?? notifyCompletion;
  return (request: PermissionPromptRequest) => {
    if (deps.focusTracker.shouldAlertWhenUnfocused()) {
      try {
        const notice = describeApprovalAlert(request, deps);
        notify(notice.title, notice.body, FORCE_APPROVAL_NOTIFY_DURATION_MS);
      } catch (err) {
        logger.debug('approval-alert: desktop notify error', { error: summarizeError(err) });
      }
    }
    return original(request);
  };
}
