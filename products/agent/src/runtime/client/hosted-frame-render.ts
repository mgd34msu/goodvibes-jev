/**
 * hosted-frame-render.ts, turning a daemon-hosted turn's event frames back
 * into the conversation this surface renders.
 *
 * When a turn runs in the daemon, this process never sees a provider response.
 * What it sees is the hosted session's event stream: text deltas, the tool
 * calls the model made, their results, the token usage, and the turn's end.
 * This file is the one place that decides what each of those means to the
 * conversation model, kept apart from the transport so the mapping can be
 * tested by handing it frames rather than by standing up a daemon.
 *
 * ── The frames, and where they come from ──────────────────────────────────
 *
 * The hosted loop is the ordinary Orchestrator, so these are exactly the events
 * a local turn emits on the runtime bus, stamped with the hosted session's id:
 *
 *   turn   STREAM_START / STREAM_DELTA / TURN_COMPLETED / TURN_ERROR /
 *          TURN_CANCEL, and LLM_RESPONSE_RECEIVED for the accounting.
 *   tools  TOOL_RECEIVED (the call), TOOL_SUCCEEDED / TOOL_FAILED (the result).
 *
 * ── Why the text is flushed where it is ───────────────────────────────────
 *
 * The conversation model holds an assistant message that CARRIES its tool
 * calls, and tool results as separate entries after it. A turn that calls tools
 * therefore has to close the assistant message at the moment the tool batch
 * arrives, otherwise the calls would attach to text that had not been written
 * when they were made, and the transcript would read out of order.
 *
 * So: deltas accumulate into the streaming block; the first tool call of a
 * batch flushes that block into a real assistant message carrying the batch;
 * results append after it; and anything still accumulating at TURN_COMPLETED is
 * flushed as the final assistant message with the turn's usage on it.
 *
 * ── Honest absence ────────────────────────────────────────────────────────
 *
 * Nothing here invents a value. A frame that arrives without usage produces an
 * assistant message with no usage rather than zeros, and a tool result whose
 * preview the daemon summarized is rendered as that summary rather than as a
 * fabricated full output, the daemon deliberately sends a summary, and
 * pretending otherwise would put text in the transcript that no tool returned.
 */

import type { ToolCall, ToolResult } from '@goodvibes-jev/engine/sdk/platform/types';
import type { TokenUsage } from '@goodvibes-jev/engine/sdk/platform/core';

/**
 * The part of the conversation model this mapping writes to.
 *
 * Structural on purpose: the real `ConversationManager` satisfies it, and so
 * does a recorder in a test, without either knowing about the other.
 */
export interface HostedFrameConversation {
  addAssistantMessage(
    content: string,
    opts?: {
      toolCalls?: ToolCall[];
      usage?: TokenUsage;
      model?: string;
      provider?: string;
    },
  ): void;
  addToolResults(results: ToolResult[]): void;
  addSystemMessage(content: string): void;
  startStreamingBlock(): void;
  updateStreamingBlock(content: string): void;
  finalizeStreamingBlock(): void;
}

/** One frame off the hosted session's event stream, already JSON-parsed. */
export interface HostedSessionFrame {
  readonly type: string;
  readonly sessionId?: string | undefined;
  readonly payload?: Record<string, unknown> | undefined;
}

/**
 * How a hosted turn ended, for a caller that has to WAIT for it.
 *
 * An interactive surface never needs this, it renders frames as they arrive
 * and the person watches. A headless run does: `goodvibes-agent run "..."`
 * has to print one final answer and exit with a code that means something, and
 * a hosted turn emits no local `TURN_COMPLETED` for it to hang that off.
 */
export interface HostedTurnCompletion {
  /**
   * `abandoned` is its own status, not an error: the turn may still be running
   * on the daemon. It is reported as a failure by callers that need an exit
   * code, but the distinction is real and is not flattened here.
   */
  readonly status: 'completed' | 'error' | 'cancelled' | 'abandoned';
  /**
   * The assistant's final text, partial text when the turn did not complete,
   * because what the daemon already produced is still what it produced.
   */
  readonly response: string;
  /** Why it did not complete. Absent exactly when `status` is `completed`. */
  readonly error?: string | undefined;
  /** The daemon's own stop reason where it gave one. */
  readonly stopReason: string;
}

