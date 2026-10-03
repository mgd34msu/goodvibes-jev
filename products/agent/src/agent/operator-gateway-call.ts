/**
 * Typed connected-host operator gateway calls for CLI and Agent features.
 * Failure reporting shares the engine contract used by schedule commands;
 * classification never retries an operator mutation.
 */
import { createBrowserGoodVibesSdk } from '@goodvibes-jev/engine/sdk/browser';
import type { OperatorMethodId, OperatorMethodInput, OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import { classifyConnectedHostError } from './connected-host-failure.ts';
import type { AgentConnectedHostConnection } from './routine-schedule-promotion.ts';

export type OperatorGatewayCallFailureKind =
  | 'auth_required'
  | 'connected_host_unavailable'
  | 'connected_host_incompatible'
  | 'connected_host_route_unavailable'
  | 'connected_host_error';

export interface OperatorGatewayCallSuccess<T> {
  readonly ok: true;
  readonly data: T;
  readonly methodId: OperatorMethodId;
  readonly route: string;
}

export interface OperatorGatewayCallFailure {
  readonly ok: false;
  readonly kind: OperatorGatewayCallFailureKind;
  readonly error: string;
  readonly methodId: OperatorMethodId;
  readonly route: string;
  readonly baseUrl?: string;
}

export type OperatorGatewayCallResult<T> = OperatorGatewayCallSuccess<T> | OperatorGatewayCallFailure;

/**
 * Invoke one operator gateway method against the connected host, returning a
 * discriminated result instead of throwing. `route` is an informational HTTP
 * route label used in error/preview output; the SDK's operator.invoke resolves
 * the actual HTTP method/path from the operator contract itself.
 *
 * ## Why the payload is typed against the method id
 *
 * This used to take `payload: unknown` and call `invoke(methodId, payload as never)`.
 * That was a total opt-out: no operator body the agent sent was ever checked
 * against its declared input, for any method. Two breaking contract changes
 * landed during one round, `authority` becoming required on the profile write
 * verbs, then `profile.forget` dropping `lineIndex`, and both compiled clean
 * here and were caught only by reading the platform source.
 *
 * The SDK's typed overload was correct all along. The escape is the loose one
 * beneath it (`invoke<T>(methodId: string, input?: Record<string, unknown>)`):
 * a known method id carrying a wrong body fails the typed overload and silently
 * matches the loose one, and `as never` guaranteed the typed overload was never
 * reached at all. Binding the payload to `OperatorMethodInput<TMethodId>` and
 * dropping the cast puts every call site back on the typed overload, so the next
 * contract change is a compile error rather than a runtime 400.
 *
 * A method whose generated type is genuinely wrong should cast at ITS OWN call
 * site, visibly, rather than every call site opting out through this one.
 */
export async function invokeOperatorGatewayMethod<TMethodId extends OperatorMethodId>(
  connection: AgentConnectedHostConnection,
  methodId: TMethodId,
  route: string,
  payload: OperatorMethodInput<TMethodId>,
): Promise<OperatorGatewayCallResult<OperatorMethodOutput<TMethodId>>> {
  if (!connection.token) {
    return {
      ok: false,
      kind: 'auth_required',
      error: `No connected-host operator token found at ${connection.tokenPath}`,
      methodId,
      route,
      baseUrl: connection.baseUrl,
    };
  }
  try {
    const sdk = createBrowserGoodVibesSdk({ baseUrl: connection.baseUrl, authToken: connection.token });
    // The SDK's typed overload takes a CONDITIONAL argument tuple
    // (`MethodArgs` makes the input optional when every key is optional), and a
    // conditional type cannot be resolved against a still-generic `TMethodId`
    // inside this function. So the tuple shape, and only the tuple shape, is
    // asserted here, at the single seam, with both ends of it still bound to
    // `TMethodId`. Every caller is checked: a wrong body or a wrong expected
    // output is a compile error at the call site, which is exactly what the old
    // `payload as never` gave away.
    const invokeTyped = sdk.operator.invoke as unknown as (
      methodId: TMethodId,
      input: OperatorMethodInput<TMethodId>,
    ) => Promise<OperatorMethodOutput<TMethodId>>;
    const data = await invokeTyped(methodId, payload);
    return { ok: true, data, methodId, route };
  } catch (error) {
    const failure = await classifyConnectedHostError(error, connection, {
      route,
      incompatibleMessage: `Connected GoodVibes host compatibility does not satisfy Agent requirements; ${methodId} is unavailable.`,
      site: 'agent.operator-gateway.failure',
    });
    return { ...failure, methodId };
  }
}

export function formatOperatorGatewayFailure(failure: OperatorGatewayCallFailure): string {
  const lines = [
    `Connected-host call failed: ${failure.methodId} (${failure.kind})`,
    `  route ${failure.route}`,
    failure.baseUrl ? `  connected host ${failure.baseUrl}` : '',
    `  ${failure.error}`,
  ];
  return lines.filter(Boolean).join('\n');
}
