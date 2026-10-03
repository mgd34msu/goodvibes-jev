/**
 * process-fault-capture.ts, what the agent leaves behind when it dies.
 *
 * Why this exists: the agent died on an uncaught exception and the stack
 * existed ONLY on the operator's terminal. The activity log had nothing, no
 * crash file was written, and the stack was recovered afterwards purely because
 * a terminal pane happened to have been captured. Before this module the
 * process registered NO `uncaughtException` handler at all (see
 * shell/terminal-focus-mode.ts, which documents relying on Node's default
 * termination), so the one path that actually kills the agent was also the one
 * path that recorded nothing.
 *
 * What it guarantees, in this order, on the way out:
 *   1. a durable crash record, stack, version, pid, active session id,
 *      timestamp, in the bounded crash log under the surface root;
 *   2. a line in the shared activity log, flushed SYNCHRONOUSLY (the logger
 *      batches on a timer that a dying process never reaches);
 *   3. a descriptor write to stderr, which the full-screen output guard cannot
 *      intercept, so the operator sees it even mid-TUI;
 *   4. only then, the exit.
 *
 * Ordering is deliberate and matches cli/tui-startup.ts's fatal-boot path: the
 * cheapest, most durable sink goes first, because each later step is one more
 * chance to fail before anything has landed.
 *
 * `unhandledRejection` keeps its existing non-fatal behaviour, it notifies and
 * the process survives, but now also leaves a crash record, because "the agent
 * misbehaved but stayed up" was equally invisible after the fact.
 *
 * WHERE THE RECORD LOGIC LIVES: in the SDK
 * (platform/runtime/crash-capture.ts, reached through
 * platform/runtime/operations), which is also where the append-only retention
 * registry knows about it, so the platform janitor bounds the file by age and
 * total size for every surface rather than only by the record count enforced on
 * write. The agent carried its own copy of the builder, reader and bounded
 * appender for exactly one release, the SDK export was not published yet and
 * the agent needed to stop dying silently that day, and this file now imports
 * the canonical one. The shapes and the caps were written to match, so this is
 * a substitution, not a behaviour change. What stays here is the wiring: which
 * handlers get registered, what the agent writes to stderr on the way out, and
 * the order the three sinks are attempted in.
 */
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  appendCrashRecord,
  buildCrashRecord,
  CRASH_LOG_FILENAME,
} from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { createUnhandledRejectionHandler } from './unhandled-rejection-guard.ts';
import { writeFatalLine } from '../utils/fatal-boot-write.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { VERSION } from '../version.ts';

export interface ProcessFaultCaptureDeps {
  /** Surface a high-priority message in the running UI. */
  readonly notifyHigh: (message: string) => void;
  /** Repaint after a non-fatal fault notice. */
  readonly render: () => void;
  /** Resolves the home-anchored surface path for the crash log. */
  readonly shellPaths: { resolveUserPath: (...segments: string[]) => string };
  /** Read at fault time, not at install time, the active session changes. */
  readonly activeSessionId: () => string | null;
  /** Injectable for tests; defaults to the real process exit. */
  readonly exit?: (code: number) => void;
  /** Injectable for tests; defaults to the guaranteed descriptor write. */
  readonly writeStderr?: (line: string) => void;
}

/** Installed handlers, with the registration and teardown the caller drives. */
export interface ProcessFaultCapture {
  /** Register both process-level listeners. */
  register(): void;
  /** Remove both listeners, called from the orderly exit path. */
  dispose(): void;
  /**
   * Record a fault without registering anything. Exposed so a test can drive
   * the exact write path the handlers use.
   */
  capture(kind: 'uncaughtException' | 'unhandledRejection', thrown: unknown): void;
}

export function createProcessFaultHandlers(deps: ProcessFaultCaptureDeps): ProcessFaultCapture {
  const onUnhandledRejectionNotice = createUnhandledRejectionHandler({
    notifyHigh: deps.notifyHigh,
    render: deps.render,
  });
  const exit = deps.exit ?? ((code: number): void => { process.exit(code); });
  const writeStderr = deps.writeStderr ?? writeFatalLine;
  const crashLogPath = deps.shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, CRASH_LOG_FILENAME);

  const capture = (kind: 'uncaughtException' | 'unhandledRejection', thrown: unknown): void => {
    let sessionId: string | null = null;
    try {
      sessionId = deps.activeSessionId();
    } catch {
      // A broken accessor must not cost us the whole record.
    }
    const record = buildCrashRecord(kind, thrown, {
      version: VERSION,
      surface: GOODVIBES_AGENT_SURFACE_ROOT,
      sessionId,
    });
    try {
      appendCrashRecord(crashLogPath, record);
    } catch {
      // appendCrashRecord is already best-effort; belt and braces so a failure
      // here can never prevent the activity-log line and the stderr write.
    }
    try {
      logger.error(`[crash] ${kind}`, {
        message: record.message,
        version: record.version,
        pid: record.pid,
        sessionId: record.sessionId ?? '(none)',
        timestamp: record.timestamp,
        crashLog: crashLogPath,
        ...(record.stack ? { stack: record.stack } : {}),
      });
      // The logger batches on a timer this process will not live to see.
      logger.flushSync();
    } catch {
      // Nothing left to do about a logger that cannot write.
    }
  };

  const onUncaughtException = (error: unknown): void => {
    capture('uncaughtException', error);
    try {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      // A descriptor write cannot be intercepted by the full-screen output
      // guard, which replaces process.stderr.write while the TUI is up.
      writeStderr(`goodvibes-agent crashed: ${message}`);
      writeStderr(`crash record written to ${crashLogPath}`);
    } catch {
      // The record already landed; the console line is the expendable part.
    }
    exit(1);
  };

  const onUnhandledRejection = (reason: unknown): void => {
    capture('unhandledRejection', reason);
    // Existing behaviour preserved: notify, escalate on a cascade, stay up.
    onUnhandledRejectionNotice(reason);
  };

  return {
    register(): void {
      process.on('uncaughtException', onUncaughtException);
      process.on('unhandledRejection', onUnhandledRejection);
    },
    dispose(): void {
      process.removeListener('uncaughtException', onUncaughtException);
      process.removeListener('unhandledRejection', onUnhandledRejection);
    },
    capture,
  };
}