/** What a renderer does with frames, and what it can be asked afterwards. */
export interface HostedFrameRenderer {
  /** Apply one frame. Unknown frame types are ignored, never guessed at. */
  apply(frame: HostedSessionFrame): void;
  /** True once this turn has reached an end frame (completed, error, cancel). */
  isTurnFinished(): boolean;
  /**
   * Close out a turn whose stream ended without an end frame, a dropped
   * connection, a daemon that went away mid-turn. Flushes any streamed text so
   * partial output is kept rather than discarded, and states what happened.
   */
  abandon(reason: string): void;
  /**
   * Resolves when this turn reaches an end frame, or when it is abandoned.
   *
   * Never rejects: an ended turn is an outcome, and a caller awaiting it is
   * usually about to choose an exit code rather than handle an exception.
   */
  completion(): Promise<HostedTurnCompletion>;
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Render the daemon's summary of a tool result as the result text.
 *
 * `TOOL_SUCCEEDED` / `TOOL_FAILED` carry a `ToolResultSummary`, kind, byte
 * size, and a short preview, not the tool's full output. That is the daemon's
 * deliberate choice, so this states what it has and how much it is a summary
 * of, rather than presenting a 100-character preview as the whole result.
 */
function describeToolResultSummary(summary: Record<string, unknown> | undefined): string {
  if (!summary) return '';
  const preview = readString(summary, 'preview') ?? '';
  const byteSize = readNumber(summary, 'byteSize');
  if (byteSize === undefined || preview.length >= byteSize) return preview;
  return `${preview}\n… ${byteSize} bytes total; the hosting daemon sent this preview.`;
}

/**
 * Build a renderer for ONE hosted turn.
 *
 * A renderer is per-turn because its state, the accumulated text, the tool
 * calls seen, the usage, is per-turn. The router makes a new one per submit
 * rather than resetting a long-lived one, so a frame arriving late from a turn
 * that already ended cannot mutate the next turn's message.
 */
export function createHostedFrameRenderer(
  conversation: HostedFrameConversation,
  requestRender: () => void,
): HostedFrameRenderer {
  /** Text accumulated since the last flush. '' means nothing is pending. */
  let accumulated = '';
  /** True while a streaming placeholder is open in the conversation. */
  let streaming = false;
  /** Tool calls received since the last flush, in arrival order. */
  let pendingToolCalls: ToolCall[] = [];
  /** The last accounting seen this turn, applied to the closing message. */
  let usage: TokenUsage | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let finished = false;
  /**
   * The whole turn's assistant text, across every flush.
   *
   * `accumulated` is reset at each flush, a tool batch closes one message and
   * starts another, so it is the wrong thing to report as the turn's answer
   * when a turn called tools. This keeps the text a caller would have read.
   */
  let turnText = '';
  let settle: ((completion: HostedTurnCompletion) => void) | null = null;
  const completed = new Promise<HostedTurnCompletion>((resolve) => { settle = resolve; });
  /** Resolve once; later end frames for the same turn are already ignored. */
  const finish = (completion: HostedTurnCompletion): void => {
    finished = true;
    settle?.(completion);
    settle = null;
  };

  const openStream = (): void => {
    if (streaming) return;
    conversation.startStreamingBlock();
    streaming = true;
  };

  const closeStream = (): void => {
    if (!streaming) return;
    conversation.finalizeStreamingBlock();
    streaming = false;
  };

  /**
   * Commit the accumulated text as an assistant message.
   *
   * `opts.final` decides whether the turn's accounting rides along: usage
   * belongs on the message that ENDS the turn, not on an intermediate one that
   * only exists because tools were called in the middle of it.
   */
  const flush = (text: string, opts: { readonly final: boolean }): void => {
    const toolCalls = pendingToolCalls;
    pendingToolCalls = [];
    accumulated = '';
    if (text) turnText = turnText ? `${turnText}\n${text}` : text;
    if (!text && toolCalls.length === 0) return;
    closeStream();
    conversation.addAssistantMessage(text, {
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(opts.final && usage ? { usage } : {}),
      ...(opts.final && model ? { model } : {}),
      ...(opts.final && provider ? { provider } : {}),
    });
  };

  const apply = (frame: HostedSessionFrame): void => {
    if (finished) return;
    const payload = frame.payload;
    switch (frame.type) {
      case 'STREAM_START': {
        openStream();
        requestRender();
        return;
      }
      case 'STREAM_DELTA': {
        // `accumulated` is the running text the daemon already assembled; it is
        // authoritative. Falling back to appending `content` covers a provider
        // path that sends deltas without it.
        const running = readString(payload, 'accumulated')
          ?? `${accumulated}${readString(payload, 'content') ?? ''}`;
        if (!running) return;
        accumulated = running;
        openStream();
        conversation.updateStreamingBlock(running);
        requestRender();
        return;
      }
      case 'TOOL_RECEIVED': {
        const callId = readString(payload, 'callId');
        const name = readString(payload, 'tool');
        if (!callId || !name) return;
        const args = payload?.['args'];
        pendingToolCalls.push({
          id: callId,
          name,
          arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
        } as ToolCall);
        // The assistant message carrying this batch closes here, so the calls
        // attach to the text that preceded them.
        flush(accumulated, { final: false });
        requestRender();
        return;
      }
      case 'TOOL_SUCCEEDED':
      case 'TOOL_FAILED': {
        const callId = readString(payload, 'callId');
        if (!callId) return;
        const succeeded = frame.type === 'TOOL_SUCCEEDED';
        const summary = payload?.['result'];
        const described = describeToolResultSummary(
          summary && typeof summary === 'object' ? summary as Record<string, unknown> : undefined,
        );
        const error = readString(payload, 'error');
        conversation.addToolResults([{
          callId,
          success: succeeded,
          ...(succeeded ? { output: described } : { error: error ?? described ?? 'the tool failed' }),
        } as ToolResult]);
        requestRender();
        return;
      }
      case 'LLM_RESPONSE_RECEIVED': {
        // Held, not written: it belongs on the message that closes the turn.
        const inputTokens = readNumber(payload, 'inputTokens');
        const outputTokens = readNumber(payload, 'outputTokens');
        if (inputTokens !== undefined || outputTokens !== undefined) {
          usage = {
            inputTokens: inputTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            ...(readNumber(payload, 'cacheReadTokens') !== undefined
              ? { cacheReadTokens: readNumber(payload, 'cacheReadTokens') }
              : {}),
            ...(readNumber(payload, 'cacheWriteTokens') !== undefined
              ? { cacheWriteTokens: readNumber(payload, 'cacheWriteTokens') }
              : {}),
          } as TokenUsage;
        }
        model = readString(payload, 'model') ?? model;
        provider = readString(payload, 'provider') ?? provider;
        return;
      }
      case 'TURN_COMPLETED': {
        // Prefer what was streamed: it is what the person watched arrive. The
        // turn's `response` is the fallback for a turn that produced its text
        // without deltas (a non-streaming provider).
        flush(accumulated || readString(payload, 'response') || '', { final: true });
        closeStream();
        requestRender();
        finish({
          status: 'completed',
          response: turnText,
          stopReason: readString(payload, 'stopReason') ?? 'completed',
        });
        return;
      }
      case 'TURN_ERROR': {
        flush(accumulated, { final: true });
        closeStream();
        const reason = readString(payload, 'error') ?? 'no reason was given';
        conversation.addSystemMessage(`The hosting daemon reported this turn failed: ${reason}`);
        requestRender();
        finish({
          status: 'error',
          response: turnText,
          error: reason,
          stopReason: readString(payload, 'stopReason') ?? 'unexpected_error',
        });
        return;
      }
      case 'TURN_CANCEL': {
        flush(accumulated, { final: true });
        closeStream();
        conversation.addSystemMessage('This turn was cancelled on the hosting daemon.');
        requestRender();
        finish({
          status: 'cancelled',
          response: turnText,
          error: readString(payload, 'reason') ?? 'cancelled',
          stopReason: readString(payload, 'stopReason') ?? 'cancelled',
        });
        return;
      }
      default:
        // Every other frame on these domains is real traffic this mapping has
        // no rendering for. Ignoring it is correct; guessing would not be.
        return;
    }
  };

  return {
    apply,
    isTurnFinished: () => finished,
    completion: () => completed,
    abandon: (reason: string): void => {
      if (finished) return;
      // Partial output is kept. The person watched it arrive, and dropping it
      // because the connection died would lose work the daemon actually did.
      flush(accumulated, { final: true });
      closeStream();
      conversation.addSystemMessage(reason);
      requestRender();
      finish({ status: 'abandoned', response: turnText, error: reason, stopReason: 'stream_ended' });
    },
  };
}
