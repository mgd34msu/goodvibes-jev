/** A wire selection requests native admission; only the host's recorded decision permits the mutation. */
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { admitExternalRequest, type ExternalPermissionHost } from '../permissions/external-request.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import { assertConfirmed, HandlerError, type HandlerContextEnvelope } from './host-handlers.js';
import type { MutationPublication } from '../utils/file-mutation.js';
import type { ToolExecutionEffect } from '../tools/registry.js';
import type { RetainedAutomationJobTarget } from '../automation/job-mutations.js';
import { assertRetainedAutomationTargetCurrent, projectRetainedAutomationRequest } from '../automation/manager-runtime.js';

export type NativeMutationHost = ExternalPermissionHost;
export interface NativeMutationAdmission { readonly kind: 'native-recorded-mutation'; }
const nativeAdmissions = new WeakMap<NativeMutationAdmission, {
  readonly invocation: object | undefined;
  readonly method: string;
  readonly source: { readonly goal: string; readonly criteria: readonly string[] };
  readonly assertCurrent: () => void;
  readonly withPublication: MutationPublication;
}>();

/** In-process only. A copied object, JSON body, or arbitrary callback never grants this evidence. */
export function readNativeMutationAdmission(token: NativeMutationAdmission, invocation: object) {
  const admission = nativeAdmissions.get(token);
  if (!admission || admission.invocation !== invocation) throw new Error('Unknown native mutation admission');
  admission.assertCurrent(); return admission;
}

export function requestsNativeAdmission(body: unknown): boolean {
  if (!body || typeof body !== 'object' || nodeTypes.isProxy(body)) return false;
  const field = Object.getOwnPropertyDescriptor(body, 'admission');
  return field !== undefined && 'value' in field && field.value === 'autonomous';
}

export function retainNativeMutationRequest(body: unknown): () => void {
  const before = JSON.stringify(captureOwnedJson(body, nodeTypes.isProxy));
  return () => {
    if (JSON.stringify(captureOwnedJson(body, nodeTypes.isProxy)) !== before) {
      throw new HandlerError('Native mutation request changed', 'NATIVE_MUTATION_STALE', 409);
    }
  };
}

/** Native path identity stays local, including replacement with equal database bytes. */
export function retainMutationStorage(path: string, workspace: string): () => void {
  const root = realpathSync(workspace);
  const rootStat = lstatSync(root, { bigint: true });
  const identity = () => {
    try {
      const file = lstatSync(path, { bigint: true });
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Invalid native mutation storage');
      return [realpathSync(path), file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'absent';
      throw error;
    }
  };
  let ancestor = dirname(path);
  for (;;) {
    try { realpathSync(ancestor); break; } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent;
    }
  }
  const parent = realpathSync(ancestor), parentStat = lstatSync(parent, { bigint: true });
  const before = identity();
  return () => {
    const currentRoot = lstatSync(realpathSync(workspace), { bigint: true });
    const currentParent = lstatSync(realpathSync(ancestor), { bigint: true });
    if (realpathSync(workspace) !== root || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino
      || realpathSync(ancestor) !== parent || currentParent.dev !== parentStat.dev || currentParent.ino !== parentStat.ino
      || identity() !== before) throw new HandlerError('Native mutation target changed', 'NATIVE_MUTATION_STALE', 409);
  };
}

