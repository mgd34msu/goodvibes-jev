import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import {
  nativeHostedTurnLookupSchema, nativeHostedTurnRequestSchema,
  type NativeHostedTurnLookup, type NativeHostedTurnRequest,
} from '@goodvibes-jev/engine/sdk/platform/hosted-sessions/native-turn-client';

export type { NativeHostedTurnLookup, NativeHostedTurnRequest };
export interface NativeHostedTurnClient {
  status(target: NativeHostedTurnRequest, options?: { readonly signal?: AbortSignal }): Promise<NativeHostedTurnLookup>;
  start(target: NativeHostedTurnRequest, options?: { readonly signal?: AbortSignal }): Promise<NativeHostedTurnLookup>;
  cancel(target: NativeHostedTurnRequest, options?: { readonly signal?: AbortSignal }): Promise<NativeHostedTurnLookup>;
}

/** Agent-owned source identity only. The daemon owns the turn permit and dispatch claim. */
export function createNativeHostedTurnClient(operator: Pick<OperatorRemoteClient, 'invoke'>, projectId: string): NativeHostedTurnClient {
  const run = async (action: 'status' | 'start' | 'cancel', target: NativeHostedTurnRequest, options: { readonly signal?: AbortSignal } = {}): Promise<NativeHostedTurnLookup> => {
    const request = nativeHostedTurnRequestSchema.parse(target);
    if (request.projectId !== projectId) throw new Error('Native hosted turn project changed');
    options.signal?.throwIfAborted();
    const found = nativeHostedTurnLookupSchema.parse(await operator.invoke<unknown>(action === 'start' ? 'workLedger.turn.startAgent' : `workLedger.turn.${action}`, request, options));
    options.signal?.throwIfAborted();
    if (!('kind' in found) && (found.projectId !== request.projectId || found.inputId !== request.inputId || found.sourceRevision !== request.sourceRevision)) {
      throw new Error('Native hosted turn source changed');
    }
    return found;
  };
  return Object.freeze({
    status: (target: NativeHostedTurnRequest, options?: { readonly signal?: AbortSignal }) => run('status', target, options),
    start: (target: NativeHostedTurnRequest, options?: { readonly signal?: AbortSignal }) => run('start', target, options),
    cancel: (target: NativeHostedTurnRequest, options?: { readonly signal?: AbortSignal }) => run('cancel', target, options),
  });
}

export function nativeHostedTurnLines(result: NativeHostedTurnLookup): string[] {
  if ('kind' in result) return ['Native hosted turn has not started. Use /work intake-retry to request delivery of the saved original.'];
  const lines = [`Native hosted turn: ${result.state}.`];
  if (result.sessionId) lines.push(`Native session: ${result.sessionId}`);
  if (result.state === 'recovery-required') lines.push('Inspect the original hosted session; ambiguous dispatch will not be replayed.');
  if (result.state === 'cancelled') lines.push('This original hosted turn is cancelled. Effects already performed are not undone.');
  return lines;
}
