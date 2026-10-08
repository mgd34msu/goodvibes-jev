/** Authenticated identity-only native work verbs. The host constructs every source and authority binding. */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import { NativeWorkExecutionError, type NativeWorkExecutionHost, type NativeWorkExecutionObservation, type NativeWorkExecutionTarget } from '../../workflow/work-ledger/native-execution.js';
import { nativeWorkExecutionRequestSchema, nativeWorkExecutionSnapshotSchema, NATIVE_WORK_EXECUTION_MAX_REQUEST_BYTES, NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES,
  type NativeWorkExecutionRequest, type NativeWorkExecutionRevision, type NativeWorkExecutionSnapshot } from '../../workflow/work-ledger/native-execution-wire.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

const SCOPES = ['read:work-ledger', 'write:fleet'] as const;
type NativeGatewayExecution = Pick<NativeWorkExecutionHost, 'start' | 'statusByAttempt' | 'cancel' | 'cancelTarget' | 'resume' | 'settle'>;

function authorize(invocation: GatewayMethodInvocation) {
  const context = invocation.context;
  if (!context.admin || !context.principalId || !SCOPES.every(scope => context.scopes?.includes('*') || context.scopes?.includes(scope))
    || invocation.isAuthorized?.(SCOPES) !== true) throw new GatewayVerbError('Native execution requires current owner access, read:work-ledger and write:fleet', 'FORBIDDEN', 403);
  const authority = invocation.nativeExecutionAuthority;
  const current = authority?.current();
  if (!authority || !current || context.principalKind !== 'token' || current.kind !== 'pairing-token' || current.principalId !== context.principalId
    || !SCOPES.every(scope => current.scopes.includes('*') || current.scopes.includes(scope))) {
    throw new GatewayVerbError('Native execution requires a persisted paired-token owner; shared tokens and user sessions are unsupported', 'NATIVE_EXECUTION_UNSUPPORTED_AUTHORITY', 403);
  }
  return authority;
}
function revision(target: NativeWorkExecutionTarget): NativeWorkExecutionRevision {
  return { work: target.workRevision, criteria: target.criteriaRevision, attempt: target.attemptRevision };
}
function sameRevision(a: NativeWorkExecutionRevision, b: NativeWorkExecutionRevision): boolean { return a.work === b.work && a.criteria === b.criteria && a.attempt === b.attempt; }
function project(status: NativeWorkExecutionObservation): NativeWorkExecutionSnapshot {
  const stored = status.kind === 'execution' ? status.execution : status.intent;
  const expectedRevision = revision(stored.target);
  const currentRevision = status.currentTarget ? revision(status.currentTarget) : null;
  const common = { projectId: stored.projectId, workId: stored.target.workId, attemptId: stored.target.attemptId,
    expectedRevision, currentRevision, currentAttempt: status.currentAttempt,
    stale: !currentRevision || !status.currentAttempt || !sameRevision(expectedRevision, currentRevision) };
  let value: NativeWorkExecutionSnapshot;
  if (status.kind === 'intent') {
    if (status.intent.state === 'cancelled') value = { kind: 'prevented-before-admission', ...common, state: 'cancelled', recovery: 'cancelled' };
    else {
      if (status.intent.state === 'associated' || status.recovery === 'cancelled') throw new NativeWorkExecutionError('recovery-required');
      value = { kind: 'pending-intent', ...common, state: status.intent.state, recovery: status.recovery };
    }
  } else {
    const { execution, contract } = status;
    value = { kind: 'execution', ...common, state: execution.state, recovery: status.recovery,
      ...(status.settlement ? { settlement: status.settlement } : {}),
      receipt: execution.receipt ? { contractId: execution.receipt.contractId, ownerAgentId: execution.receipt.ownerAgentId } : null,
      integration: status.integration,
      progress: contract ? {
        status: contract.status, sessionMode: contract.sessionMode === true,
        semanticState: contract.nativeProgress?.state ?? null, stage: contract.nativeProgress?.stage ?? null,
        retrying: (contract.nativeWaiting?.requests.length ?? 0) > 0,
        units: { total: contract.units.length, passed: contract.units.filter(unit => unit.status === 'passed').length, failed: contract.units.filter(unit => unit.status === 'failed').length },
        criteria: { total: contract.criteria.length, met: contract.criteria.filter(item => item.status === 'met').length,
          unmet: contract.criteria.filter(item => item.status === 'unmet').length, unshown: contract.criteria.filter(item => item.status === 'unshown').length },
      } : null,
    };
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES && value.kind === 'execution') {
    value = { ...value, integration: { state: 'unavailable', reason: 'limit' } };
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES) throw new NativeWorkExecutionError('unavailable');
  return nativeWorkExecutionSnapshotSchema.parse(value);
}
function parse(invocation: GatewayMethodInvocation, projectId: string): NativeWorkExecutionRequest {
  const input = readInvocationParams(invocation);
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > NATIVE_WORK_EXECUTION_MAX_REQUEST_BYTES) throw new GatewayVerbError('Native execution request exceeds the transport limit', 'NATIVE_EXECUTION_LIMIT', 413);
  const parsed = nativeWorkExecutionRequestSchema.safeParse(input);
  if (!parsed.success) throw new GatewayVerbError('Invalid native execution identity', 'INVALID_ARGUMENT', 400, String(parsed.error.issues[0]?.path[0] ?? 'workId'));
  if (parsed.data.projectId !== projectId) throw new GatewayVerbError('Selected host does not own this project', 'WORK_LEDGER_PROJECT_MISMATCH', 403, 'projectId');
  return parsed.data;
}

