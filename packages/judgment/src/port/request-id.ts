import { AsyncLocalStorage } from 'node:async_hooks';
import type { Fetch } from '@typesafe-ai/sdk';

/** The response header carrying the endpoint's id for a request. */
const REQUEST_ID_HEADER = 'x-typesafe-request-id';

/** Where one call's fetch leaves the id of the response it received. */
interface RequestIdSlot {
  requestId: string | undefined;
  readonly onResponse?: (requestId: string | undefined) => void;
}

/**
 * The slot of the call in progress. The SDK's fetch runs inside the async
 * context of the call that started it, so concurrent calls never see each
 * other's slot, and across retries the last attempt's id stays.
 */
const currentSlot = new AsyncLocalStorage<RequestIdSlot>();

/** Wraps a fetch so every response's request id is left in the slot of the call that made it. */
export function recordingRequestIds(base: Fetch): Fetch {
  return async (input, init) => {
    const response = await base(input, init);
    const slot = currentSlot.getStore();
    if (slot !== undefined) {
      slot.requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
      slot.onResponse?.(slot.requestId);
    }
    return response;
  };
}

/** Runs one call and returns its result with the request id its response carried. */
export async function withRequestId<T>(call: () => Promise<T>, onResponse?: (requestId: string | undefined) => void): Promise<{ readonly result: T; readonly requestId: string | undefined }> {
  const slot: RequestIdSlot = { requestId: undefined, ...(onResponse ? { onResponse } : {}) };
  const result = await currentSlot.run(slot, call);
  return { result, requestId: slot.requestId };
}
