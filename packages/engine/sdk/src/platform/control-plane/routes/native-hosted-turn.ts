/** Identity-only authenticated entry; authority is supplied solely by the transport. */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { NATIVE_HOSTED_TURN_SCOPES, NativeHostedTurnError, type NativeHostedTurnHost } from '../../hosted-sessions/native-turn-host.js';
import { nativeHostedTurnRequestSchema, nativeHostedTurnLookupSchema, nativeHostedSessionRequestSchema, nativeHostedSessionLookupSchema } from '../../hosted-sessions/native-turn-wire.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
function authorize(invocation: GatewayMethodInvocation) {
  const context = invocation.context, authority = invocation.nativeExecutionAuthority, current = authority?.current();
  if (!context.admin || context.principalKind !== 'token' || !context.principalId || !authority || !current
    || current.kind !== 'pairing-token' || current.principalId !== context.principalId
    || current.authorityId !== current.principalId || current.authorityRevision !== current.tokenId
    || !NATIVE_HOSTED_TURN_SCOPES.every(scope => (context.scopes?.includes('*') || context.scopes?.includes(scope))
      && (current.scopes.includes('*') || current.scopes.includes(scope)))
    || invocation.isAuthorized?.(NATIVE_HOSTED_TURN_SCOPES) !== true) {
    throw new GatewayVerbError('Native hosted delivery requires a current paired admin with read:work-ledger, write:work-ledger and write:sessions', 'NATIVE_TURN_FORBIDDEN', 403);
  }
  return authority;
}
export function registerNativeHostedTurnGatewayMethods(catalog: GatewayMethodCatalog, host: NativeHostedTurnHost): void {
  const discovery = catalog.get('workLedger.turn.session');
  if (!discovery) throw new Error('Missing native hosted session descriptor');
  catalog.register(discovery, async invocation => {
    if (invocation.isAuthorized?.(['read:sessions']) !== true) throw new GatewayVerbError('Session discovery requires current read:sessions authority', 'FORBIDDEN', 403);
    const parsed = nativeHostedSessionRequestSchema.safeParse(readInvocationParams(invocation));
    if (!parsed.success) throw new GatewayVerbError('Invalid session identity', 'INVALID_ARGUMENT', 400);
    try {
      const result = await host.session(parsed.data.sessionId, invocation.nativeExecutionAuthority, { isAuthorized: () => {
        try { authorize(invocation); return true; } catch { return false; }
      } });
      if (invocation.isAuthorized?.(['read:sessions']) !== true) throw new GatewayVerbError('Session discovery authority changed', 'FORBIDDEN', 403);
      return nativeHostedSessionLookupSchema.parse(result);
    } catch (error) {
      if (error instanceof GatewayVerbError) throw error;
      if (error instanceof NativeHostedTurnError) throw new GatewayVerbError(error.message, `NATIVE_TURN_${error.code.replaceAll('-', '_').toUpperCase()}`, error.code === 'forbidden' ? 403 : 409);
      throw new GatewayVerbError('Native session ownership is unavailable. No legacy fallback was selected.', 'NATIVE_TURN_UNAVAILABLE', 503);
    }
  }, { replace: true });
  for (const operation of ['start', 'startAgent', 'status', 'cancel'] as const) {
    const descriptor = catalog.get(`workLedger.turn.${operation}`);
    if (!descriptor) throw new Error('Missing native hosted turn descriptor');
    catalog.register(descriptor, async invocation => {
      try {
        const authority = authorize(invocation), input = readInvocationParams(invocation);
        if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 2048) throw new GatewayVerbError('Native hosted turn identity exceeds the limit', 'INVALID_ARGUMENT', 400);
        const parsed = nativeHostedTurnRequestSchema.safeParse(input);
        if (!parsed.success) throw new GatewayVerbError('Invalid native hosted turn identity', 'INVALID_ARGUMENT', 400);
        invocation.signal?.throwIfAborted();
        const result = await host[operation](parsed.data, authority, { ...(invocation.signal ? { signal: invocation.signal } : {}), isAuthorized: () => {
          try { authorize(invocation); return true; } catch { return false; }
        } });
        authorize(invocation);
        return nativeHostedTurnLookupSchema.parse(result);
      } catch (error) {
        if (error instanceof GatewayVerbError) throw error;
        if (error instanceof NativeHostedTurnError) throw new GatewayVerbError(error.message, `NATIVE_TURN_${error.code.replaceAll('-', '_').toUpperCase()}`,
          error.code === 'forbidden' ? 403 : error.code === 'invalid' ? 400 : ['stale', 'not-turn', 'recovery-required'].includes(error.code) ? 409 : 503);
        throw new GatewayVerbError('Native hosted turn outcome is unknown. Inspect the original input before continuing.', 'NATIVE_TURN_UNAVAILABLE', 503);
      }
    }, { replace: true });
  }
}
