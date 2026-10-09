/** Carries original autonomous source through the admitted tool body, never an ambient last turn. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExternalOperationSource } from './external-request.js';
const operations = new AsyncLocalStorage<ExternalOperationSource>();
export function withExternalOperationSource<T>(source: ExternalOperationSource | undefined, run: () => T): T {
  return source ? operations.run(source, run) : operations.exit(run);
}
export function currentExternalOperationSource(): ExternalOperationSource | undefined { return operations.getStore(); }