export async function runNativeMutation<T>(input: {
  readonly host?: NativeMutationHost | undefined;
  readonly method: string;
  readonly body: unknown;
  readonly context: HandlerContextEnvelope;
  readonly invocation?: object | undefined;
  readonly target: unknown;
  readonly automationTarget?: RetainedAutomationJobTarget | undefined;
  readonly assertTargetCurrent: () => void;
  readonly scopes?: readonly string[] | undefined;
  readonly confirmation?: 'required' | 'none' | undefined;
  /** Native registrar selection, never inferred from the remote body. */
  readonly effect?: ToolExecutionEffect | undefined;
  readonly mutate: (assertCurrent: () => void, admission?: NativeMutationAdmission, withPublication?: MutationPublication) => Promise<T>;
}): Promise<T> {
  const { body, context } = input;
  if (!requestsNativeAdmission(body)) {
    if (input.confirmation !== 'none') assertConfirmed(body, context);
    const current = () => { context.signal?.throwIfAborted(); };
    current(); return input.mutate(current);
  }
  const host = input.host, authority = context.nativeExecutionAuthority, expected = authority?.current();
  const scopes = input.scopes ?? ['write:channels'];
  const effect = input.effect ?? 'write';
  if (!host || host.workspaceTrust === undefined || !authority || !expected || !context.admin || context.principalKind !== 'token'
    || context.principalId !== expected.principalId || expected.kind !== 'pairing-token'
    || !scopes.every(scope => context.scopes.includes('*') || context.scopes.includes(scope))
    || !scopes.every(scope => expected.scopes.includes('*') || expected.scopes.includes(scope))
    || context.isAuthorized?.(scopes) !== true) {
    throw new HandlerError('Native mutation requires current paired owner access and native write scopes', 'NATIVE_MUTATION_FORBIDDEN', 403);
  }
  // Keep the complete original bytes local and project only through the canonical protected boundary.
  const original = captureOwnedJson(body, nodeTypes.isProxy);
  const originalBytes = JSON.stringify(original);
  const automationTarget = input.automationTarget, originalMethod = input.method;
  const request = automationTarget === undefined ? original
    : projectRetainedAutomationRequest(automationTarget, originalMethod, original);
  const args = { method: input.method, request: snapshotJudgmentInput(request), selectedTarget: snapshotJudgmentInput(input.target) };
  const invalidation = new AbortController();
  const unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
  const signal = AbortSignal.any([host.signal, invalidation.signal, ...(context.signal ? [context.signal] : [])]);
  const source = Object.freeze({ goal: `Perform the authenticated native request ${input.method}.`, criteria: Object.freeze([
    'Apply exactly the complete authenticated request to the retained selected target.',
    'Honor current paired owner, admin, write scope, workspace, privacy and permission constraints.',
    effect === 'send' ? 'Deliver only the complete retained message to the exact retained destination; do not purchase or select additional targets.'
      : 'This request does not authorize message delivery, purchases or additional targets.',
  ]) });
  const expectedAuthority = JSON.stringify(expected);
  const originalContext = JSON.stringify({ principalId: context.principalId, principalKind: context.principalKind,
    admin: context.admin, scopes: context.scopes, explicitUserRequest: context.explicitUserRequest });
  const authorized = context.isAuthorized, originalSignal = context.signal;
  const assertPaired = () => {
    if (JSON.stringify(authority.current()) !== expectedAuthority) {
      throw new HandlerError('Native mutation paired owner changed', 'NATIVE_MUTATION_STALE', 409);
    }
  };
  const assertCurrent = () => {
    signal.throwIfAborted(); assertPaired();
    if (input.automationTarget !== automationTarget || (automationTarget !== undefined && input.method !== originalMethod)) {
      throw new HandlerError('Native mutation selected reference changed', 'NATIVE_MUTATION_STALE', 409);
    }
    if (automationTarget !== undefined) assertRetainedAutomationTargetCurrent(automationTarget);
    if (context.isAuthorized !== authorized || context.signal !== originalSignal || context.isAuthorized?.(scopes) !== true || context.nativeExecutionAuthority !== authority
      || JSON.stringify({ principalId: context.principalId, principalKind: context.principalKind,
        admin: context.admin, scopes: context.scopes, explicitUserRequest: context.explicitUserRequest }) !== originalContext
      || JSON.stringify(captureOwnedJson(body, nodeTypes.isProxy)) !== originalBytes) {
      throw new HandlerError('Native mutation authority changed', 'NATIVE_MUTATION_STALE', 409);
    }
    input.assertTargetCurrent();
  };
  try {
    assertCurrent();
    const admission = await admitExternalRequest(host, { connectionId: randomUUID(), destination: input.method, signal, assertCurrent },
      { sourceOf: () => source, assertCurrent, signal }, { tool: effect === 'send' ? 'send_message' : 'write', args, effect,
        serverPolicy: { principalKind: 'paired-token', admin: true, scopes, effect, method: input.method } }).catch(error => {
          // Before claim, the original native source can identify retirement
          // hidden by a failed reading. No effect has been attempted here.
          assertCurrent(); throw error;
        });
    try {
      assertCurrent();
      if (!admission.result.approved) {
        throw new HandlerError('Native mutation was not admitted', 'NATIVE_MUTATION_HELD', 422);
      }
      admission.claim(); assertCurrent();
      let active = true;
      const current = () => { if (!active) throw new Error('Native mutation admission retired'); assertCurrent(); admission.assertCurrent(); };
      // Staging and hosted admission remain outside the pairing owner's lock.
      // Only the actual native writer calls this private publication keeper.
      const withPublication: MutationPublication = async operation => {
        current();
        return authority.withCurrent(expected, async assertPublication => {
          const publicationCurrent = () => { assertPublication(); current(); };
          publicationCurrent();
          const result = await operation(publicationCurrent);
          // The exact writer owns its selected-target transition. Rechecking
          // the old target after publication would reject the intended effect.
          assertPublication(); signal.throwIfAborted(); return result;
        });
      };
      const token: NativeMutationAdmission = Object.freeze({ kind: 'native-recorded-mutation' });
      nativeAdmissions.set(token, Object.freeze({ invocation: input.invocation, method: input.method, source,
        assertCurrent: current, withPublication }));
      try { current(); return await input.mutate(current, token, withPublication); }
      finally { active = false; nativeAdmissions.delete(token); }
    } finally { admission.close(); }
  } finally { unsubscribe(); }
}
