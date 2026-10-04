import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import {
  NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES,
  NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES,
  nativeWorkSubmissionRequestSchema,
  nativeWorkSubmissionLookupRequestSchema,
  nativeWorkSubmissionReceiptSchema,
  nativeWorkSubmissionResultSchema,
  nativeWorkSubmissionLookupResultSchema,
  type NativeWorkSubmissionRequest,
  type NativeWorkSubmissionLookupRequest,
  type NativeWorkSubmissionReceipt,
  type NativeWorkSubmissionResult,
  type NativeWorkSubmissionLookupResult,
} from './native-submission-wire.js';

export {
  NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES,
  NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES,
  nativeWorkSubmissionRequestSchema,
  nativeWorkSubmissionLookupRequestSchema,
  nativeWorkSubmissionReceiptSchema,
  nativeWorkSubmissionResultSchema,
  nativeWorkSubmissionLookupResultSchema,
  type NativeWorkSubmissionRequest,
  type NativeWorkSubmissionLookupRequest,
  type NativeWorkSubmissionReceipt,
  type NativeWorkSubmissionResult,
  type NativeWorkSubmissionLookupResult,
} from './native-submission-wire.js';

export interface OperatorNativeWorkSubmissionOptions {
  /** Detaches this local request only. An interrupted submission may already be persisted. */
  readonly signal?: AbortSignal;
}

export interface OperatorNativeWorkSubmissionClient {
  submit(input: NativeWorkSubmissionRequest, options?: OperatorNativeWorkSubmissionOptions): Promise<NativeWorkSubmissionResult>;
  get(input: NativeWorkSubmissionLookupRequest, options?: OperatorNativeWorkSubmissionOptions): Promise<NativeWorkSubmissionLookupResult>;
  /** Detaches local requests; never cancels a server submission or disposes the shared operator client. */
  dispose(): void;
}

/** Local validation/lifecycle failure. Operator errors propagate unchanged. */
export class NativeWorkSubmissionClientError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_response' | 'aborted' | 'disposed') {
    super(code === 'aborted' || code === 'disposed'
      ? `Native work submission: local request ${code}; server outcome is unknown`
      : `Native work submission: ${code}`);
    this.name = 'NativeWorkSubmissionClientError';
  }
}

function bounded(value: unknown, limit: number): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= limit;
  } catch { return false; }
}

/**
 * Reuses the selected authenticated operator transport without acquiring authority,
 * retrying, polling, or starting execution. projectId pins response identity only;
 * it is never sent as store selection. After a lost response, explicitly get the
 * same requestId before deciding whether to replay the exact original submission.
 */
export function createOperatorNativeWorkSubmissionClient(
  client: Pick<OperatorRemoteClient, 'invoke'>,
  projectId: string,
): OperatorNativeWorkSubmissionClient {
  if (!nativeWorkSubmissionReceiptSchema.shape.projectId.safeParse(projectId).success) {
    throw new NativeWorkSubmissionClientError('invalid_request');
  }
  let disposed = false;
  const requests = new Set<AbortController>();
  function active(signal?: AbortSignal): void {
    if (disposed) throw new NativeWorkSubmissionClientError('disposed');
    if (signal?.aborted) throw new NativeWorkSubmissionClientError('aborted');
  }

  async function invoke(
    method: 'workLedger.submit' | 'workLedger.submission.get',
    request: NativeWorkSubmissionRequest | NativeWorkSubmissionLookupRequest,
    options: OperatorNativeWorkSubmissionOptions,
  ): Promise<unknown> {
    active(options.signal);
    const controller = new AbortController();
    requests.add(controller);
    let cancel = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new NativeWorkSubmissionClientError(disposed ? 'disposed' : 'aborted'));
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const signal = options.signal;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      // The race also fences transports which ignore AbortSignal and observes late rejection.
      const value = await Promise.race([
        Promise.resolve().then(() => {
          active(controller.signal);
          return client.invoke<unknown>(method, request, { signal: controller.signal });
        }),
        cancelled,
      ]);
      active(controller.signal);
      if (!bounded(value, NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES)) throw new NativeWorkSubmissionClientError('invalid_response');
      return value;
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      signal?.removeEventListener('abort', onAbort);
      requests.delete(controller);
    }
  }

  function validateReceipt(receipt: NativeWorkSubmissionReceipt, requestId: string): void {
    if (receipt.projectId !== projectId || receipt.requestId !== requestId) throw new NativeWorkSubmissionClientError('invalid_response');
  }

  return Object.freeze({
    async submit(input: NativeWorkSubmissionRequest, options: OperatorNativeWorkSubmissionOptions = {}) {
      active(options.signal);
      let request: NativeWorkSubmissionRequest;
      try {
        if (!bounded(input, NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES)) throw new Error();
        request = nativeWorkSubmissionRequestSchema.parse(input);
      } catch { throw new NativeWorkSubmissionClientError('invalid_request'); }
      // Keep a distinct snapshot: neither caller nor a reentrant transport may alter response validation.
      const identity = nativeWorkSubmissionRequestSchema.parse(request);
      const value = await invoke('workLedger.submit', request, options);
      active(options.signal);
      let result: NativeWorkSubmissionResult;
      try { result = nativeWorkSubmissionResultSchema.parse(value); }
      catch { throw new NativeWorkSubmissionClientError('invalid_response'); }
      validateReceipt(result.receipt, identity.requestId);
      if (result.receipt.inputId !== identity.inputId || result.receipt.goal !== identity.goal
        || result.receipt.criteria.length !== identity.criteria.length
        || result.receipt.criteria.some((criterion, index) => criterion !== identity.criteria[index])) {
        throw new NativeWorkSubmissionClientError('invalid_response');
      }
      active(options.signal);
      return result;
    },
    async get(input: NativeWorkSubmissionLookupRequest, options: OperatorNativeWorkSubmissionOptions = {}) {
      active(options.signal);
      let request: NativeWorkSubmissionLookupRequest;
      try { request = nativeWorkSubmissionLookupRequestSchema.parse(input); }
      catch { throw new NativeWorkSubmissionClientError('invalid_request'); }
      const requestId = request.requestId;
      const value = await invoke('workLedger.submission.get', request, options);
      active(options.signal);
      let result: NativeWorkSubmissionLookupResult;
      try { result = nativeWorkSubmissionLookupResultSchema.parse(value); }
      catch { throw new NativeWorkSubmissionClientError('invalid_response'); }
      if (result.kind === 'found') validateReceipt(result.receipt, requestId);
      active(options.signal);
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const request of requests) request.abort();
    },
  });
}
