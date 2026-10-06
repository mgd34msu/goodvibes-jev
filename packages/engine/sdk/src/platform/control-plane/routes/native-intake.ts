/** Authenticated conversation admission only. Source text cannot select host authority. */
import { NativeSelectedDiffError } from '../../workflow/work-ledger/native-diff-context.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { WORK_LEDGER_WRITE_SCOPE } from '../method-catalog-native-work-submission.js';
import { WORK_LEDGER_READ_SCOPE } from '../method-catalog-work-ledger.js';
import { NativeConversationIntakeError, type NativeConversationIntakeHost } from '../../workflow/work-ledger/native-intake.js';
import {
  nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeLookupRequestSchema, nativeConversationIntakeTransitionRequestSchema,
  nativeConversationIntakeResultSchema, nativeConversationIntakeLookupResultSchema, NATIVE_CONVERSATION_INTAKE_MAX_REQUEST_BYTES,
} from '../../workflow/work-ledger/native-intake-wire.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
const SCOPES = [WORK_LEDGER_READ_SCOPE, WORK_LEDGER_WRITE_SCOPE] as const;
function authorize(invocation: GatewayMethodInvocation) {
  const context = invocation.context;
  if (!context.admin || !context.principalId || !SCOPES.every(scope => context.scopes?.includes('*') || context.scopes?.includes(scope))
    || invocation.isAuthorized?.(SCOPES) !== true) throw new GatewayVerbError('Native intake requires current owner access, read:work-ledger and write:work-ledger', 'FORBIDDEN', 403);
  const authority = invocation.nativeExecutionAuthority; const current = authority?.current();
  if (!authority || !current || context.principalKind !== 'token' || current.kind !== 'pairing-token' || current.principalId !== context.principalId
    || current.authorityId !== current.principalId || current.authorityRevision !== current.tokenId
    || !SCOPES.every(scope => current.scopes.includes('*') || current.scopes.includes(scope))) {
    throw new GatewayVerbError('Native intake requires a persisted paired-token owner; shared tokens and user sessions are unsupported', 'NATIVE_INTAKE_UNSUPPORTED_AUTHORITY', 403);
  }
  return authority;
}
export function registerNativeConversationIntakeGatewayMethods(catalog: GatewayMethodCatalog, host: Pick<NativeConversationIntakeHost, 'capture' | 'get' | 'admit' | 'resume' | 'cancel'>): void {
  for (const operation of ['capture', 'get', 'admit', 'resume', 'cancel'] as const) {
    const method = `workLedger.intake.${operation}`;
    const descriptor = catalog.get(method);
    if (!descriptor) throw new Error(`Missing native intake descriptor: ${method}`);
    catalog.register(descriptor, async invocation => {
      try {
        const authority = authorize(invocation); const input = readInvocationParams(invocation);
        if (new TextEncoder().encode(JSON.stringify(input)).byteLength > NATIVE_CONVERSATION_INTAKE_MAX_REQUEST_BYTES) throw new GatewayVerbError('Native intake exceeds the transport limit', 'NATIVE_INTAKE_LIMIT', 413);
        invocation.signal?.throwIfAborted();
        const options = { ...(invocation.signal ? { signal: invocation.signal } : {}), isAuthorized: () => invocation.isAuthorized?.(SCOPES) === true };
        if (operation === 'capture') {
          const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(input);
          if (!parsed.success) throw new GatewayVerbError('Invalid native conversation source', 'INVALID_ARGUMENT', 400);
          const result = await host.capture(parsed.data, authority, options);
          invocation.signal?.throwIfAborted(); authorize(invocation); return nativeConversationIntakeResultSchema.parse(result);
        }
        if (operation === 'get') {
          const parsed = nativeConversationIntakeLookupRequestSchema.safeParse(input);
          if (!parsed.success) throw new GatewayVerbError('Invalid native intake lookup', 'INVALID_ARGUMENT', 400);
          const result = await host.get(parsed.data, authority, options);
          invocation.signal?.throwIfAborted(); authorize(invocation); return nativeConversationIntakeLookupResultSchema.parse(result);
        }
        const parsed = nativeConversationIntakeTransitionRequestSchema.safeParse(input);
        if (!parsed.success) throw new GatewayVerbError('Invalid native intake source identity', 'INVALID_ARGUMENT', 400);
        const result = await host[operation](parsed.data, authority, options);
        invocation.signal?.throwIfAborted(); authorize(invocation); return nativeConversationIntakeResultSchema.parse(result);
      } catch (error) {
        if (error instanceof GatewayVerbError) throw error;
        if (error instanceof NativeSelectedDiffError) throw new GatewayVerbError(`Selected diff ${error.code}; inspect the current changes before submitting a new original`, `NATIVE_SELECTED_DIFF_${error.code.toUpperCase()}`, error.code === 'oversize' ? 413 : error.code === 'unsupported' ? 400 : 409);
        if (error instanceof NativeConversationIntakeError) {
          const status = ['unsupported-authority', 'forbidden'].includes(error.code) ? 403 : error.code === 'invalid' ? 400
            : ['stale', 'conflict', 'request-conflict', 'recovery-required'].includes(error.code) ? 409 : error.code === 'not-found' ? 404 : 503;
          throw new GatewayVerbError(error.code === 'indeterminate'
            ? 'Native intake outcome is unknown. Look up the original input before choosing recovery.'
            : `Native conversation intake ${error.code}`, `NATIVE_INTAKE_${error.code.replaceAll('-', '_').toUpperCase()}`, status);
        }
        throw new GatewayVerbError('Native conversation intake is unavailable; retain the original input identity', 'NATIVE_INTAKE_UNAVAILABLE', 503);
      }
    }, { replace: true });
  }
}
