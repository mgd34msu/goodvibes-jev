/** Native transfer capabilities are construction-only and never reconstructed from watch JSON. */
import type { ExternalOperationSource } from '../permissions/external-request.js';
import type { CiWatchSubscription, FixSessionBrief, FixSessionStartOutcome } from './types.js';

export interface NativeCiWatchOwner {
  readonly id: string;
  bindWatch(watch: CiWatchSubscription): Promise<void>;
  startRepair(brief: FixSessionBrief): Promise<FixSessionStartOutcome>;
  revoke(): Promise<void>;
}
type SourceGetter = ExternalOperationSource['sourceOf'];
const issuers = new WeakMap<object, (operation: ExternalOperationSource) => ExternalOperationSource>();
const owners = new WeakMap<ExternalOperationSource, NativeCiWatchOwner>();

/** Installed only by the current native contract host on its exact source getter. */
export function bindNativeCiSourceIssuer<T extends object>(source: T,
  issue: (operation: ExternalOperationSource) => ExternalOperationSource): T {
  issuers.set(source, issue); return source;
}
export function captureNativeCiWatchOwner(operation: ExternalOperationSource): ExternalOperationSource | undefined {
  if (owners.has(operation)) return operation;
  const issue = issuers.get(operation.sourceOf) ?? issuers.get(operation.sourceOf());
  return issue?.(operation);
}
export function bindNativeCiWatchOwner(operation: ExternalOperationSource, owner: NativeCiWatchOwner): ExternalOperationSource {
  owners.set(operation, owner); return operation;
}
export function nativeCiWatchOwner(operation: ExternalOperationSource | undefined): NativeCiWatchOwner | undefined {
  return operation ? owners.get(operation) : undefined;
}
