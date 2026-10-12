/**
 * owner-profile-gateway.ts, how this surface reaches the nine `profile.*`
 * control-plane verbs.
 *
 * The owner profile is one Markdown file at daemon scope and the daemon is its
 * single writer (docs/owner-profile.md §3). A surface never opens the file; it
 * calls the verbs. This module is the one place that decides which way the call
 * travels, so no tool or CLI command has to know:
 *
 * - When this process carries the handlers itself, the Agent composes a real
 *   gateway method catalog (runtime/services.ts), the call runs in-process.
 * - Otherwise the call goes to the connected host over the operator gateway,
 *   the same path `ci`, `principals` and `channel-profiles` already use.
 *
 * The catalog is asked with `hasHandler`, not `get`: a descriptor with no
 * handler answers "not invokable", and silently degrading to that would look
 * like a profile with nothing in it. When neither route is available the caller
 * gets an honest unavailable result naming which route was missing.
 */

import { captureOccasionsGatewayTarget, type GatewayMethodCatalog, type GatewayMethodInvocation } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { assertCurrentProfileDelegation, bindProfileMutationOptionsToInvocation, type ProfileMutationOptions } from '@goodvibes-jev/engine/sdk/platform/owner-profile';
import { dirname } from 'node:path';
import { assertProjectionCurrent } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods, captureCatalogSnapshot } from '../tools/agent-harness-catalog-ranking.ts';
import { captureOperatorConnection } from './operator-connection-owner.ts';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/sdk/contracts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { PROFILE_METHOD_IDS, type ProfileMethodId } from '../tools/agent-profile-types.ts';
import {
  formatOperatorGatewayFailure,
  invokeOperatorGatewayMethod,
} from './operator-gateway-call.ts';
import {
  type AgentConnectedHostConfigReader,
} from './routine-schedule-promotion.ts';

export interface ProfileGatewayResult {
  readonly ok: boolean;
  /** Raw daemon payload; the caller narrows it (tools/agent-profile-types.ts). */
  readonly data: unknown;
  /** Present only when `ok` is false. Safe to show him, it never carries a profile value. */
  readonly error?: string;
  /** Which route the call actually took, for honest "where did this answer come from". */
  readonly route: 'in-process' | 'connected-host' | 'unavailable';
}

/**
 * Generic over the verb, so each call's body is checked against THAT verb's
 * declared input rather than against `Record<string, unknown>`.
 *
 * This is the guard that was missing when `profile.forget` dropped `lineIndex`:
 * the old signature accepted any record, so a body built for the previous
 * contract compiled clean and failed only against a live daemon. Now a stale
 * field or a missing required one is a compile error at the call site.
 */
export type ProfileGatewayInvoke = <TMethodId extends ProfileMethodId>(
  methodId: TMethodId,
  body: OperatorMethodInput<TMethodId>,
  options?: ProfileMutationOptions,
) => Promise<ProfileGatewayResult>;

export interface ProfileGatewayOptions {
  /** This process's own catalog, when it carries the profile handlers. */
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  readonly configManager: AgentConnectedHostConfigReader;
  readonly homeDirectory: string;
}

/**
 * The nine ids are in the generated operator contract, so `ProfileMethodId`
 * satisfies `OperatorMethodId` by assignment and the call below needs no widening
 * at all, if a verb is ever renamed or dropped, that call stops compiling.
 * `invokeOperatorGatewayMethod` resolves the real HTTP binding from the contract
 * the CONNECTED HOST serves, so an older host that does not know the verb answers
 * 404 and is classified as a route-unavailable failure rather than crashing.
 */
const _profileIdsAreOperatorIds: readonly OperatorMethodId[] = Object.values(PROFILE_METHOD_IDS);
void _profileIdsAreOperatorIds;

/** Informational labels only; the SDK resolves the real binding from the contract. */
const PROFILE_ROUTES: Readonly<Record<ProfileMethodId, string>> = {
  'profile.read': 'GET /api/profile',
  'profile.get': 'GET /api/profile/fields/{fieldId}',
  'profile.person': 'POST /api/profile/person',
  'profile.provenance': 'GET /api/profile/fields/{fieldId}/provenance',
  'profile.set': 'POST /api/profile/set',
  'profile.append': 'POST /api/profile/append',
  'profile.forget': 'POST /api/profile/forget',
  'profile.undo': 'POST /api/profile/undo',
  'profile.status': 'GET /api/profile/status',
};

export function profileRouteLabel(methodId: ProfileMethodId): string {
  return PROFILE_ROUTES[methodId];
}

