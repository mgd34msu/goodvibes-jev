import { executePolicyCheck } from '../../gate/execute-policy-check.js';
/** Serialize platform-owned mutation of one captured view across retained jobs
 * and write/edit tools. The opaque authority is the key, never a path prefix. */
import { assertContractInputAuthority, type ContractInputAuthority } from '../../contract/input-authority.js';
const tails = new WeakMap<ContractInputAuthority, Promise<void>>();
/** An active lock owner may let its contained validator publish before returning.
 * A copied token, another authority, a concurrent publication or a retained
 * callback after the owner returns cannot borrow that ownership. */
export interface CapturedPublicationLease { readonly kind: 'captured-publication-lease' }
interface PublicationState { authority: ContractInputAuthority; active: boolean; publishing: boolean; draining?: Promise<void> | undefined }
const leases = new WeakMap<CapturedPublicationLease, PublicationState>();
export async function publishWithinCapturedLease<T>(
  lease: CapturedPublicationLease,
  authority: ContractInputAuthority,
  operation: (assertCurrent: () => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const state = leases.get(lease);
  if (!state || !state.active || state.publishing || state.authority !== authority)
    throw new Error('captured publication requires its active exclusive owner');
  state.publishing = true;
  let drained!: () => void;
  state.draining = new Promise<void>((resolve) => { drained = resolve; });
  const assertCurrent = (): void => {
    signal?.throwIfAborted();
    if (!state.active) throw new Error('captured publication owner has settled');
  };
  try {
    await assertContractInputAuthority(authority, undefined, signal);
    assertCurrent();
    return await operation(assertCurrent);
  } finally { state.publishing = false; drained(); state.draining = undefined; }
}
export async function withCapturedPublication<T>(authority: ContractInputAuthority, operation: (lease: CapturedPublicationLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = tails.get(authority) ?? Promise.resolve();
  let release!: () => void;
  const finished = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => finished);
  tails.set(authority, tail);
  const lease = Object.freeze({ kind: 'captured-publication-lease' as const });
  const state: PublicationState = { authority, active: false, publishing: false };
  leases.set(lease, state);
  try {
    await executePolicyCheck(() => previous, signal);
    await assertContractInputAuthority(authority, undefined, signal);
    state.active = true;
    return await operation(lease);
  } finally {
    state.active = false;
    await state.draining;
    release();
    void tail.then(() => { if (tails.get(authority) === tail) tails.delete(authority); });
  }
}
