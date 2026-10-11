import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { normalizeContext } from '../host-handlers.js';
import { requestsNativeAdmission, retainNativeMutationRequest, runNativeMutation, type NativeMutationHost } from '../native-mutation.js';
import { bindProfileDelegationToInvocation, captureNativeProfileDelegation, profileDelegationForInvocation, profileMutationOptionsForInvocation } from '../../owner-profile/delegation.js';
import type { OccasionMutationOptions } from '../../occasions/operation.js';
import { readStoppedNativeNudge } from '../../occasions/push.js';
import { captureFileMutation, captureMutationDescriptors } from '../../utils/file-mutation.js';
import { GatewayVerbError } from './gateway-verb-error.js';

export interface NativeProfileTarget {
  readonly profilePath: string;
  readonly statePath?: string | undefined;
  readonly captureProfileRead: () => { readonly assertCurrent: () => void };
  readonly captureStateRead?: (() => { readonly assertCurrent: () => void }) | undefined;
  readonly assertOwnerCurrent: () => void;
}
type NativeProfileOptions = OccasionMutationOptions;
type NativeNudgeDelivery = NonNullable<OccasionMutationOptions['withNudgeDelivery']>;
// These are native nudge producer identities, never caller-authored message
// text. Keep their exact lossless identity without PAN-shaped protocol clocks.
const nativeNudgeIdentity = (value: string) => `native-id:${Buffer.from(value).toString('hex').replace(/[0-9a-f]/g, digit =>
  String.fromCharCode(97 + Number.parseInt(digit, 16)))}`;
const mutationOptions = new WeakMap<object, NativeProfileOptions>();
const targets = new WeakMap<GatewayMethodCatalog, ReadonlyMap<string, NativeProfileTarget>>();

/** Only the actual registrar publishes these native owner descriptors. */
export function registerNativeProfileTargets(catalog: GatewayMethodCatalog, methods: readonly string[], target: NativeProfileTarget): void {
  const next = new Map(targets.get(catalog));
  for (const method of methods) next.set(method, target);
  targets.set(catalog, next);
}
export function captureOccasionsGatewayTarget(catalog: GatewayMethodCatalog, method: string): NativeProfileTarget | undefined {
  const target = targets.get(catalog)?.get(method);
  target?.assertOwnerCurrent();
  return target;
}

export function profileMutationOptions(invocation: GatewayMethodInvocation, scopes?: readonly string[]): NativeProfileOptions {
  const retained = mutationOptions.get(invocation) ?? profileMutationOptionsForInvocation(invocation);
  const signal = invocation.signal && retained?.signal ? AbortSignal.any([invocation.signal, retained.signal]) : invocation.signal ?? retained?.signal;
  return { ...retained, signal, delegation: profileDelegationForInvocation(invocation), assertCurrent: () => {
    signal?.throwIfAborted();
    if (invocation.isAuthorized?.(scopes) === false) throw new Error('Profile request is no longer authorized.');
    retained?.assertCurrent?.();
  } };
}

