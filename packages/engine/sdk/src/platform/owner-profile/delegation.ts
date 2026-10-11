import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { currentToolAutonomySource } from '../tools/registry.js';
import type { ToolExecuteOptions } from '../types/tools.js';
import { readNativeMutationAdmission, type NativeMutationAdmission } from '../control-plane/native-mutation.js';
import type { MutationPublication } from '../utils/file-mutation.js';

/** Opaque invocation-bound evidence. Serialized copies have no authority. */
export interface RecordedProfileDelegation { readonly kind: 'recorded-autonomous' }
export interface ProfileMutationOptions extends JudgmentReadingOptions {
  readonly delegation?: RecordedProfileDelegation | undefined;
  /** Trusted backing mutation receipts. These callbacks never grant authority. */
  readonly onWriteIntent?: (() => void) | undefined;
  readonly onEffect?: ((published?: boolean) => void) | undefined;
  readonly withPublication?: MutationPublication | undefined;
}
interface DelegationSource {
  readonly goal: string;
  readonly criteria: readonly string[];
  readonly assertCurrent: () => void;
}
const sources = new WeakMap<RecordedProfileDelegation, DelegationSource>();
const invocations = new WeakMap<object, RecordedProfileDelegation>();
const invocationOptions = new WeakMap<object, ProfileMutationOptions>();

/** Issuance requires the exact active registry proof, independently of caller flags. */
export function captureProfileDelegation(args: Record<string, unknown>, options?: ToolExecuteOptions): RecordedProfileDelegation {
  const source = currentToolAutonomySource(args, options);
  if (!source) throw new Error('Profile delegation requires recorded current admission.');
  source.assertCurrent();
  const token: RecordedProfileDelegation = Object.freeze({ kind: 'recorded-autonomous' });
  sources.set(token, source);
  return token;
}

/** The server supplies its own recorded admission under native paired owner access. */
export function captureNativeProfileDelegation(admission: NativeMutationAdmission, invocation: object): RecordedProfileDelegation {
  const captured = readNativeMutationAdmission(admission, invocation);
  captured.assertCurrent();
  const token: RecordedProfileDelegation = Object.freeze({ kind: 'recorded-autonomous' });
  sources.set(token, Object.freeze({ goal: captured.source.goal, criteria: Object.freeze([...captured.source.criteria]),
    assertCurrent: captured.assertCurrent }));
  return token;
}

export function readProfileDelegation(token?: RecordedProfileDelegation): DelegationSource | undefined {
  if (!token) return undefined;
  const source = sources.get(token);
  if (!source) throw new Error('Unknown profile delegation.');
  source.assertCurrent(); return source;
}
export function assertCurrentProfileDelegation(token: RecordedProfileDelegation): void { readProfileDelegation(token); }

/** Bind only native invocation identity. No request body or context claim is read. */
export function bindProfileDelegationToInvocation(token: RecordedProfileDelegation, invocation: object): void {
  readProfileDelegation(token); invocations.set(invocation, token);
}
export function profileDelegationForInvocation(invocation: object): RecordedProfileDelegation | undefined {
  const token = invocations.get(invocation); readProfileDelegation(token); return token;
}

/** Trusted native callers carry restrictions and receipts separately from wire data. */
export function bindProfileMutationOptionsToInvocation(options: ProfileMutationOptions, invocation: object): void {
  options.signal?.throwIfAborted(); options.assertCurrent?.(); readProfileDelegation(options.delegation);
  invocationOptions.set(invocation, Object.freeze({ ...options }));
  if (options.delegation) bindProfileDelegationToInvocation(options.delegation, invocation);
}
export function profileMutationOptionsForInvocation(invocation: object): ProfileMutationOptions | undefined {
  return invocationOptions.get(invocation);
}
