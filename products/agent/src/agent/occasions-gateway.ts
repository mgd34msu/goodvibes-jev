/**
 * occasions-gateway.ts, how this surface reaches the sixteen `occasions.*`
 * control-plane verbs.
 *
 * Occasions are lines in the owner's profile and the acknowledgement state is a
 * separate machine-owned store; the daemon owns both (docs/occasions.md §3). A
 * surface never opens either one, it calls the verbs. This module is the one
 * place that decides which way the call travels, so no tool, nudge surface or
 * CLI command has to know:
 *
 * - When this process carries the handlers itself, the Agent composes a real
 *   gateway method catalog (runtime/services.ts, which threads configManager and
 *   shellPaths into the SDK's registrar), the call runs in-process.
 * - Otherwise the call goes to the connected host over the operator gateway,
 *   the same path `profile`, `ci`, `principals` and `channel-profiles` use.
 *
 * Written as a deliberate copy of owner-profile-gateway.ts rather than a shared
 * generic: the two families differ in which verbs exist and what a failure
 * means, and the one thing they must share, the route decision, is four lines
 * that read better twice than they do behind an abstraction.
 *
 * The catalog is asked with `hasHandler`, not `get`: a descriptor with no
 * handler answers "not invokable", and silently degrading to that would look
 * like an owner with no dates recorded. When neither route is available the
 * caller gets an honest unavailable result naming which route was missing.
 *
 * ## Nothing here decides anything
 *
 * No lead window is computed here, no proximity word is chosen here, no kind is
 * defaulted here, and no date is formatted here. docs/occasions.md §7 is
 * explicit that a consumer computing anything beyond calling these verbs and
 * rendering the answers is a second implementation of a rule that lives in the
 * daemon, most dangerously the rule that a nudge never carries the date.
 */

import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/sdk/contracts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { OCCASIONS_METHOD_IDS, type OccasionsMethodId } from '../tools/agent-occasions-types.ts';
import {
  formatOperatorGatewayFailure,
  invokeOperatorGatewayMethod,
} from './operator-gateway-call.ts';
import {
  resolveAgentConnectedHostConnection,
  type AgentConnectedHostConfigReader,
} from './routine-schedule-promotion.ts';

export interface OccasionsGatewayResult {
  readonly ok: boolean;
  /** Raw daemon payload; the caller narrows it (tools/agent-occasions-types.ts). */
  readonly data: unknown;
  /** Present only when `ok` is false. Safe to show him, it never carries a date. */
  readonly error?: string;
  /** Which route the call actually took, for honest "where did this answer come from". */
  readonly route: 'in-process' | 'connected-host' | 'unavailable';
}

/**
 * Generic over the verb, so each call's body is checked against THAT verb's
 * declared input rather than against `Record<string, unknown>`.
 *
 * Same guard `ProfileGatewayInvoke` carries, and for the same reason: the three
 * write verbs here (`occasions.confirm`, `occasions.plans.confirm`,
 * `occasions.remove`) take a required `authority`, and an operator client with a
 * loose overload beneath its typed one would accept a body that omitted it. See
 * src/test/agent/operator-payload-conformance.test.ts for the measured table.
 */
export type OccasionsGatewayInvoke = <TMethodId extends OccasionsMethodId>(
  methodId: TMethodId,
  body: OperatorMethodInput<TMethodId>,
) => Promise<OccasionsGatewayResult>;

export interface OccasionsGatewayOptions {
  /** This process's own catalog, when it carries the occasions handlers. */
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  readonly configManager: AgentConnectedHostConfigReader;
  readonly homeDirectory: string;
}

/**
 * The sixteen ids are in the generated operator contract, so `OccasionsMethodId`
 * satisfies `OperatorMethodId` by assignment and the call below needs no widening
 * at all, if a verb is ever renamed or dropped, that call stops compiling.
 */
const _occasionsIdsAreOperatorIds: readonly OperatorMethodId[] = Object.values(OCCASIONS_METHOD_IDS);
void _occasionsIdsAreOperatorIds;

/** Informational labels only; the SDK resolves the real binding from the contract. */
const OCCASIONS_ROUTES: Readonly<Record<OccasionsMethodId, string>> = {
  'occasions.list': 'GET /api/occasions',
  'occasions.pending': 'GET /api/occasions/pending',
  'occasions.state': 'GET /api/occasions/state',
  'occasions.sweep': 'POST /api/occasions/sweep',
  'occasions.propose': 'POST /api/occasions/propose',
  'occasions.confirm': 'POST /api/occasions/confirm',
  'occasions.remove': 'POST /api/occasions/remove',
  'occasions.answer': 'POST /api/occasions/answer',
  'occasions.interview.get': 'GET /api/occasions/interview',
  'occasions.interview.answer': 'POST /api/occasions/interview/answer',
  'occasions.interview.record': 'POST /api/occasions/interview/record',
  'occasions.gifts': 'GET /api/occasions/gifts',
  'occasions.conflict.resolve': 'POST /api/occasions/conflict/resolve',
  'occasions.plans.list': 'GET /api/occasions/plans',
  'occasions.plans.propose': 'POST /api/occasions/plans/propose',
  'occasions.plans.confirm': 'POST /api/occasions/plans/confirm',
};

export function occasionsRouteLabel(methodId: OccasionsMethodId): string {
  return OCCASIONS_ROUTES[methodId];
}

export function createOccasionsGatewayInvoke(
  options: OccasionsGatewayOptions,
): OccasionsGatewayInvoke {
  return async (methodId, body) => {
    const catalog = options.gatewayMethods;
    if (catalog?.hasHandler(methodId)) {
      try {
        const data = await catalog.invoke(methodId, {
          body,
          // `principalKind: 'user'` is what `refuseNonUserRequest` reads on the
          // three write verbs. It is truthful here: every write reached through
          // this invoker originates in something the owner said this turn, and
          // the tool that calls it requires him to have said it.
          context: { clientKind: 'goodvibes-agent', principalKind: 'user' },
        });
        return { ok: true, data, route: 'in-process' };
      } catch (error) {
        return { ok: false, data: null, error: summarizeError(error), route: 'in-process' };
      }
    }

    const connection = resolveAgentConnectedHostConnection(options.configManager, options.homeDirectory);
    const result = await invokeOperatorGatewayMethod(
      connection,
      methodId,
      occasionsRouteLabel(methodId),
      body,
    );
    if (!result.ok) {
      return { ok: false, data: null, error: formatOperatorGatewayFailure(result), route: 'connected-host' };
    }
    return { ok: true, data: result.data, route: 'connected-host' };
  };
}
