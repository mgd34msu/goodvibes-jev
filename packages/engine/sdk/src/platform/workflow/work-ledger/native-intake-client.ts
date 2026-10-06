import { captureNativeConversationContinuation, type NativeConversationContinuation } from './native-continuation-context.js';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import {
  NATIVE_CONVERSATION_INTAKE_MAX_REQUEST_BYTES, NATIVE_CONVERSATION_INTAKE_MAX_RESPONSE_BYTES,
  nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeLookupRequestSchema,
  nativeConversationIntakeTransitionRequestSchema, nativeConversationIntakeResultSchema,
  nativeConversationIntakeLookupResultSchema, nativeConversationIntakeWorkReceiptSchema,
  type NativeConversationIntakeCaptureRequest, type NativeConversationIntakeLookupRequest,
  type NativeConversationIntakeTransitionRequest, type NativeConversationIntakeResult,
  type NativeConversationIntakeLookupResult, type NativeConversationIntakeSourceRef,
} from './native-intake-wire.js';
export * from './native-intake-wire.js';

declare const nativeConversationTurnPermitBrand: unique symbol;
/** Process-local capability. Serialization or copying never transfers it. */
export interface NativeConversationTurnPermit { readonly [nativeConversationTurnPermitBrand]: true; }
export type NativeConversationTurnSource = Readonly<Omit<Extract<NativeConversationIntakeResult, { kind: 'turn' }>, 'continuation'> & {
  readonly continuation?: NativeConversationContinuation | undefined;
  readonly sourceRef: Readonly<NativeConversationIntakeSourceRef>;
}>;
const turnPermits = new WeakMap<NativeConversationTurnPermit, { readonly source: NativeConversationTurnSource; readonly revalidate: () => Promise<void> }>();
/** Read-only identity inspection; only this client's private eligible results can mint. */
export function readNativeConversationTurnPermit(permit: NativeConversationTurnPermit): NativeConversationTurnSource {
  const binding = turnPermits.get(permit);
  if (!binding) throw new NativeConversationIntakeClientError('invalid_turn_permit');
  return binding.source;
}
/** Rechecks the same authenticated read route before actual delivery; never mints. */
export async function revalidateNativeConversationTurnPermit(permit: NativeConversationTurnPermit): Promise<void> {
  const binding = turnPermits.get(permit);
  if (!binding) throw new NativeConversationIntakeClientError('invalid_turn_permit');
  await binding.revalidate();
}

