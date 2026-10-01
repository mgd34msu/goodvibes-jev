/**
 * hosted-session-stream.ts, reading the `turn` and `tools` raw event-domain
 * frames that carry a hosted session's LIVE output.
 *
 * There is no token-stream verb for a hosted session and no separate wire
 * shape either (method-catalog-hosted-sessions.ts's header comment): the
 * hosted loop is the ordinary Orchestrator, so it emits the exact same
 * STREAM_DELTA / TURN_COMPLETED / TOOL_EXECUTING / ... envelopes a local
 * session does, on the control-plane's `turn` and `tools` domains, stamped
 * with the hosted session's id as `sessionId`. A client attached to a hosted
 * session watches exactly what it watches locally and filters on the id
 * `sessions.hosted.attach` handed it (gateway.ts's serializeEnvelope:
 * `{ type, ts, traceId, sessionId, source, payload }`).
 *
 * This module reads that envelope shape defensively, the same "never trust
 * the wire to be exactly what was asked for" stance sessions-union.ts and
 * approvals.ts document, so an event this client has never seen degrades to
 * being ignored rather than crashing the attached view.
 */
import { asRecord, firstString } from './object';

/** One decoded `turn`/`tools` domain frame, narrowed to what a hosted-session
 * viewer reads. `type` is the runtime event's own discriminant (STREAM_DELTA,
 * TURN_COMPLETED, TOOL_EXECUTING, ...), read from the envelope's top-level
 * `type` field, matching gateway-utils.ts's serializeEnvelope exactly. */
export interface HostedStreamFrame {
  readonly type: string;
  readonly sessionId: string;
  readonly payload: Record<string, unknown>;
}

/** Decode a raw envelope payload (the SSE frame's `data:` JSON) into a
 * HostedStreamFrame, or null when it does not carry a sessionId at all, a
 * frame this client cannot attribute to any session is never rendered. */
export function readHostedStreamFrame(raw: unknown): HostedStreamFrame | null {
  const record = asRecord(raw);
  const sessionId = firstString(record, ['sessionId']);
  if (!sessionId) return null;
  return {
    type: firstString(record, ['type']),
    sessionId,
    payload: asRecord(record.payload),
  };
}

/** One completed message this view renders after `history`, either the
 * final text of a completed turn, or a system-rendered note about how the
 * turn ended (error/cancelled), matching HostedSessionHistoryMessage's shape
 * so it can be appended to the same rendered list. */
export interface HostedLiveMessage {
  readonly role: 'assistant' | 'system';
  readonly content: string;
  readonly at: number;
}

/** One tool call currently in flight for the attached hosted session's turn. */
export interface HostedActiveToolCall {
  readonly callId: string;
  readonly turnId: string;
  readonly tool: string;
  readonly state: 'executing' | 'succeeded' | 'failed';
  readonly error?: string;
}

/** STREAM_DELTA's running text so far this turn (`payload.accumulated`), or
 * null when the frame is not a stream delta. */
export function streamDeltaAccumulated(frame: HostedStreamFrame): string | null {
  if (frame.type !== 'STREAM_DELTA') return null;
  const value = frame.payload.accumulated;
  return typeof value === 'string' ? value : '';
}

/** A completed/errored/cancelled turn rendered as one appended message, or
 * null when the frame is not a terminal turn event. */
export function hostedLiveMessageFromTurnFrame(frame: HostedStreamFrame, now: () => number = Date.now): HostedLiveMessage | null {
  switch (frame.type) {
    case 'TURN_COMPLETED': {
      const response = frame.payload.response;
      return { role: 'assistant', content: typeof response === 'string' ? response : '', at: now() };
    }
    case 'TURN_ERROR': {
      const error = frame.payload.error;
      return { role: 'system', content: `Turn failed: ${typeof error === 'string' ? error : 'unknown error'}`, at: now() };
    }
    case 'TURN_CANCEL':
      return { role: 'system', content: 'Turn cancelled.', at: now() };
    default:
      return null;
  }
}

/** True for a frame that means the turn is no longer in flight, the local
 * "streaming" indicator drops and any live-text buffer clears. */
export function isTerminalTurnFrame(frame: HostedStreamFrame): boolean {
  return frame.type === 'TURN_COMPLETED' || frame.type === 'TURN_ERROR' || frame.type === 'TURN_CANCEL';
}

/** Read a `tools` domain frame into an active-call transition, or null for a
 * tool lifecycle stage this view does not render (TOOL_RECEIVED/VALIDATED/...). */
export function hostedToolCallFromFrame(frame: HostedStreamFrame): HostedActiveToolCall | null {
  const callId = firstString(frame.payload, ['callId']);
  const turnId = firstString(frame.payload, ['turnId']);
  const tool = firstString(frame.payload, ['tool']);
  if (!callId || !tool) return null;
  switch (frame.type) {
    case 'TOOL_EXECUTING':
      return { callId, turnId, tool, state: 'executing' };
    case 'TOOL_SUCCEEDED':
      return { callId, turnId, tool, state: 'succeeded' };
    case 'TOOL_FAILED': {
      const error = frame.payload.error;
      return { callId, turnId, tool, state: 'failed', error: typeof error === 'string' ? error : undefined };
    }
    default:
      return null;
  }
}
