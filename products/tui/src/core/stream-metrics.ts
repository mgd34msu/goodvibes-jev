/**
 * Shared stream state for event wiring and rendering.
 *
 * Keep this leaf independent of either consumer: the renderer reads metrics
 * without depending on the event handlers that update them or their turn and
 * conversation lifecycle dependencies.
 */

/**
 * Live stream and tool-execution metrics maintained by wireStreamEventMetrics.
 * The object is mutated in place by event handlers; callers declare it before
 * render() and pass it in, so render() can read the fields without copying.
 */
export interface StreamMetrics {
  /** Epoch ms when the most recent STREAM_START fired; 0 when idle. */
  startTime: number;
  /** Number of STREAM_DELTA events received since the last STREAM_START. */
  deltaCount: number;
  /** Computed tokens-per-second at the last STREAM_DELTA; 0 when idle. */
  tokenSpeed: number;
  /** Elapsed ms from STREAM_START to first STREAM_DELTA (time-to-first-token). */
  ttftMs: number | undefined;
  /** Whether TTFT has been recorded for the current turn. */
  ttftRecorded: boolean;
  /** Epoch ms when the most recent TOOL_EXECUTING event fired; undefined when idle. */
  activeToolStartedAtMs: number | undefined;
  /** Name of the currently executing tool; cleared when execution completes. */
  activeToolName: string | undefined;
  /**
   * callId of the currently executing tool call; cleared when execution
   * completes. This is the real orchestrator callId (from TOOL_EXECUTING),
   * so a per-tool cancel affordance targets exactly the running call, never
   * the synthetic 'live' render id.
   */
  activeToolCallId: string | undefined;
  /**
   * Arguments of the tool calls received this turn, by callId (from
   * TOOL_RECEIVED), so the throbber can name the running call's key argument.
   * An entry is dropped when its call finishes (succeeded, failed or
   * cancelled), and the map keeps at most 64 entries, oldest dropped first.
   */
  toolArgsByCallId: Map<string, Record<string, unknown>>;
  /**
   * Epoch ms of the most recent STREAM_START or STREAM_DELTA; undefined when
   * idle (no turn in flight). Read every render frame, not just on the
   * watchdog's one-shot hint, so "ms since last byte" can be computed even
   * when no new SDK event has arrived at all (a no-delta stall watchdog for
   * the render loop itself, independent of the low-priority system message).
   */
  lastDeltaAtMs: number | undefined;
  /**
   * 1-based count of stall episodes the watchdog has fired for the current
   * turn; 0 = no stall yet. Increments each time a fresh silence (after a
   * recovery) crosses the stall threshold.
   */
  stallEpisode: number;
  /**
   * Populated from the SDK's STREAM_RETRY event, which fires when an in-flight
   * provider call reconnects after a transport error rather than failing the
   * turn. A turn that never retries simply leaves these undefined. Cleared on
   * STREAM_DELTA, a byte arriving means the reconnect succeeded.
   */
  reconnectAttempt: number | undefined;
  reconnectMaxAttempts: number | undefined;
}

/** The idle initial StreamMetrics, mutated in place by wireStreamEventMetrics handlers. */
export function createStreamMetrics(): StreamMetrics {
  return {
    startTime: 0, deltaCount: 0, tokenSpeed: 0, ttftMs: undefined, ttftRecorded: false,
    activeToolStartedAtMs: undefined, activeToolName: undefined, activeToolCallId: undefined,
    toolArgsByCallId: new Map(),
    lastDeltaAtMs: undefined, stallEpisode: 0,
    reconnectAttempt: undefined, reconnectMaxAttempts: undefined,
  };
}