export interface OperatorNativeConversationIntakeOptions {
  /** Detaches this request only. The authoritative operation may already be persisted. */
  readonly signal?: AbortSignal;
}
export interface OperatorNativeConversationIntakeClient {
  capture(input: NativeConversationIntakeCaptureRequest, options?: OperatorNativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  get(input: NativeConversationIntakeLookupRequest, options?: OperatorNativeConversationIntakeOptions): Promise<NativeConversationIntakeLookupResult>;
  admit(input: NativeConversationIntakeTransitionRequest, options?: OperatorNativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  resume(input: NativeConversationIntakeTransitionRequest, options?: OperatorNativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  cancel(input: NativeConversationIntakeTransitionRequest, options?: OperatorNativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  /** Call only after the product durably claims dispatch. get/cancel results are ineligible. */
  bindTurn(result: NativeConversationIntakeResult): NativeConversationTurnPermit;
  /** Detaches local requests without cancelling server intake or disposing the shared client. */
  dispose(): void;
}
export class NativeConversationIntakeClientError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_response' | 'invalid_turn_permit' | 'aborted' | 'disposed') {
    super(code === 'aborted' || code === 'disposed' ? `Native conversation intake: local request ${code}; server outcome is unknown` : `Native conversation intake: ${code}`);
    this.name = 'NativeConversationIntakeClientError';
  }
}
function bounded(value: unknown, limit: number): boolean {
  try { const json = JSON.stringify(value); return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= limit; }
  catch { return false; }
}
type Operation = 'capture' | 'get' | 'admit' | 'resume' | 'cancel';
type Request = NativeConversationIntakeCaptureRequest | NativeConversationIntakeLookupRequest | NativeConversationIntakeTransitionRequest;
type SourceIdentity = { requestId: string; sourceRef: NativeConversationIntakeSourceRef; text?: string };

/** Selected authenticated operator transport only. No polling, retries, model calls or execution. */
export function createOperatorNativeConversationIntakeClient(client: Pick<OperatorRemoteClient, 'invoke'>, projectId: string): OperatorNativeConversationIntakeClient {
  if (!nativeConversationIntakeWorkReceiptSchema.shape.projectId.safeParse(projectId).success) throw new NativeConversationIntakeClientError('invalid_request');
  const invokeOperator: OperatorRemoteClient['invoke'] = client.invoke.bind(client);
  let disposed = false;
  const requests = new Set<AbortController>();
  const sources = new Map<string, SourceIdentity>();
  const eligibleTurns = new WeakMap<NativeConversationIntakeResult, NativeConversationTurnSource>();
  const boundTurns = new WeakMap<NativeConversationIntakeResult, NativeConversationTurnPermit>();
  function eligible(result: NativeConversationIntakeResult): void {
    if (result.kind === 'turn') eligibleTurns.set(result, Object.freeze({ ...result,
      ...(result.continuation ? { continuation: captureNativeConversationContinuation(result.continuation) } : {}),
      sourceRef: Object.freeze({ ...result.sourceRef, ...(result.sourceRef.continuation ? { continuation: Object.freeze({ ...result.sourceRef.continuation }) } : {}) }) }));
  }
  function active(signal?: AbortSignal): void {
    if (disposed) throw new NativeConversationIntakeClientError('disposed');
    if (signal?.aborted) throw new NativeConversationIntakeClientError('aborted');
  }
  async function invoke(operation: Operation, request: Request, options: OperatorNativeConversationIntakeOptions): Promise<unknown> {
    active(options.signal);
    const controller = new AbortController(); requests.add(controller);
    let cancel = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new NativeConversationIntakeClientError(disposed ? 'disposed' : 'aborted'));
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const signal = options.signal;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => { active(controller.signal); return invokeOperator<unknown>(`workLedger.intake.${operation}`, request, { signal: controller.signal }); }),
        cancelled,
      ]);
      active(controller.signal);
      if (!bounded(value, NATIVE_CONVERSATION_INTAKE_MAX_RESPONSE_BYTES)) throw new NativeConversationIntakeClientError('invalid_response');
      return value;
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      signal?.removeEventListener('abort', onAbort); requests.delete(controller);
    }
  }
  function validate(result: NativeConversationIntakeResult, identity: Request): void {
    const previous = sources.get(identity.inputId);
    const { sourceRef } = result;
    if (result.projectId !== projectId || sourceRef.inputId !== identity.inputId
      || ('requestId' in identity && result.requestId !== identity.requestId)
      || ('sourceRevision' in identity && sourceRef.sourceRevision !== identity.sourceRevision)
      || ('text' in identity && sourceRef.continuation?.sessionId !== identity.continuation?.sessionId)
      || (previous && (result.requestId !== previous.requestId || sourceRef.sourceId !== previous.sourceRef.sourceId
        || sourceRef.sourceRevision !== previous.sourceRef.sourceRevision || sourceRef.sessionId !== previous.sourceRef.sessionId
        || JSON.stringify(sourceRef.continuation ?? null) !== JSON.stringify(previous.sourceRef.continuation ?? null)))) {
      throw new NativeConversationIntakeClientError('invalid_response');
    }
    const text = 'text' in identity ? identity.text : previous?.text;
    if (text !== undefined && ((result.kind === 'work' && result.receipt.goal !== text)
      || (result.kind === 'turn' && result.text !== text))) throw new NativeConversationIntakeClientError('invalid_response');
    // Detached state: callers cannot mutate the identity used by later responses.
    sources.set(identity.inputId, { requestId: result.requestId, sourceRef: { ...sourceRef, ...(sourceRef.continuation ? { continuation: { ...sourceRef.continuation } } : {}) }, ...(text === undefined ? {} : { text }) });
  }
  function parseResult(value: unknown): NativeConversationIntakeResult {
    const result = nativeConversationIntakeResultSchema.safeParse(value);
    if (!result.success) throw new NativeConversationIntakeClientError('invalid_response');
    return result.data;
  }
  async function transition(operation: 'admit' | 'resume' | 'cancel', input: NativeConversationIntakeTransitionRequest, options: OperatorNativeConversationIntakeOptions): Promise<NativeConversationIntakeResult> {
    active(options.signal);
    const parsed = nativeConversationIntakeTransitionRequestSchema.safeParse(input);
    if (!parsed.success || !bounded(input, NATIVE_CONVERSATION_INTAKE_MAX_REQUEST_BYTES)) throw new NativeConversationIntakeClientError('invalid_request');
    const identity = { ...parsed.data };
    const result = parseResult(await invoke(operation, parsed.data, options));
    active(options.signal); validate(result, identity);
    if (operation !== 'cancel') eligible(result);
    return result;
  }
  return Object.freeze({
    async capture(input: NativeConversationIntakeCaptureRequest, options: OperatorNativeConversationIntakeOptions = {}) {
      active(options.signal);
      const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(input);
      if (!parsed.success || !bounded(input, NATIVE_CONVERSATION_INTAKE_MAX_REQUEST_BYTES)) throw new NativeConversationIntakeClientError('invalid_request');
      const identity = nativeConversationIntakeCaptureRequestSchema.parse(parsed.data);
      const result = parseResult(await invoke('capture', parsed.data, options));
      active(options.signal); validate(result, identity); eligible(result); return result;
    },
    async get(input: NativeConversationIntakeLookupRequest, options: OperatorNativeConversationIntakeOptions = {}) {
      active(options.signal);
      const parsed = nativeConversationIntakeLookupRequestSchema.safeParse(input);
      if (!parsed.success || !bounded(input, NATIVE_CONVERSATION_INTAKE_MAX_REQUEST_BYTES)) throw new NativeConversationIntakeClientError('invalid_request');
      const identity = { ...parsed.data };
      const result = nativeConversationIntakeLookupResultSchema.safeParse(await invoke('get', parsed.data, options));
      active(options.signal);
      if (!result.success) throw new NativeConversationIntakeClientError('invalid_response');
      if (result.data.kind !== 'not-found') validate(result.data, identity);
      return result.data;
    },
    admit: (input: NativeConversationIntakeTransitionRequest, options: OperatorNativeConversationIntakeOptions = {}) => transition('admit', input, options),
    resume: (input: NativeConversationIntakeTransitionRequest, options: OperatorNativeConversationIntakeOptions = {}) => transition('resume', input, options),
    cancel: (input: NativeConversationIntakeTransitionRequest, options: OperatorNativeConversationIntakeOptions = {}) => transition('cancel', input, options),
    bindTurn(result: NativeConversationIntakeResult) {
      active();
      const source = eligibleTurns.get(result);
      if (!source) throw new NativeConversationIntakeClientError('invalid_turn_permit');
      const existing = boundTurns.get(result);
      if (existing) return existing;
      const permit = Object.freeze({}) as NativeConversationTurnPermit;
      turnPermits.set(permit, { source, async revalidate() {
        // The permit outlives this client's local request lifetime. Its retained
        // transport must still authenticate the same selected owner/project.
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new NativeConversationIntakeClientError('invalid_turn_permit')); }, 10_000);
          });
          const current = await Promise.race([invokeOperator<unknown>('workLedger.intake.get', { inputId: source.sourceRef.inputId }, { signal: controller.signal }), timeout]);
          if (!bounded(current, NATIVE_CONVERSATION_INTAKE_MAX_RESPONSE_BYTES)) throw new NativeConversationIntakeClientError('invalid_turn_permit');
          const parsed = nativeConversationIntakeResultSchema.safeParse(current);
          if (!parsed.success || parsed.data.kind !== 'turn' || JSON.stringify(parsed.data) !== JSON.stringify(source)) {
            throw new NativeConversationIntakeClientError('invalid_turn_permit');
          }
        } finally { if (timer !== undefined) clearTimeout(timer); }
      } });
      boundTurns.set(result, permit);
      return permit;
    },
    dispose() { if (disposed) return; disposed = true; for (const request of requests) request.abort(); sources.clear(); },
  });
}