/** Lazy selected-host composition. Authorization and strict identity checks precede any graph acquisition. */
export function registerNativeWorkExecutionGatewayMethods(catalog: GatewayMethodCatalog, host: {
  readonly projectId: string;
  readonly acquire: () => Promise<NativeGatewayExecution>;
}): void {
  for (const operation of ['start', 'status', 'cancel', 'resume'] as const) {
    const method = `workLedger.execution.${operation}`;
    const descriptor = catalog.get(method);
    if (!descriptor) throw new Error(`Missing native execution descriptor: ${method}`);
    catalog.register(descriptor, async invocation => {
      try {
        let authority = authorize(invocation);
        const input = parse(invocation, host.projectId);
        invocation.signal?.throwIfAborted();
        const execution = await host.acquire();
        authority = authorize(invocation); invocation.signal?.throwIfAborted();
        const target = { workId: input.workId, attemptId: input.attemptId, workRevision: input.expectedRevision.work,
          criteriaRevision: input.expectedRevision.criteria, attemptRevision: input.expectedRevision.attempt };
        try {
          if (operation === 'start') await execution.start(target, authority, invocation.signal ? { signal: invocation.signal } : {});
          else if (operation === 'cancel') await execution.cancelTarget(target, authority, 'Authenticated owner cancelled native work');
          else if (operation === 'resume') {
            const existing = execution.statusByAttempt(input.workId, input.attemptId, authority);
            const stored = existing.kind === 'execution' ? existing.execution : existing.intent;
            if (!sameRevision(input.expectedRevision, revision(stored.target))) throw new NativeWorkExecutionError('stale');
            if (existing.kind === 'execution' && existing.execution.state === 'cancelled') throw new NativeWorkExecutionError('stale');
            const options = invocation.signal ? { signal: invocation.signal } : {};
            if (existing.kind === 'execution' && (existing.settlement?.state === 'published' || existing.contract?.status === 'passed')) {
              // Explicit recovery of a terminal result only verifies/publishes,
              // or reconciles its exact durable receipt after a lost response.
              // It never recreates execution ownership or resumes effects.
              await execution.settle(stored.request.key, authority, options);
            } else {
              if (existing.kind === 'execution' && existing.recovery === 'terminal') throw new NativeWorkExecutionError('recovery-required');
              await execution.resume(stored.request.key, authority, options);
            }
          }
        } catch (error) {
          // An intent-only outcome is an honest observation, never a fabricated
          // admission. Refusal/unavailability remain their distinct errors.
          if (!(error instanceof NativeWorkExecutionError) || !['pending-intent', 'prevented-before-admission'].includes(error.code)) throw error;
        }
        authorize(invocation);
        return project(execution.statusByAttempt(input.workId, input.attemptId, authority));
      } catch (error) {
        if (error instanceof GatewayVerbError) throw error;
        if (error instanceof NativeWorkExecutionError) {
          const code = error.code;
          const status = code === 'not-found' ? 404 : code === 'unsupported-authority' ? 403 : code === 'invalid' ? 400 : code === 'refused' ? 422
            : code === 'stale' || code === 'conflict' || code === 'recovery-required' ? 409 : 503;
          throw new GatewayVerbError(`Native work execution ${code}`, `NATIVE_EXECUTION_${code.toUpperCase().replaceAll('-', '_')}`, status);
        }
        // No source, tool output, credential, filesystem path or internal owner
        // record is copied into a wire error. A lost response is not a replay grant.
        throw new GatewayVerbError('Native work execution is unavailable', 'NATIVE_EXECUTION_UNAVAILABLE', 503);
      }
    }, { replace: true });
  }
}