/** Selects fresh server admission. The original human protocol remains independently enforced. */
export function nativeProfileMutation(catalog: GatewayMethodCatalog, method: string, handler: GatewayMethodHandler,
  host: NativeMutationHost | undefined, target: NativeProfileTarget | undefined, provenance = true): GatewayMethodHandler {
  return async invocation => {
    if (!requestsNativeAdmission(invocation.body)) return handler(invocation);
    const sourceCurrent = retainNativeMutationRequest({ body: invocation.body ?? null, query: invocation.query ?? null, context: invocation.context });
    sourceCurrent();
    const body = invocation.body;
    if (provenance && (!body || typeof body !== 'object' || !('authority' in body) || body.authority !== 'autonomous'
      || ('said' in body && body.said !== ''))) {
      throw new GatewayVerbError('Native autonomous provenance requires authority autonomous and no claimed human quote.', 'INVALID_ARGUMENT', 400);
    }
    if (!target) throw new GatewayVerbError('Native profile target is unavailable.', 'NATIVE_MUTATION_FORBIDDEN', 403);
    const descriptor = catalog.get(method);
    const invocationCurrent = captureMutationDescriptors(invocation, ['body', 'query', 'context', 'signal', 'isAuthorized', 'nativeExecutionAuthority']);
    const ownerCurrent = captureMutationDescriptors(target, ['profilePath', 'statePath', 'captureProfileRead', 'captureStateRead', 'assertOwnerCurrent']);
    const profileRead = target.captureProfileRead();
    const profileFile = captureFileMutation(target.profilePath);
    const stateRead = target.captureStateRead?.();
    const stateFile = target.statePath ? captureFileMutation(target.statePath) : undefined;
    let profileIntent = false, stateIntent = false;
    const assertTargetCurrent = () => {
      sourceCurrent(); invocationCurrent(); ownerCurrent(); target.assertOwnerCurrent();
      if (catalog.get(method) !== descriptor) throw new Error('Native profile method changed.');
      if (!profileIntent) profileRead.assertCurrent();
      if (!stateIntent) stateRead?.assertCurrent();
      profileFile.assertCurrent(); stateFile?.assertCurrent();
    };
    return runNativeMutation({ host, method, invocation, body: { admission: 'autonomous', body: invocation.body ?? null, query: invocation.query ?? null },
      context: { ...normalizeContext(invocation.context), signal: invocation.signal,
        nativeExecutionAuthority: invocation.nativeExecutionAuthority, isAuthorized: invocation.isAuthorized },
      target: { domain: 'owner-profile', method }, assertTargetCurrent,
      scopes: descriptor?.scopes ?? [], confirmation: 'none', mutate: async (assertCurrent, admission, withPublication) => {
        if (!admission) throw new Error('Recorded native profile admission is unavailable.');
        const delegation = captureNativeProfileDelegation(admission, invocation);
        bindProfileDelegationToInvocation(delegation, invocation);
        mutationOptions.set(invocation, { assertCurrent, delegation, withPublication,
          onWriteIntent: () => { assertCurrent(); profileIntent = true; },
          onEffect: published => { sourceCurrent(); invocationCurrent(); target.assertOwnerCurrent(); profileFile.onEffect(published); stateFile?.onEffect(); },
          onStateWriteIntent: () => { assertCurrent(); stateIntent = true; },
          onStateEffect: published => { sourceCurrent(); invocationCurrent(); target.assertOwnerCurrent(); stateFile?.onEffect(published); profileFile.onEffect(); },
          ...(method === 'occasions.sweep' ? { withNudgeDelivery: async (request: Parameters<NativeNudgeDelivery>[0], operation: Parameters<NativeNudgeDelivery>[1]) => {
            assertCurrent();
            const deliveryCurrent = retainNativeMutationRequest(request);
            const nudgeMeaning = { ...request.nudge, id: nativeNudgeIdentity(request.nudge.id),
              raisedAt: new Date(request.nudge.raisedAt).toISOString(),
              subjects: request.nudge.subjects.map(subject => ({ ...subject, occasionId: nativeNudgeIdentity(subject.occasionId) })) };
            return runNativeMutation({ host, method: 'occasions.sweep.deliver', invocation,
              body: { admission: 'autonomous', parent: { body: invocation.body ?? null, query: invocation.query ?? null },
                delivery: { channel: request.channel, nudge: nudgeMeaning } },
              context: { ...normalizeContext(invocation.context), signal: invocation.signal,
                nativeExecutionAuthority: invocation.nativeExecutionAuthority, isAuthorized: invocation.isAuthorized },
              target: { domain: 'occasion-nudge', channel: request.channel, nudge: nudgeMeaning },
              assertTargetCurrent: () => { assertCurrent(); deliveryCurrent(); }, scopes: descriptor?.scopes ?? [],
              confirmation: 'none', effect: 'send', mutate: async (sendCurrent, _sendAdmission, withDeliveryPublication) => operation({
                signal: AbortSignal.any([...(host ? [host.signal] : []), ...(invocation.signal ? [invocation.signal] : [])]),
                assertCurrent: () => { assertCurrent(); sendCurrent(); },
                withPublication: withDeliveryPublication,
              }) });
          } } : {}),
        });
        try { return await handler(invocation); }
        catch (error) {
          const delivery = mutationOptions.get(invocation)?.withNudgeDelivery;
          const receipt = delivery ? readStoppedNativeNudge(error, delivery) : undefined;
          if (receipt) return receipt;
          throw error;
        }
        finally { mutationOptions.delete(invocation); }
      } });
  };
}
