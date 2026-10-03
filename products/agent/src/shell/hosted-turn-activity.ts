/**
 * hosted-turn-activity.ts, making a daemon-hosted turn look exactly like a
 * local one to the interface.
 *
 * ── The failure this closes ────────────────────────────────────────────────
 *
 * Every "a turn is in flight" signal the shell paints reads ONE source: the
 * orchestrator's `isThinking`, and the animation frame and token counts beside
 * it. The thinking overlay (spinner + waiting phrase + token speed + tool
 * preview), the rows the render loop reserves for it, and the activity
 * Activity modal's busy row are all gated on it.
 *
 * A local turn sets that state and, this is the part that mattered most,
 * starts an 80ms interval that advances the animation frame and calls
 * `requestRender()`. THAT timer is what repaints the shell during a turn. Frame
 * arrival is not the pump; the animation is.
 *
 * A daemon-hosted turn runs in the daemon's process and set none of it. So the
 * shell went blind for the whole turn: no spinner, no waiting phrase, no token
 * speed, and, because nothing was scheduling repaints, no visible output
 * until the next keystroke happened to drive a render. Three reported symptoms,
 * one cause.
 *
 * ── Why it drives the existing state rather than adding its own ────────────
 *
 * The presentation was not being changed, it was being restored, so the
 * safest possible fix is the one that cannot alter a phrase, a glyph or a
 * layout: feed the SAME fields the UI already reads, and let every existing
 * consumer keep working unchanged. `getSpinner()` derives its glyph from
 * `thinkingFrame`, so advancing that field on the same 80ms cadence produces
 * the identical animation rather than a lookalike. Nothing in the render loop
 * needed to learn that hosted turns exist.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * It never invents token numbers. A hosted turn's usage arrives once, on the
 * daemon's `LLM_RESPONSE_RECEIVED` frame, so the counts stay at zero until
 * there is a real number to show, and the waiting fragment already omits a
 * zero rather than printing one. A fabricated live token speed would be worse
 * than an absent one.
 */

/**
 * The mutable turn-indicator state the shell renders from.
 *
 * Structurally the orchestrator's own public fields, so the real orchestrator
 * IS this, which is the point: there is one state, not a parallel copy that
 * could disagree with it.
 */
export interface ThinkingUiState {
  isThinking: boolean;
  thinkingFrame: number;
  streamingInputTokens: number;
  streamingOutputTokens: number;
}

export interface HostedTurnActivity {
  /** A hosted turn has started: show the waiting state and start repainting. */
  begin(): void;
  /** The hosted turn ended: clear the waiting state and stop repainting. */
  end(): void;
  /** True while THIS controller owns the indicator. */
  isActive(): boolean;
  /** Real counts from the daemon, once it has sent any. Never estimated here. */
  noteUsage(inputTokens: number, outputTokens: number): void;
  /**
   * The tool the daemon is running right now, or null when none is.
   *
   * The shell's tool preview and its Activity modal both read a LOCAL
   * session snapshot, which stays empty for a hosted turn because the tools
   * are executing in the daemon's process, a turn making thirty tool calls
   * reported "No runtime activity". The frames say what is running; this is
   * where that is kept so the same two consumers can show it.
   */
  noteTool(label: string | null): void;
  /** What to show as the running tool, or undefined when nothing is. */
  toolPreview(): string | undefined;
  dispose(): void;
}

/**
 * The orchestrator's own animation cadence. Matched deliberately: a different
 * interval would make a hosted turn's spinner visibly slower or faster than a
 * local one, which is a presentation change nobody asked for.
 */
export const HOSTED_SPINNER_INTERVAL_MS = 80;

export function createHostedTurnActivity(input: {
  readonly turnState: ThinkingUiState;
  /** The shell's repaint. The same one a local turn's animation timer calls. */
  readonly requestRender: () => void;
  readonly intervalMs?: number | undefined;
}): HostedTurnActivity {
  let timer: ReturnType<typeof setInterval> | null = null;
  /** True only while this controller set the state, so it never clears another's. */
  let owned = false;
  let runningTool: string | null = null;

  const stopTimer = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  const release = (): void => {
    stopTimer();
    if (!owned) return;
    owned = false;
    runningTool = null;
    input.turnState.isThinking = false;
    input.turnState.streamingInputTokens = 0;
    input.turnState.streamingOutputTokens = 0;
    input.requestRender();
  };

  return {
    begin: (): void => {
      if (owned) return;
      // A local turn already owns the indicator: leave it alone. Two writers
      // would fight over one field and the spinner would stutter.
      if (input.turnState.isThinking) return;
      owned = true;
      input.turnState.isThinking = true;
      // Reset so the gradient starts clean and the frame never grows unbounded,
      // exactly as the local path does at the start of each turn.
      input.turnState.thinkingFrame = 0;
      input.turnState.streamingInputTokens = 0;
      input.turnState.streamingOutputTokens = 0;
      stopTimer();
      timer = setInterval(() => {
        input.turnState.thinkingFrame += 1;
        input.requestRender();
      }, input.intervalMs ?? HOSTED_SPINNER_INTERVAL_MS);
      // Never hold the event loop open on this timer alone.
      (timer as unknown as { unref?: () => void }).unref?.();
      // Paint immediately: the waiting state has to appear on the keystroke,
      // not one interval later.
      input.requestRender();
    },
    end: release,
    isActive: () => owned,
    noteUsage: (inputTokens: number, outputTokens: number): void => {
      if (!owned) return;
      if (inputTokens > 0) input.turnState.streamingInputTokens = inputTokens;
      if (outputTokens > 0) input.turnState.streamingOutputTokens = outputTokens;
      input.requestRender();
    },
    noteTool: (label: string | null): void => {
      if (!owned) return;
      runningTool = label;
      input.requestRender();
    },
    toolPreview: () => (owned && runningTool ? runningTool : undefined),
    dispose: release,
  };
}
