/**
 * Node-only persistence primitives for product-owned request journals.
 * These are the existing implementations, with no weaker wrapper or changed
 * defaults. Journals requiring durable publication must pass `durable: true`
 * and `strictOwnership: true` explicitly. A published-indeterminate error
 * never proves rollback; inspect/confirm the visible file before proceeding.
 */
export { writeJsonFileAtomic, confirmFileDurable, AtomicWriteDurabilityError } from '../utils/atomic-json-store.js';
export type { AtomicWriteOptions, AtomicJsonWriteOptions, AtomicWriteDurabilityPhase } from '../utils/atomic-json-store.js';
export { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
export type { CrossProcessLockOptions } from '../workspace/checkpoint/cross-process-lock.js';
