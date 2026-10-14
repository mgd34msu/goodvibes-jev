import type { BootstrapContext } from '../runtime/bootstrap.ts';
import { dispatchNativeConversationTurn } from '../runtime/native-conversation-ingress.ts';
import type { NativeConversationIntakeState } from '../runtime/native-conversation-intake.ts';
import type { NativeHeadlessTurnResult } from './native-headless.ts';
import type { TurnEvent } from '@/runtime/index.ts';

/** Ordinary prompts go directly to the model; explicit native recovery retains its permit. */
export async function executeHeadlessTurn(ctx: BootstrapContext, input: string | NativeConversationIntakeState, signal: AbortSignal, format: string): Promise<NativeHeadlessTurnResult> {
  let response = ''; let error = ''; let stopReason = 'turn-unsettled'; let exitCode = 3; let events = 0;
  const unsubs = [
    ctx.runtimeBus.on<Extract<TurnEvent, { type: 'STREAM_DELTA' }>>('STREAM_DELTA', ({ payload }) => {
      events++;
      if (format === 'stream-json') process.stdout.write(JSON.stringify({ type: payload.type, content: payload.content, accumulated: payload.accumulated }) + '\n');
    }),
    ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => { events++; response = payload.response; stopReason = payload.stopReason; exitCode = 0; }),
    ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', ({ payload }) => { events++; error = payload.error; stopReason = payload.stopReason; exitCode = 1; }),
    ctx.runtimeBus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', ({ payload }) => { events++; error = payload.reason ?? 'cancelled'; stopReason = payload.stopReason; exitCode = 130; }),
  ];
  // This freshly bootstrapped executor belongs only to this invocation.
  const abort = () => ctx.orchestrator.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) return { exitCode: 130, response: '', stopReason: 'cancelled' };
    if (typeof input === 'string') await ctx.orchestrator.handleUserInput(input);
    else await dispatchNativeConversationTurn(input, ctx.orchestrator);
    if (signal.aborted) exitCode = 130;
    return { exitCode, response, error, stopReason, sessionId: ctx.runtime.sessionId, model: ctx.runtime.model, provider: ctx.runtime.provider, events };
  } finally { signal.removeEventListener('abort', abort); for (const unsubscribe of unsubs) unsubscribe(); }
}
