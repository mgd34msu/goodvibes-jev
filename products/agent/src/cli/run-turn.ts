/**
 * run-turn.ts, executing ONE headless turn and turning it into an exit code.
 *
 * `goodvibes-agent run "..."` has a contract the interactive surface does not:
 * exactly one final answer on stdout, in the shape `--output-format` asked for,
 * and an exit code that means something (0 completed, 1 failed, 130 cancelled).
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * That contract used to be wired directly to the LOCAL runtime bus:
 * `TURN_COMPLETED` / `TURN_ERROR` / `TURN_CANCEL` fired in this process, and
 * run mode read the answer off them. So when conversation turns started being
 * routed to the connected daemon, run mode was the one path that could not
 * follow, a hosted turn runs in the daemon's process and emits none of those
 * events here. It kept calling the in-process orchestrator directly, which is
 * how headless runs stayed local while the owner's ruling said every LLM turn
 * goes through the daemon.
 *
 * The fix is not a second routing path. It is one place that knows both ways a
 * turn can end, a local bus event, or a hosted turn's completion, and
 * produces the SAME outcome shape from either, so the output formatting and the
 * exit codes below never learn where the turn ran.
 *
 * ── Where the stated reason goes ──────────────────────────────────────────
 *
 * A turn that falls back to running locally still says so, exactly as the
 * interactive surface does. In run mode it goes to STDERR, not stdout: stdout
 * is a machine-readable contract, and a notice injected into it would break the
 * caller parsing JSON far more rudely than it would inform them.
 */

import type { BootstrapContext } from '../runtime/bootstrap.ts';
import type { TurnEvent } from '@/runtime/index.ts';
import type { HostedSessionFrame, HostedTurnCompletion } from '../runtime/client/hosted-frame-render.ts';
import { installRemoteConversationRouting, type RemoteConversationWiring } from '../shell/remote-conversation-wiring.ts';

/** Exit codes run mode has always used; a hosted turn maps onto the same set. */
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANCELLED = 130;

/** What one headless turn produced, wherever it ran. */
export interface RunTurnResult {
  readonly exitCode: number;
  readonly response: string;
  readonly error: string;
  readonly stopReason: string;
  /** How many turn events / hosted frames were observed, for the JSON shape. */
  readonly eventCount: number;
  /** True when the daemon ran this turn. Reported on stderr, never on stdout. */
  readonly routed: boolean;
}

export interface RunTurnOptions {
  readonly ctx: BootstrapContext;
  readonly prompt: string;
  readonly outputFormat: string | undefined;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /**
   * Injectable so a test can drive a routed turn without a daemon.
   *
   * A FACTORY rather than a ready router: it is handed the frame observer that
   * feeds stream-json and the event count, so an injected routing exercises the
   * same wiring production uses instead of quietly bypassing it.
   */
  readonly createRouting?: ((onFrame: (frame: HostedSessionFrame) => void) => RemoteConversationWiring) | undefined;
}

/** Map a hosted turn's ending onto run mode's exit codes. */
function exitCodeForCompletion(completion: HostedTurnCompletion): number {
  if (completion.status === 'completed') return EXIT_OK;
  if (completion.status === 'cancelled') return EXIT_CANCELLED;
  // `error` and `abandoned` are both failures to a shell. They stay distinct in
  // the reported reason, because "the daemon said it failed" and "the
  // connection died and it may still be running" are different things to know.
  return EXIT_FAILED;
}

/**
 * Run one turn: routed to the connected daemon when routing says so, in this
 * process otherwise, with the same result shape either way.
 */
