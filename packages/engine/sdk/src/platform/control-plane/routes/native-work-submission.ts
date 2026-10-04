/** Authenticated explicit-source submission. Host authority never comes from the body. */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { WORK_LEDGER_WRITE_SCOPE } from '../method-catalog-native-work-submission.js';
import { WORK_LEDGER_READ_SCOPE } from '../method-catalog-work-ledger.js';
import { NativeWorkSubmissionError, type NativeWorkSubmissionHost } from '../../workflow/work-ledger/native-submission.js';
import {
  nativeWorkSubmissionRequestSchema, nativeWorkSubmissionLookupRequestSchema,
  nativeWorkSubmissionResultSchema, nativeWorkSubmissionLookupResultSchema,
  NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES,
} from '../../workflow/work-ledger/native-submission-wire.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

const SCOPES = [WORK_LEDGER_READ_SCOPE, WORK_LEDGER_WRITE_SCOPE] as const;
function authorize(invocation: GatewayMethodInvocation) {
  const context = invocation.context;
  if (!context.admin || !context.principalId || !SCOPES.every(scope => context.scopes?.includes('*') || context.scopes?.includes(scope))
    || invocation.isAuthorized?.(SCOPES) !== true) throw new GatewayVerbError('Native submission requires current owner access, read:work-ledger and write:work-ledger', 'FORBIDDEN', 403);
  const authority = invocation.nativeExecutionAuthority; const current = authority?.current();
  if (!authority || !current || context.principalKind !== 'token' || current.kind !== 'pairing-token' || current.principalId !== context.principalId
    || !SCOPES.every(scope => current.scopes.includes('*') || current.scopes.includes(scope))) {
    throw new GatewayVerbError('Native submission requires a persisted paired-token owner; shared tokens and user sessions are unsupported', 'NATIVE_SUBMISSION_UNSUPPORTED_AUTHORITY', 403);
  }
  return authority;
}

/** Trusted daemon ledger owner. Neither handler acquires an execution graph. */
export function registerNativeWorkSubmissionGatewayMethods(catalog: GatewayMethodCatalog, host: Pick<NativeWorkSubmissionHost, 'submit' | 'get'>): void {
  for (const operation of ['submit', 'get'] as const) {
    const method = operation === 'submit' ? 'workLedger.submit' : 'workLedger.submission.get';
    const descriptor = catalog.get(method);
    if (!descriptor) throw new Error(`Missing native submission descriptor: ${method}`);
    catalog.register(descriptor, async invocation => {
      try {
        const authority = authorize(invocation);
        const input = readInvocationParams(invocation);
        if (new TextEncoder().encode(JSON.stringify(input)).byteLength > NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES) throw new GatewayVerbError('Native submission exceeds the transport limit', 'NATIVE_SUBMISSION_LIMIT', 413);
        invocation.signal?.throwIfAborted();
        const options = { ...(invocation.signal ? { signal: invocation.signal } : {}), isAuthorized: () => invocation.isAuthorized?.(SCOPES) === true };
        if (operation === 'submit') {
          const parsed = nativeWorkSubmissionRequestSchema.safeParse(input);
          if (!parsed.success) throw new GatewayVerbError('Invalid explicit native source', 'INVALID_ARGUMENT', 400);
          const result = await host.submit(parsed.data, authority, options);
          authorize(invocation); return nativeWorkSubmissionResultSchema.parse(result);
        }
        const parsed = nativeWorkSubmissionLookupRequestSchema.safeParse(input);
        if (!parsed.success) throw new GatewayVerbError('Invalid native submission lookup', 'INVALID_ARGUMENT', 400);
        const result = await host.get(parsed.data, authority, options);
        authorize(invocation); return nativeWorkSubmissionLookupResultSchema.parse(result);
      } catch (error) {
        if (error instanceof GatewayVerbError) throw error;
        if (error instanceof NativeWorkSubmissionError) {
          const status = ['unsupported-authority', 'forbidden'].includes(error.code) ? 403 : error.code === 'invalid' ? 400
            : ['stale', 'conflict', 'request-conflict'].includes(error.code) ? 409 : 503;
          throw new GatewayVerbError(error.code === 'indeterminate'
            ? 'Native submission outcome is unknown. Look up the original request before retrying.'
            : `Native work submission ${error.code}`, `NATIVE_SUBMISSION_${error.code.replaceAll('-', '_').toUpperCase()}`, status);
        }
        throw new GatewayVerbError('Native work submission is unavailable; retain the original request identity', 'NATIVE_SUBMISSION_UNAVAILABLE', 503);
      }
    }, { replace: true });
  }
}
