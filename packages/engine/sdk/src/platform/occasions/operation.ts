import { readProfileDelegation, type ProfileMutationOptions } from '../owner-profile/delegation.js';
import { captureMutationDescriptors } from '../utils/file-mutation.js';
import type { OccasionsServiceDeps } from './service.js';
import type { DeliveryLifetime } from '../utils/delivery-lifetime.js';
import type { OccasionNudge } from './types.js';

export interface OccasionMutationOptions extends ProfileMutationOptions {
  readonly onStateWriteIntent?: (() => void) | undefined;
  readonly onStateEffect?: ((published?: boolean) => void) | undefined;
  readonly withNudgeDelivery?: ((request: { readonly channel: string; readonly nudge: OccasionNudge },
    operation: (lifetime: DeliveryLifetime) => Promise<string | undefined>) => Promise<string | undefined>) | undefined;
}
const stateReceipts = new WeakMap<() => void, OccasionMutationOptions>();
export function retainOccasionStateReceipts(assertCurrent: () => void, options: OccasionMutationOptions): void {
  stateReceipts.set(assertCurrent, options);
}
export function occasionStateReceipts(assertCurrent: () => void): OccasionMutationOptions | undefined {
  return stateReceipts.get(assertCurrent);
}

/** Restrict a concrete operation to the captured native owners, configuration and clock. */
export function captureOccasionOperation(deps: OccasionsServiceDeps, options: OccasionMutationOptions,
  owner: () => OccasionsServiceDeps): OccasionMutationOptions {
  if (!options.assertCurrent && !options.signal && !options.delegation && !options.withPublication) return options;
  const depCurrent = captureMutationDescriptors(deps, ['profile', 'writer', 'state', 'config', 'now', 'signal', 'calendar', 'deliverer']);
  const profile = deps.profile, writer = deps.writer, state = deps.state, config = deps.config;
  const profileCurrent = captureMutationDescriptors(profile, ['importantDates', 'plans', 'person', 'ownerNames', 'captureRead']);
  const writerCurrent = captureMutationDescriptors(writer, ['append', 'forget']);
  const stateMethods = Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(state)))
    .filter(([name, descriptor]) => name !== 'constructor' && 'value' in descriptor && typeof descriptor.value === 'function')
    .map(([name]) => name);
  const stateCurrent = captureMutationDescriptors(state, ['filePath', 'store', 'writes', ...stateMethods]);
  const configCurrent = captureMutationDescriptors(config, ['get', 'getConfigurationIncarnation']);
  // Bun's native global object is a proxy. Retain its actual Date data slot
  // without admitting arbitrary caller-owned proxies to descriptor capture.
  const dateDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Date');
  if (!dateDescriptor || !('value' in dateDescriptor) || dateDescriptor.value !== Date) throw new Error('Occasion clock is unavailable.');
  const dateCurrent = () => {
    const current = Object.getOwnPropertyDescriptor(globalThis, 'Date');
    if (!current || !('value' in current) || current.value !== dateDescriptor.value
      || current.writable !== dateDescriptor.writable || current.configurable !== dateDescriptor.configurable
      || current.enumerable !== dateDescriptor.enumerable) throw new Error('Occasion clock owner changed.');
  };
  const clockCurrent = captureMutationDescriptors(Date, ['now']);
  const incarnation = config.getConfigurationIncarnation?.();
  const signal = AbortSignal.any([...(deps.signal ? [deps.signal] : []), ...(options.signal ? [options.signal] : [])]);
  const assertCurrent = () => {
    signal.throwIfAborted(); options.assertCurrent?.(); readProfileDelegation(options.delegation);
    depCurrent(); profileCurrent(); writerCurrent(); stateCurrent(); configCurrent(); dateCurrent(); clockCurrent();
    if (owner() !== deps || config.getConfigurationIncarnation?.() !== incarnation) throw new Error('Occasion operation owner changed.');
  };
  retainOccasionStateReceipts(assertCurrent, options);
  assertCurrent(); return { ...options, signal, assertCurrent };
}
