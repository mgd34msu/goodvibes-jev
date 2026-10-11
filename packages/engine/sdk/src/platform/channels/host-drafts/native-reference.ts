import { types as nodeTypes } from 'node:util';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { HandlerError, type HandlerContextEnvelope } from '../../control-plane/host-handlers.js';
import { captureMutationDescriptors } from '../../utils/file-mutation.js';
import { DraftSyncStore, type NativeDraftReferenceTarget } from './draft-store.js';
import { isNativeDraftWireReference } from './wire-reference.js';

declare const requestBrand: unique symbol;
export interface NativeDraftReferenceRequest { readonly [requestBrand]: true; }
interface RequestSource {
  readonly reference: string;
  readonly assertCurrent: () => void;
}
const requests = new WeakMap<NativeDraftReferenceRequest, RequestSource>();
const refused = () => new HandlerError('Native draft reference requires current paired owner access', 'NATIVE_DRAFT_REFERENCE_FORBIDDEN', 403);
const stale = () => new HandlerError('Native draft reference source changed', 'NATIVE_DRAFT_REFERENCE_STALE', 409);

/** The parser owns this capture before any await; wire handles are selectors, never grants. */
export function retainNativeDraftReferenceRequest(
  body: unknown,
  context: HandlerContextEnvelope,
  assertOwner: () => void,
  field: 'id' | 'draftId' = 'id',
): NativeDraftReferenceRequest | undefined {
  const original = captureOwnedJson(body, nodeTypes.isProxy);
  const selected = original && typeof original === 'object' && !Array.isArray(original)
    ? Object.getOwnPropertyDescriptor(original, field) : undefined;
  const reference: unknown = selected && 'value' in selected ? selected.value : undefined;
  if (typeof reference !== 'string' || !isNativeDraftWireReference(reference)) return undefined;
  const admission = Object.getOwnPropertyDescriptor(original, 'admission');
  const authority = context.nativeExecutionAuthority;
  const expected = authority?.current();
  if (!admission || !('value' in admission) || admission.value !== 'autonomous' || !authority || !expected
    || expected.kind !== 'pairing-token' || context.principalKind !== 'token' || !context.admin
    || context.principalId !== expected.principalId || context.isAuthorized?.(['write:channels']) !== true
    || !(context.scopes.includes('*') || context.scopes.includes('write:channels'))
    || !(expected.scopes.includes('*') || expected.scopes.includes('write:channels'))) throw refused();
  const bytes = JSON.stringify(original), paired = JSON.stringify(expected);
  const contextBytes = () => JSON.stringify({ principalId: context.principalId, principalKind: context.principalKind,
    admin: context.admin, scopes: context.scopes, explicitUserRequest: context.explicitUserRequest });
  const principal = contextBytes();
  const ownerCurrent = captureMutationDescriptors(context, ['nativeExecutionAuthority', 'isAuthorized', 'signal', 'authToken']);
  const authorityCurrent = captureMutationDescriptors(authority, ['current', 'withCurrent']);
  const token: NativeDraftReferenceRequest = Object.freeze({}) as NativeDraftReferenceRequest;
  const assertCurrent = () => {
    if (!requests.has(token)) throw stale();
    context.signal?.throwIfAborted(); assertOwner(); ownerCurrent(); authorityCurrent();
    if (JSON.stringify(captureOwnedJson(body, nodeTypes.isProxy)) !== bytes || contextBytes() !== principal
      || JSON.stringify(authority.current()) !== paired || context.isAuthorized?.(['write:channels']) !== true) throw stale();
    context.signal?.throwIfAborted(); assertOwner();
  };
  requests.set(token, { reference, assertCurrent });
  try { assertCurrent(); return token; }
  catch (error) { requests.delete(token); throw error; }
}

/** Only the private parser capsule can resolve the full retained native source. */
export async function resolveNativeDraftReferenceRequest(
  request: NativeDraftReferenceRequest,
  store: DraftSyncStore,
): Promise<NativeDraftReferenceTarget> {
  const source = requests.get(request);
  if (!source || !(store instanceof DraftSyncStore)) throw refused();
  source.assertCurrent();
  const target = await store.retainReferenceTarget(source.reference, source.assertCurrent);
  source.assertCurrent(); target.assertCurrent();
  return target;
}

export function assertNativeDraftReferenceRequest(request: NativeDraftReferenceRequest): void {
  const source = requests.get(request);
  if (!source) throw stale();
  source.assertCurrent();
}

export function releaseNativeDraftReferenceRequest(request: NativeDraftReferenceRequest): void {
  requests.delete(request);
}
