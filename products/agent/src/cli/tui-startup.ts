import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import { readOnboardingCompletionMarker } from '../runtime/onboarding/index.ts';
import type { GoodVibesCliParseResult } from './types.ts';
import { checkRecoveryFile, readLastSessionPointer } from '@/runtime/index.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import { resolveResumableSession, surfaceResumeRelaunchNotice } from './resume-relaunch-notice.ts';
import { writeFatalLine } from '../utils/fatal-boot-write.ts';

export type InteractiveTerminalCheckInput = {
  readonly binary: string;
  readonly stdinIsTTY: boolean | undefined;
  readonly stdoutIsTTY: boolean | undefined;
};

type NodeLikeError = Error & {
  readonly code?: string;
  readonly path?: string;
  readonly syscall?: string;
};

export type FatalStartupFormatOptions = {
  readonly binary: string;
  readonly debug?: boolean;
};

function isNodeLikeError(error: unknown): error is NodeLikeError {
  return error instanceof Error;
}

function fatalStartupMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function fatalStartupStack(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return fatalStartupMessage(error);
}

export function formatFatalStartupErrorForLog(error: unknown): string {
  return fatalStartupStack(error);
}

/**
 * The one fatal-startup exit path for main(): say why on stderr, log the full
 * detail, and exit 1. Lives beside the two formatters it composes so main.ts
 * carries no error-formatting plumbing of its own. Each write is individually
 * best-effort, a failing logger or a torn-down stderr must never hide the
 * original launch failure.
 *
 * The stderr write goes FIRST, and its default sink is a synchronous write to
 * file descriptor 2 (`writeFatalLine`), not `process.stderr.write`. Both
 * details are the fix for a fatal path that could die mute:
 *
 *  - Ordering: the logger is the part that can fail. It needs a configured
 *    destination and a writable directory, and at this point in boot it may
 *    have neither, so reporting to it first risks throwing before the reason
 *    ever reaches a stream.
 *  - Sink: `main.ts` installs a terminal output guard that REPLACES
 *    `process.stderr.write` to keep stray output off a rendered screen. Any
 *    startup failure raised after that install had its explanation
 *    intercepted and swallowed, measured on a compiled binary as exit 1 with
 *    zero bytes on both streams. A descriptor write cannot be intercepted, and
 *    has completed by the time it returns rather than racing `process.exit`.
 *
 * `writeStderr` stays injectable so tests can observe it, but it is optional
 * and defaults to the descriptor write: a caller that forgets it gets the safe
 * behaviour rather than silence.
 */
export function reportFatalStartupError(
  err: unknown,
  options: FatalStartupFormatOptions,
  sinks: {
    readonly logError: (message: string, context: Record<string, unknown>) => void;
    readonly writeStderr?: (chunk: string) => void;
    readonly exit: (code: number) => void;
  },
): void {
  const userDetail = formatFatalStartupErrorForUser(err, options);
  const writeStderr = sinks.writeStderr ?? writeFatalLine;
  try {
    writeStderr(`${options.binary} failed to launch:\n${userDetail}`);
  } catch {
    // Ignore secondary stderr failures during process teardown.
  }
  const detail = formatFatalStartupErrorForLog(err);
  try {
    sinks.logError('Fatal error', { error: detail });
  } catch {
    // Startup diagnostics must never hide the original launch failure.
  }
  sinks.exit(1);
}

