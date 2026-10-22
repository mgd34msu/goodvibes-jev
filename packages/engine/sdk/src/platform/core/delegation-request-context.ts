import { AsyncLocalStorage } from 'node:async_hooks';

interface DelegationRequest {
  readonly request: string;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
const current = new AsyncLocalStorage<DelegationRequest>();

export function withDelegationRequest<T>(source: DelegationRequest, run: () => T): T {
  return current.run(Object.freeze({ ...source }), run);
}
export function readDelegationRequest(): DelegationRequest | undefined { return current.getStore(); }
