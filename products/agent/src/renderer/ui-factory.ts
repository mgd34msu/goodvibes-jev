import { type Line, type Cell, createEmptyLine } from '@goodvibes-jev/engine/sdk/platform/types';
import { VERSION } from '../version.ts';
import { getDisplayWidth, truncateDisplay } from '../utils/terminal-width.ts';
import { renderConversationFragment } from './conversation-surface.ts';
import { renderHeaderLine } from './header-line.ts';
import { renderUserMessage } from './user-message.ts';
import { activeTheme, activeTokens } from './theme.ts';
import { waitingPhrase, type WaitingState } from '@goodvibes-jev/engine/sdk/platform/presentation';

/**
 * Silence threshold before the whimsical phrase rotation freezes and an honest
 * label (Waiting for model Ns / Stalled Ns) takes over. Matches the TUI.
 */
const THINKING_STALL_FREEZE_MS = 2_500;

/**
 * Per-turn stall signal derived from stream metrics, computed from the last
 * delta clock every render (not from any event), so it degrades gracefully with
 * zero new SDK events. `reconnect` is set only when the transport surfaces retry
 * counters (the agent's SDK orchestrator does not today, see computeStallInfo).
 */
export interface ThinkingStallInfo {
  /** Ms since the last output-token advance (or the turn start if none yet). */
  readonly msSinceLastDelta: number;
  readonly reconnect?: { readonly attempt: number; readonly maxAttempts: number };
}

/**
 * UIFactory - Generates standard UI fragments without needing Ink/React overhead.
 */
export class UIFactory {
  /**
   * The header row, see header-line.ts. `version` defaults to the live build
   * VERSION; tests pass a pinned fixture so golden frames do not change with
   * every release bump.
   */
  public static createHeader(width: number, model: string, title?: string, version: string = VERSION): Line[] {
    return renderHeaderLine(width, model, title, version);
  }

  /**
   * createMessageBar, a sent user message: a full-width panel fill with the
   * secondary bar (user-message.ts). A cancelled message passes its own fill,
   * bar and strikethrough.
   */
  public static createMessageBar(
    width: number, text: string,
    bgColor: string = activeTokens().backgroundPanel, textColor: string = activeTokens().text, barColor: string = activeTokens().secondary,
    strikethrough = false,
  ): Line[] {
    return renderUserMessage(text, width, { bar: barColor, bg: bgColor, text: textColor, strikethrough });
  }

  /**
   * createQueuedMessageFragment - Renders a dimmed message bar for queued prompts.
   */
  public static createQueuedMessageFragment(width: number, text: string): Line[] {
    return renderConversationFragment(text, width, {
      prefix: ' (...) ',
      prefixFg: activeTokens().secondary,
      text: activeTokens().textFaint,
      bodyBg: activeTheme().collapsedBodyBg,
    });
  }

  /**
   * The status line's waiting phrase for a running turn. Decides WHICH honest
   * waiting state applies (renderer-local signals), then takes the exact
   * wording from the SDK presentation contract's waitingPhrase(). Precedence:
   * approval > reconnecting > pre-first-token > stalled > thinking. The
   * whimsical rotation freezes once real silence has lasted long enough to be
   * misleading (THINKING_STALL_FREEZE_MS).
   */
  public static busyPhrase(frame: number, outputTokens?: number, stallInfo?: ThinkingStallInfo, approvalPending?: boolean): string {
    const isStalled = stallInfo !== undefined && stallInfo.msSinceLastDelta >= THINKING_STALL_FREEZE_MS;
    let state: WaitingState;
    if (approvalPending) state = 'approval';
    else if (stallInfo?.reconnect) state = 'reconnecting';
    else if (isStalled && (outputTokens ?? 0) === 0) state = 'pre-first-token';
    else if (isStalled) state = 'stalled';
    else state = 'thinking';
    return waitingPhrase(state, {
      reconnectAttempt: stallInfo?.reconnect?.attempt,
      reconnectMaxAttempts: stallInfo?.reconnect?.maxAttempts,
      msSinceLastDelta: stallInfo?.msSinceLastDelta,
      frame,
    });
  }

  /** The opt-in partial tool preview row shown under the transcript while a turn runs. */
  public static createToolPreviewRow(width: number, preview: string): Line {
    return this.stringToLine(truncateDisplay(`   tool: ${preview}`, Math.max(0, width - 2)), width, { fg: activeTokens().textFaint });
  }

  /**
   * Per-frame stall info from stream metrics, computed from a last-delta clock
   * every render (not from any event) so it degrades gracefully with zero new
   * SDK events. Undefined until a delta clock exists this turn. Renderer-local
   * by design (per the S1 decision record: the SDK owns state->wording; deriving
   * WHICH state applies stays with each renderer's own stream-metrics shape).
   */
  public static computeStallInfo(
    lastDeltaAtMs: number | undefined,
    reconnectAttempt: number | undefined,
    reconnectMaxAttempts: number | undefined,
    nowMs: number,
  ): ThinkingStallInfo | undefined {
    if (lastDeltaAtMs === undefined) return undefined;
    const reconnect = reconnectAttempt !== undefined && reconnectMaxAttempts !== undefined
      ? { attempt: reconnectAttempt, maxAttempts: reconnectMaxAttempts }
      : undefined;
    return { msSinceLastDelta: nowMs - lastDeltaAtMs, reconnect };
  }

  /**
   * Render-loop stall decision: suppress stall detection entirely while a tool
   * is actively executing. The last-delta clock only advances on output-token
   * deltas and is never advanced during tool execution (the model isn't
   * producing tokens then), so without this gate any tool call longer than
   * THINKING_STALL_FREEZE_MS would print "Stalled Ns..." above a ticking tool
   * row, a false positive. Genuine no-delta silence while waiting on the
   * provider (including pre-first-token) still stall-detects here, since no tool
   * is active then, the honest stall case this indicator exists for.
   */
  public static computeRenderStallInfo(
    metrics: { toolActive: boolean; lastDeltaAtMs: number | undefined; nowMs: number },
  ): ThinkingStallInfo | undefined {
    return metrics.toolActive
      ? undefined
      : this.computeStallInfo(metrics.lastDeltaAtMs, undefined, undefined, metrics.nowMs);
  }

  public static stringToLine(text: string, width: number, style: Partial<Cell> = {}): Line {
    const line = createEmptyLine(width);
    let currentColumn = 0;
    for (const char of text) {
      if (currentColumn >= width) break;
      const code = char.codePointAt(0) ?? 0;
      if (code < 32 || code === 127) continue;
      const charWidth = getDisplayWidth(char);
      line[currentColumn] = {
        char,
        fg: style.fg || '',
        bg: style.bg || '',
        bold: style.bold || false,
        dim: style.dim || false,
        underline: style.underline || false,
        italic: style.italic || false,
        strikethrough: style.strikethrough || false
      };
      if (charWidth === 2 && currentColumn + 1 < width) {
        line[currentColumn + 1] = { ...line[currentColumn], char: '' };
      }
      currentColumn += charWidth;
    }
    return line;
  }
}