export function createProfileGatewayInvoke(options: ProfileGatewayOptions): ProfileGatewayInvoke {
  const invoke: ProfileGatewayInvoke = async (methodId, body, lifetime = {}) => {
    const routing = captureProfileGatewayCurrent(invoke, methodId);
    const input = captureCatalogSnapshot(body);
    const restrictions = captureCatalogMethods(lifetime, ['signal', 'assertCurrent', 'delegation', 'onWriteIntent', 'onEffect', 'withPublication']);
    const assertCurrent = () => {
      restrictions(); lifetime.signal?.throwIfAborted(); assertProjectionCurrent(lifetime.assertCurrent);
      if (lifetime.delegation) assertCurrentProfileDelegation(lifetime.delegation);
      restrictions(); input.assertCurrent(body); routing();
    };
    assertCurrent();
    const catalog = options.gatewayMethods;
    if (catalog?.hasHandler(methodId)) {
      try {
        const invocation: GatewayMethodInvocation = {
          body, signal: lifetime.signal,
          isAuthorized: () => { assertCurrent(); return true; },
          context: { clientKind: 'goodvibes-agent', principalKind: lifetime.delegation ? 'service' : 'user' },
        };
        bindProfileMutationOptionsToInvocation(lifetime, invocation);
        const data = await catalog.invoke(methodId, invocation);
        assertCurrent();
        return { ok: true, data, route: 'in-process' };
      } catch (error) {
        assertCurrent();
        return { ok: false, data: null, error: summarizeError(error), route: 'in-process' };
      }
    }

    const connection = captureOperatorConnection(options, options.configManager, assertCurrent);
    assertCurrent();
    const remoteBody = lifetime.delegation ? { ...body, admission: 'autonomous' } : body;
    const result = await invokeOperatorGatewayMethod(connection, methodId, profileRouteLabel(methodId), remoteBody,
      { signal: lifetime.signal, assertCurrent: () => { assertCurrent(); connection.assertCurrent(); } });
    assertCurrent(); connection.assertCurrent();
    if (!result.ok) {
      return { ok: false, data: null, error: formatOperatorGatewayFailure(result), route: 'connected-host' };
    }
    return { ok: true, data: result.data, route: 'connected-host' };
  };
  gatewayOwners.set(invoke, options);
  return invoke;
}

const gatewayOwners = new WeakMap<ProfileGatewayInvoke, ProfileGatewayOptions>();

export function captureProfileGatewayCurrent(invoke: ProfileGatewayInvoke, methodId?: ProfileMethodId): () => void {
  const options = gatewayOwners.get(invoke);
  if (!options) return () => {};
  const optionsCurrent = captureCatalogMethods(options, ['gatewayMethods', 'configManager', 'homeDirectory']);
  const catalog = options.gatewayMethods, config = options.configManager, home = options.homeDirectory;
  const catalogCurrent = catalog && captureCatalogMethods(catalog, ['get', 'hasHandler', 'invoke']);
  const descriptor = methodId && catalog?.get(methodId);
  const descriptorCurrent = descriptor && captureCatalogSnapshot(descriptor);
  const inProcess = methodId !== undefined && catalog?.hasHandler(methodId);
  const connection = inProcess ? undefined : captureOperatorConnection(options, config, () => {});
  return () => {
    optionsCurrent(); catalogCurrent?.(); connection?.assertCurrent();
    if (methodId && descriptorCurrent) descriptorCurrent.assertCurrent(catalog?.get(methodId));
    if (options.gatewayMethods !== catalog || options.configManager !== config || options.homeDirectory !== home
      || (methodId && (catalog?.get(methodId) !== descriptor || catalog?.hasHandler(methodId) !== inProcess))) {
      throw new Error('Profile gateway owner changed.');
    }
  };
}

export function captureProfileGatewayLocalState(invoke: ProfileGatewayInvoke, method: ProfileMethodId, writing: boolean) {
  const catalog = gatewayOwners.get(invoke)?.gatewayMethods;
  // The native registrar publishes mutation targets; reads retain the same profile owner.
  const target = catalog && (captureOccasionsGatewayTarget(catalog, method)
    ?? captureOccasionsGatewayTarget(catalog, PROFILE_METHOD_IDS.set));
  if (!target) return undefined;
  const ownerCurrent = captureCatalogMethods(target, ['profilePath', 'captureProfileRead', 'assertOwnerCurrent']);
  const path = target.profilePath, read = target.captureProfileRead();
  let publishing = false;
  return {
    targets: [{ root: dirname(path), path, access: writing ? 'write' as const : 'read' as const }],
    assertCurrent() { ownerCurrent(); target.assertOwnerCurrent(); if (!publishing) read.assertCurrent(); },
    mutationPath() { return path; },
    onWriteIntent() { publishing = true; },
  };
}