export async function executeRunTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const { ctx, prompt, outputFormat } = options;
  const streamJson = outputFormat === 'stream-json';
  let eventCount = 0;

  const emitDelta = (content: unknown, accumulated: unknown): void => {
    if (!streamJson) return;
    options.stdout(JSON.stringify({ type: 'STREAM_DELTA', content, accumulated }));
  };

  // The frame observer feeds stream-json and the event count for a routed
  // turn, the way the local bus subscriptions do for a local one.
  const observeFrame = (frame: HostedSessionFrame): void => {
    eventCount += 1;
    if (frame.type === 'STREAM_DELTA') {
      emitDelta(frame.payload?.['content'], frame.payload?.['accumulated']);
    }
  };
  const routing = options.createRouting
    ? options.createRouting(observeFrame)
    : installRemoteConversationRouting(ctx, {
      render: () => {},
      // Run mode has no message router; the fallback notice goes to stderr.
      notify: (message) => options.stderr(message),
      onFrame: observeFrame,
    });

  try {
    const routed = await routing.routeOrExplain(prompt, false);
    if (routed) {
      const completion = await routed.completion;
      return {
        exitCode: exitCodeForCompletion(completion),
        response: completion.response,
        error: completion.error ?? '',
        stopReason: completion.stopReason,
        eventCount,
        routed: true,
      };
    }
    return await runLocalTurn(options, () => { eventCount += 1; }, () => eventCount);
  } finally {
    // Only dispose what we built. A caller-supplied router is the caller's.
    if (!options.createRouting) routing.dispose();
  }
}

/**
 * The original path, unchanged in behaviour: subscribe to this process's turn
 * events, submit to the in-process orchestrator, and wait for an end event.
 */
async function runLocalTurn(
  options: RunTurnOptions,
  countEvent: () => void,
  readCount: () => number,
): Promise<RunTurnResult> {
  const { ctx, prompt, outputFormat } = options;
  let response = '';
  let error = '';
  let stopReason = '';
  let exitCode = EXIT_OK;

  const unsubs: (() => void)[] = [];
  const done = new Promise<void>((resolve) => {
    const settle = (): void => {
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      resolve();
    };
    unsubs.push(
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'STREAM_DELTA' }>>('STREAM_DELTA', ({ payload }) => {
        countEvent();
        if (outputFormat === 'stream-json') {
          options.stdout(JSON.stringify({
            type: payload.type,
            content: payload.content,
            accumulated: payload.accumulated,
          }));
        }
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => {
        countEvent();
        response = payload.response;
        stopReason = payload.stopReason;
        settle();
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload }) => {
        countEvent();
        error = payload.error;
        stopReason = payload.stopReason;
        exitCode = EXIT_FAILED;
        settle();
      }),
      ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload }) => {
        countEvent();
        error = payload.reason ?? 'cancelled';
        stopReason = payload.stopReason;
        exitCode = EXIT_CANCELLED;
        settle();
      }),
    );
  });

  try {
    await ctx.orchestrator.handleUserInput(prompt);
    await done;
  } finally {
    // A submission that threw before any end event would otherwise leave these
    // subscribed for the life of the process.
    for (const unsub of unsubs) unsub();
  }
  return { exitCode, response, error, stopReason, eventCount: readCount(), routed: false };
}

/**
 * Write the result in the format the caller asked for.
 *
 * These shapes are a contract with whatever is parsing them, so they are
 * IDENTICAL for a routed and a local turn, where the turn ran is reported on
 * stderr, never by changing a field here.
 */
export function writeRunTurnResult(
  result: RunTurnResult,
  options: { readonly ctx: BootstrapContext; readonly outputFormat: string | undefined; readonly stdout: (line: string) => void },
): void {
  const ok = result.exitCode === EXIT_OK;
  if (options.outputFormat === 'json') {
    options.stdout(JSON.stringify({
      ok,
      response: result.response,
      error: result.error || undefined,
      stopReason: result.stopReason,
      sessionId: options.ctx.runtime.sessionId,
      model: options.ctx.runtime.model,
      provider: options.ctx.runtime.provider,
      events: result.eventCount,
    }, null, 2));
    return;
  }
  if (options.outputFormat === 'stream-json') {
    options.stdout(JSON.stringify({
      type: ok ? 'TURN_COMPLETED' : 'TURN_ERROR',
      ok,
      response: result.response,
      error: result.error || undefined,
      stopReason: result.stopReason,
    }));
    return;
  }
  options.stdout(ok ? result.response : result.error);
}