export function formatFatalStartupErrorForUser(error: unknown, options: FatalStartupFormatOptions): string {
  if (options.debug === true) return fatalStartupStack(error);

  const message = fatalStartupMessage(error);
  if (isNodeLikeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return [
      `${options.binary} could not prepare its local workspace or log directory.`,
      error.path ? `  path: ${error.path}` : '',
      error.syscall ? `  operation: ${error.syscall}` : '',
      '  reason: permission denied',
      `  next: launch from a writable directory, pass '${options.binary} --cd <dir>', or set GOODVIBES_WORKING_DIR to a writable path.`,
      '  note: GOODVIBES_AGENT_HOME can be set to move Agent-local config, sessions, memory, skills, personas, and routines.',
    ].filter((line) => line.length > 0).join('\n');
  }

  if (isNodeLikeError(error) && error.code === 'ENOENT') {
    return [
      `${options.binary} could not find a required startup path.`,
      error.path ? `  path: ${error.path}` : '',
      `  reason: ${message}`,
      `  next: check '${options.binary} --cd <dir>' and GOODVIBES_WORKING_DIR, then rerun '${options.binary} status'.`,
    ].filter((line) => line.length > 0).join('\n');
  }

  return [
    message || `${options.binary} failed during startup.`,
    'Set GOODVIBES_AGENT_DEBUG=1 to print a stack trace.',
  ].join('\n');
}

export function getInteractiveTerminalLaunchError(input: InteractiveTerminalCheckInput): string | null {
  const stdinReady = input.stdinIsTTY === true;
  const stdoutReady = input.stdoutIsTTY === true;
  if (stdinReady && stdoutReady) return null;

  const missing = [
    stdinReady ? null : 'stdin',
    stdoutReady ? null : 'stdout',
  ].filter((entry): entry is string => entry !== null);
  const missingLabel = missing.length === 1 ? `${missing[0]} is` : `${missing.join(' and ')} are`;

  return [
    `${input.binary} requires an interactive terminal for the TUI (${missingLabel} not a TTY).`,
    `Run it from a terminal, or use non-interactive commands such as '${input.binary} --help', '${input.binary} status --json', or '${input.binary} run --print "<prompt>"'.`,
  ].join('\n');
}

export function applyInitialTuiCliState(options: {
  readonly cli: GoodVibesCliParseResult;
  readonly input: InputHandler;
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly shellPaths: Parameters<typeof readOnboardingCompletionMarker>[0] & { readonly homeDirectory: string };
  /** Declare-once session-storage handle threaded through the resume-relaunch notice's pointer/recovery reads so they can never diverge from the writer's paths. */
  readonly surface: SessionSurface;
  readonly render: () => void;
}): void {
  const { cli, input, commandRegistry, commandContext, shellPaths, surface, render } = options;
  const onboardingCompletionMarker = readOnboardingCompletionMarker(shellPaths, 'user');
  const seededPrompt = cli.flags.prompt ?? (cli.rawCommand === undefined && cli.positionals.length > 0 ? cli.positionals.join(' ') : undefined);
  if (cli.command === 'onboarding') {
    input.openAgentWorkspace(commandContext, undefined, 'ONBOARDING');
  } else if (cli.command === 'sessions' && cli.commandArgs[0] === 'resume') {
    const target = cli.commandArgs.slice(1).join(' ').trim();
    if (target) {
      void commandRegistry.execute('session', ['resume', target], commandContext).then(() => render());
    }
  } else if (!onboardingCompletionMarker.payload) {
    input.openAgentWorkspace(commandContext, 'setup', 'ONBOARDING');
  } else {
    // Normal relaunch: onboarding is done and the user didn't ask for
    // onboarding or an explicit `sessions resume`. Surface an honest,
    // non-blocking resume affordance instead of silently starting fresh
    // (a dogfood finding), never auto-resume, declining is
    // frictionless (just start typing).
    surfaceResumeRelaunchNotice({
      getLastSessionPointer: () => readLastSessionPointer({ surface }),
      isRecoveryPending: () => Boolean(checkRecoveryFile({ surface })),
      findSession: (sessionId) => {
        const sessionManager = commandContext.session?.sessionManager;
        return sessionManager ? resolveResumableSession(sessionManager, sessionId) : null;
      },
      print: (text) => commandContext.print(text),
    });
  }

  if (seededPrompt) {
    input.prompt = seededPrompt;
    input.cursorPos = seededPrompt.length;
  }
}
