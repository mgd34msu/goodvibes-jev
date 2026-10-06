/**
 * Process-lifecycle wiring for the TUI shell.
 *
 * Extracted from main() to keep the entrypoint under the architecture line-count
 * gate. `installProcessLifecycle` builds the terminal-restoring crash/termination
 * handlers and the graceful `exitApp` teardown, then returns them so main() can
 * register them on the exact same process/stdin/stdout listeners it used before.
 *
 * The synchronous terminal restore runs BEFORE the (possibly slow) async
 * shutdown. All asynchronous cleanup races a 3s hard timeout, the recovery
 * file is deleted only when the durable save completed,
 * signal exit codes are preserved (SIGHUP -> 129, otherwise 143; uncaught -> 1;
 * exitApp -> 0), and repeated exit requests join one teardown promise.
 *
 * Some captured values are late-bound or mutable in main(): the InputHandler, the
 * render closure, and the terminal output guard are constructed AFTER this factory
 * runs (injected as thunks), while `recoveryInterval` and `stopSpokenOutputForExit`
 * are assigned later and read at exit time (injected as getters/setter). The
 * `unsubs` registry is shared by reference and drained on exit.
 */
import { existsSync } from 'node:fs';
import { flushActivityLogSync, logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { createTerminalLifecycle, TERMINAL_ESCAPES } from '@goodvibes-jev/engine/terminal-shell';
import { formatUserFacingError } from '../core/format-user-error.ts';
import { allowTerminalWrite } from '@goodvibes-jev/engine/terminal-shell/terminal-output-guard';
import { buildPersistedSessionContext, deleteRecoveryFile } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { removeLivenessMarker } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { BootstrapContext } from './bootstrap.ts';
import type { InputHandler } from '../input/handler.ts';
import type { ConversationMessageSnapshot } from '../core/conversation.ts';

/** Shutdown grace period before the "saving session…" line prints. Below this, exit stays quiet. */
const SAVE_NOTICE_AFTER_MS = 300;
/** Hard shutdown timeout, matches the pre-existing race below (was previously an inline literal). */
const SHUTDOWN_HARD_TIMEOUT_MS = 3000;

/**
 * Whether a recovery snapshot actually exists on disk for this session. The
 * periodic autosave (see recovery-autosave.ts) only writes on a 60s tick and
 * skips empty conversations entirely, so a session that dies sooner than that
 * (or never had anything in it) has no snapshot at all, the exit receipt
 * must not claim otherwise. Never throws: a stat failure just means "absent".
 */
function defaultRecoverySnapshotExists(surface: SessionSurface, sessionId: string): boolean {
  try {
    return existsSync(surface.recoveryFile(sessionId));
  } catch {
    return false;
  }
}

/** ANSI escape sequences used by the synchronous terminal restore. */
export interface ProcessLifecycleAnsi {
  readonly CLEAR_SCREEN: string;
  readonly ALT_SCREEN_EXIT: string;
  readonly PASTE_DISABLE: string;
  readonly KEYBOARD_EXT_DISABLE: string;
  readonly MOUSE_DISABLE: string;
  readonly CURSOR_SHOW: string;
  /** Disables terminal focus-event reporting (DECSET ?1004l), see main.ts FOCUS_ENABLE. */
  readonly FOCUS_DISABLE: string;
}

export interface ProcessLifecycleDeps {
  readonly stdin: NodeJS.ReadStream;
  readonly stdout: NodeJS.WriteStream;
  readonly ctx: BootstrapContext;
  /** Mirrors cli.flags.noAltScreen: whether the alt screen is exited on restore. */
  readonly noAltScreen: boolean;
  readonly ansi: ProcessLifecycleAnsi;
  /** Late-bound: the InputHandler is constructed after this factory runs. */
  readonly getInput: () => InputHandler;
  /** Late-bound: the render closure is defined after this factory runs. */
  readonly render: () => void;
  /** Late-bound: the terminal output guard is installed after this factory runs. */
  readonly getTerminalOutputGuard: () => { readonly dispose: () => void };
  readonly getPromptContentWidth: () => number;
  readonly buildSessionContinuityHints: () => Parameters<typeof buildPersistedSessionContext>[2];
  /** Teardown registry shared with main(); drained on exit. */
  readonly unsubs: ReadonlyArray<() => void | Promise<void>>;
  readonly getRecoveryInterval: () => ReturnType<typeof setInterval> | null;
  readonly setRecoveryInterval: (value: ReturnType<typeof setInterval> | null) => void;
  readonly getStopSpokenOutputForExit: () => (() => void | Promise<void>) | null;
  /** Overridable for tests; defaults to SAVE_NOTICE_AFTER_MS (300ms). */
  readonly saveNoticeAfterMs?: number;
  /** Overridable for tests; defaults to SHUTDOWN_HARD_TIMEOUT_MS (3000ms). */
  readonly shutdownHardTimeoutMs?: number;
  /**
   * Overridable for tests; defaults to a real filesystem existence check
   * (defaultRecoverySnapshotExists). Never throws, a stat failure reads as
   * "absent" rather than taking the exit path down.
   */
  readonly recoverySnapshotExists?: (surface: SessionSurface, sessionId: string) => boolean;
}

export interface ProcessLifecycleHandlers {
  readonly exitApp: () => Promise<void>;
  readonly restoreTerminal: () => void;
  /**
   * True once restoreTerminal has run. The compositor must never write another
   * frame after this: the terminal is back on the user's primary screen, and a
   * late cursor-positioned frame (async shutdown races, stray timers) would
   * paint over shell content and strand the prompt mid-screen.
   */
  readonly isTerminalRestored: () => boolean;
  readonly resizeHandler: () => void;
  readonly sigintHandler: () => void;
  readonly unhandledRejectionHandler: (reason: unknown) => void;
  readonly uncaughtExceptionHandler: (err: Error) => void;
  readonly terminationSignalHandler: (signal: NodeJS.Signals) => void;
  readonly exitListener: () => void;
}

export function installProcessLifecycle(deps: ProcessLifecycleDeps): ProcessLifecycleHandlers {
  const {
    stdin,
    stdout,
    ctx,
    noAltScreen,
    ansi,
    getInput,
    render,
    getTerminalOutputGuard,
    getPromptContentWidth,
    buildSessionContinuityHints,
    unsubs,
    getRecoveryInterval,
    setRecoveryInterval,
    getStopSpokenOutputForExit,
    saveNoticeAfterMs = SAVE_NOTICE_AFTER_MS,
    shutdownHardTimeoutMs = SHUTDOWN_HARD_TIMEOUT_MS,
    recoverySnapshotExists = defaultRecoverySnapshotExists,
  } = deps;

  // Cleanup and its diagnostics must not prevent an independent owner from
  // releasing resources, or strand the terminal before the final process exit.
  const reportCleanupError = (phase: string, error: unknown): void => {
    const failures: unknown[] = error instanceof AggregateError ? error.errors : [error];
    for (const failure of failures) {
      try { logger.debug(`${phase} error during process cleanup (non-fatal)`, { error: summarizeError(failure) }); } catch { /* best-effort */ }
    }
  };
  const bestEffort = (phase: string, cleanup: () => void): void => {
    try { cleanup(); } catch (error) { reportCleanupError(phase, error); }
  };

  const sigintHandler = (): void => getInput().feed('\x03');
  let _unhandledRejectionCount = 0;
  let _unhandledRejectionWindowStart = Date.now();
  const unhandledRejectionHandler = (reason: unknown): void => {
    const now = Date.now();
    if (now - _unhandledRejectionWindowStart > 10000) {
      _unhandledRejectionCount = 0;
      _unhandledRejectionWindowStart = now;
    }
    _unhandledRejectionCount++;
    const msg = summarizeError(reason);
    if (_unhandledRejectionCount > 3) {
      logger.error('CRITICAL: cascading unhandled rejections; consider restarting', {
        count: _unhandledRejectionCount,
        windowMs: now - _unhandledRejectionWindowStart,
        error: String(reason),
      });
      ctx.systemMessageRouter.high(
        `[Critical] Multiple errors detected (${_unhandledRejectionCount} in 10s). If the issue persists, please restart. Latest: ${msg}`
      );
    } else {
      // Recognized kinds (auth, rate-limit, network...) keep their specific
      // line. A generic rejection used to be captioned "Provider error",
      // which sent a startup UI crash out dressed as a model-backend
      // problem. The reverse lie matters too: the classifier has no
      // 5xx rule, so a provider outage also classifies generic, and calling
      // THAT a GoodVibes bug blames us for OpenAI's downtime. The
      // discriminator is whether the reason carries provider markers
      // (provider / statusCode, which every SDK AppError sets): with them,
      // stay neutral; without them, it escaped from our own code and
      // honesty says so.
      const classified = formatUserFacingError(reason);
      let line: string;
      if (classified.kind !== 'generic') {
        line = `[Error] ${classified.message} ${classified.action}`;
      } else {
        const record = typeof reason === 'object' && reason !== null ? reason as Record<string, unknown> : {};
        const providerShaped = typeof record['provider'] === 'string' || typeof record['statusCode'] === 'number';
        line = providerShaped
          ? `[Error] Unexpected error: ${msg}. Retry your last message, or switch models with /model.`
          : `[Error] Unexpected error: ${msg}. This is a GoodVibes bug, not a provider failure; if it repeats, restart the session.`;
      }
      ctx.systemMessageRouter.high(line);
      logger.error('unhandledRejection', { error: String(reason), stack: reason instanceof Error ? reason.stack : undefined });
    }
    render();
  };
  const resizeHandler = (): void => {
    getInput().setContentWidth(getPromptContentWidth());
    ctx.compositor.resetDiff();
    render();
  };

  // Terminal enter/restore sequencing is the byte-identical seam both daemon
  // front-ends share, so it lives in @pellux/goodvibes-terminal-shell and this
  // wiring delegates to it. Only the restore path is used here (the TUI's
  // startup enter sequence stays in main.ts); the graceful shutdown below
  // (draining services, persisting sessions, exit codes) is TUI-specific and
  // stays local, calling restoreTerminal() for the synchronous hand-back.
  //
  // The injected `ansi` restore sequences are mapped onto the package's escape
  // set so the exact bytes the TUI has always emitted are preserved. The no-alt
  // exit deliberately uses the package's CLEAR_VIEWPORT_HOME ('\x1b[2J\x1b[H',
  // no ESC[3J), never ansi.CLEAR_SCREEN, which carries the scrollback-wiping 3J.
  const terminalLifecycle = createTerminalLifecycle({
    write: (data) => bestEffort('terminal restore write', () => { stdout.write(data); }),
    noAltScreen,
    guardedWrite: allowTerminalWrite,
    disposeOutputGuard: () => bestEffort('terminal output guard disposal', () => getTerminalOutputGuard().dispose()),
    setRawMode: (enabled) => bestEffort('terminal raw mode reset', () => stdin.setRawMode(enabled)),
    escapes: {
      ...TERMINAL_ESCAPES,
      ALT_SCREEN_EXIT: ansi.ALT_SCREEN_EXIT,
      PASTE_DISABLE: ansi.PASTE_DISABLE,
      KEYBOARD_EXT_DISABLE: ansi.KEYBOARD_EXT_DISABLE,
      MOUSE_DISABLE: ansi.MOUSE_DISABLE,
      CURSOR_SHOW: ansi.CURSOR_SHOW,
      FOCUS_DISABLE: ansi.FOCUS_DISABLE,
    },
  });
  // Idempotent, synchronous-only terminal restore. Safe to call from process.on('exit'),
  // signal handlers, uncaughtException, and exitApp. Disposes the output guard AFTER the
  // restore write so a crash stack reaches the real stderr instead of being suppressed.
  const restoreTerminal = (): void => {
    bestEffort('host pairing cancellation', () => getInput().hostPairing?.dispose());
    terminalLifecycle.restoreTerminal();
  };

  const uncaughtExceptionHandler = (err: Error): void => {
    restoreTerminal();
    bestEffort('uncaughtException logging', () => logger.error('uncaughtException: terminal restored, exiting', { error: summarizeError(err) }));
    // The line naming the crash is the only record of it. process.exit does not
    // drain the activity log's buffer, so it goes to disk here rather than
    // relying on the exit hook that also runs, the crash log is worth stating
    // the intent for at the site that produces it.
    bestEffort('activity log flush', flushActivityLogSync);
    process.exit(1);
  };
  const terminationSignalHandler = (signal: NodeJS.Signals): void => {
    restoreTerminal();
    bestEffort('termination signal logging', () => logger.error(`Received ${signal}: terminal restored, exiting`, {}));
    bestEffort('activity log flush', flushActivityLogSync);
    process.exit(signal === 'SIGHUP' ? 129 : 143);
  };
  const exitListener = (): void => { restoreTerminal(); };

  const performExit = async (): Promise<void> => {
    // Start each owner in order, attach rejection handlers immediately, and let
    // asynchronous drains finish together after the synchronous terminal hand-back.
    const drains: Promise<void>[] = [];
    const startCleanup = (phase: string, cleanup: () => void | Promise<void>): void => {
      try {
        drains.push(Promise.resolve(cleanup()).catch((error) => reportCleanupError(phase, error)));
      } catch (error) {
        reportCleanupError(phase, error);
      }
    };
    // Already-playing speech may finish while other cleanup proceeds; queued
    // speech is dropped by stopForExit. The shared deadline bounds every drain.
    startCleanup('spoken output drain', () => getStopSpokenOutputForExit()?.());
    unsubs.forEach((fn, index) => startCleanup(`unsubscribe ${index}`, fn));
    let interval: ReturnType<typeof setInterval> | null = null;
    bestEffort('recovery interval lookup', () => { interval = getRecoveryInterval(); });
    if (interval !== null) bestEffort('recovery interval clear', () => clearInterval(interval!));
    bestEffort('recovery interval reset', () => setRecoveryInterval(null));
    bestEffort('stdin listener removal', () => { stdin.removeAllListeners('data'); });
    bestEffort('resize listener removal', () => { stdout.removeListener('resize', resizeHandler); });
    bestEffort('SIGINT listener removal', () => { process.removeListener('SIGINT', sigintHandler); });
    bestEffort('rejection listener removal', () => { process.removeListener('unhandledRejection', unhandledRejectionHandler); });
    // Return the terminal before any asynchronous cleanup is awaited.
    restoreTerminal();
    let shutdownOk = false;
    let beforeDeadline = true;
    const saveNoticeTimer = setTimeout(() => {
      bestEffort('save progress notice', () => { stdout.write('saving session…\n'); });
    }, saveNoticeAfterMs);
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    startCleanup('ctx.shutdown', async () => {
      // If the snapshot itself fails, keep recovery rather than overwrite a
      // durable session with fabricated empty data. Optional metadata failure
      // still allows the intact conversation to reach the durable save.
      const snapshot = ctx.conversation.toJSON() as { messages: Array<ConversationMessageSnapshot>; timestamp?: number };
      let persisted: Awaited<ReturnType<typeof buildPersistedSessionContext>> = {};
      try {
        persisted = await buildPersistedSessionContext(snapshot.messages, ctx.conversation.getTitleSource(), buildSessionContinuityHints());
      } catch (error) {
        reportCleanupError('session continuity', error);
      }
      // A late metadata result must not start new shutdown work after exit.
      if (!beforeDeadline) return;
      await ctx.shutdown({ ...snapshot, ...persisted });
      shutdownOk = beforeDeadline;
    });
    try {
      await Promise.race([
        Promise.all(drains),
        new Promise<void>((resolve) => { shutdownTimer = setTimeout(resolve, shutdownHardTimeoutMs); }),
      ]);
    } finally {
      beforeDeadline = false;
      clearTimeout(saveNoticeTimer);
      clearTimeout(shutdownTimer);
    }
    // Recovery is removed only after the durable save confirms success.
    // Each finalizer is independent: a recovery or marker failure cannot skip
    // the log flush or process exit, and a logging failure cannot stop exit.
    if (shutdownOk) {
      bestEffort('recovery removal', () => deleteRecoveryFile({ surface: ctx.services.surface }, ctx.runtime.sessionId));
    } else {
      bestEffort('recovery receipt', () => {
        const kept = recoverySnapshotExists(ctx.services.surface, ctx.runtime.sessionId);
        stdout.write(kept
          ? 'exit before save completed: a recovery snapshot was kept for next launch\n'
          : 'exit before save completed: no recovery snapshot had been written yet\n');
      });
    }
    bestEffort('liveness marker removal', () => removeLivenessMarker(ctx.services.surface, ctx.runtime.sessionId));
    bestEffort('activity log flush', flushActivityLogSync);
    process.exit(0);
  };

  let exitPromise: Promise<void> | undefined;
  const exitApp = (): Promise<void> => {
    if (exitPromise) return exitPromise;
    let resolveExit!: () => void;
    let rejectExit!: (error: unknown) => void;
    // Publish ownership before invoking a cleanup callback: one can reenter
    // exitApp synchronously, and every caller must wait for this same drain.
    exitPromise = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
    void performExit().then(resolveExit, rejectExit);
    return exitPromise;
  };

  return {
    exitApp,
    restoreTerminal,
    isTerminalRestored: terminalLifecycle.isTerminalRestored,
    resizeHandler,
    sigintHandler,
    unhandledRejectionHandler,
    uncaughtExceptionHandler,
    terminationSignalHandler,
    exitListener,
  };
}
