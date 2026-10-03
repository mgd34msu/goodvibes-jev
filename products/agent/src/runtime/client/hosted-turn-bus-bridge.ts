/**
 * hosted-turn-bus-bridge.ts, putting a daemon-hosted turn's frames back onto
 * this process's own runtime bus.
 *
 * hosted-frame-render.ts already establishes that a hosted session's loop is
 * the ordinary Orchestrator, so its frames ARE exactly the events a local turn
 * emits, TURN_SUBMITTED, STREAM_DELTA, TURN_COMPLETED, and so on, with the
 * hosted session's id stamped on each one. That file only reads them to update
 * the conversation transcript; nothing re-emits them onto THIS process's
 * runtimeBus. So a hosted turn is invisible to anything that only watches
 * `events.turns`, which is exactly how the spoken-turn wiring decides when to
 * speak (see audio/spoken-turn-wiring.ts). Without this bridge, turning on
 * always-speak mode produces speech for a turn run locally and silence for a
 * turn the daemon ran instead, with nothing in either path to say why.
 *
 * This does not invent new information: it reads the same frame the renderer
 * already reads and republishes it through the SDK's typed turn emitters
 * (platform/runtime/emitters, the SDK's own doc comment on RuntimeEventBus.emit
 * says these, not a raw emit, are how a caller is supposed to put a turn event
 * on the bus). So anything already listening to the local turn domain, spoken
 * output today, anything else tomorrow, sees a hosted turn exactly as it
 * would see one this process ran itself.
 *
 * Scope is deliberately the exact event set the spoken-turn wiring subscribes
 * to (TURN_SUBMITTED, PREFLIGHT_FAIL, STREAM_DELTA, STREAM_END, TURN_COMPLETED,
 * TURN_ERROR, TURN_CANCEL), the frame types this file has no mapping for are
 * ignored, the same "no guessing" stance hosted-frame-render.ts takes on its
 * own unmapped frames.
 */
import type { RuntimeEventBus } from '@/runtime/index.ts';
import {
  emitPreflightFail,
  emitStreamDelta,
  emitStreamEnd,
  emitTurnCancel,
  emitTurnCompleted,
  emitTurnError,
  emitTurnSubmitted,
} from '@goodvibes-jev/engine/sdk/platform/runtime/emitters';
import type { HostedSessionFrame } from './hosted-frame-render.ts';

/** The turn-domain stop reasons emitTurnError accepts, mirrored here for the fallback below. */
const TURN_ERROR_STOP_REASONS = [
  'preflight_failed',
  'context_overflow',
  'provider_exhausted',
  'provider_error',
  'hook_denied',
  'tool_loop_circuit_breaker',
  'unexpected_error',
] as const;
type TurnErrorStopReason = (typeof TURN_ERROR_STOP_REASONS)[number];

function isTurnErrorStopReason(value: string | undefined): value is TurnErrorStopReason {
  return value !== undefined && (TURN_ERROR_STOP_REASONS as readonly string[]).includes(value);
}

export interface HostedTurnBusBridgeOptions {
  readonly runtimeBus: RuntimeEventBus;
  /** This surface's own session id, the envelope's context, not the hosted session's. */
  readonly sessionId: string;
  /** Attribution stamped on every re-emitted event, e.g. 'goodvibes-agent'. */
  readonly source: string;
}

function readString(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Feed one raw hosted frame through the bridge.
 *
 * Safe to call with every frame the router applies: a frame with no turnId, or
 * a type this bridge has no mapping for, is ignored rather than guessed at.
 * `traceId` is derived from the turnId rather than generated fresh per call,
 * every frame belonging to one turn should read as one trace.
 */
export function bridgeHostedFrameOntoRuntimeBus(frame: HostedSessionFrame, options: HostedTurnBusBridgeOptions): void {
  const payload = frame.payload;
  const turnId = readString(payload, 'turnId');
  if (!turnId) return;
  const ctx = { sessionId: options.sessionId, source: options.source, traceId: `hosted-${turnId}`, turnId };

  switch (frame.type) {
    case 'TURN_SUBMITTED': {
      const prompt = readString(payload, 'prompt');
      if (prompt === undefined) return;
      emitTurnSubmitted(options.runtimeBus, ctx, { turnId, prompt });
      return;
    }
    case 'PREFLIGHT_FAIL': {
      const reason = readString(payload, 'reason') ?? 'preflight failed';
      const stopReason = readString(payload, 'stopReason');
      emitPreflightFail(options.runtimeBus, ctx, {
        turnId,
        reason,
        stopReason: stopReason === 'context_overflow' ? 'context_overflow' : 'preflight_failed',
      });
      return;
    }
    case 'STREAM_DELTA': {
      const content = readString(payload, 'content') ?? '';
      const accumulated = readString(payload, 'accumulated') ?? content;
      emitStreamDelta(options.runtimeBus, ctx, { turnId, content, accumulated });
      return;
    }
    case 'STREAM_END': {
      emitStreamEnd(options.runtimeBus, ctx, { turnId });
      return;
    }
    case 'TURN_COMPLETED': {
      const response = readString(payload, 'response') ?? '';
      const stopReason = readString(payload, 'stopReason');
      emitTurnCompleted(options.runtimeBus, ctx, {
        turnId,
        response,
        stopReason: stopReason === 'empty_response' ? 'empty_response' : 'completed',
      });
      return;
    }
    case 'TURN_ERROR': {
      const error = readString(payload, 'error') ?? 'the hosting daemon reported this turn failed';
      const stopReason = readString(payload, 'stopReason');
      emitTurnError(options.runtimeBus, ctx, {
        turnId,
        error,
        stopReason: isTurnErrorStopReason(stopReason) ? stopReason : 'unexpected_error',
      });
      return;
    }
    case 'TURN_CANCEL': {
      const reason = readString(payload, 'reason');
      emitTurnCancel(options.runtimeBus, ctx, { turnId, ...(reason !== undefined ? { reason } : {}), stopReason: 'cancelled' });
      return;
    }
    default:
      return;
  }
}
