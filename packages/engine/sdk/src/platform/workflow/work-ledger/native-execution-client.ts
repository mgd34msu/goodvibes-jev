import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';
import {
  NATIVE_WORK_EXECUTION_MAX_REQUEST_BYTES,
  NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES,
  nativeWorkExecutionIdentitySchema,
  nativeWorkExecutionRequestSchema,
  nativeWorkExecutionSnapshotSchema,
  nativeWorkLedgerProjectSchema,
  type NativeWorkExecutionIdentity,
  type NativeWorkExecutionRevision,
  type NativeWorkExecutionSnapshot,
} from './native-execution-wire.js';

export {
  NATIVE_WORK_EXECUTION_MAX_REQUEST_BYTES,
  NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES,
  nativeWorkExecutionRevisionSchema,
  nativeWorkExecutionExecutionSnapshotSchema,
  nativeWorkExecutionPendingIntentSnapshotSchema,
  nativeWorkExecutionPreventedSnapshotSchema,
  type NativeWorkExecutionExecutionSnapshot,
  type NativeWorkExecutionPendingIntentSnapshot,
  type NativeWorkExecutionPreventedSnapshot,
  nativeWorkExecutionIdentitySchema,
  nativeWorkExecutionRequestSchema,
  nativeWorkExecutionSnapshotSchema,
  nativeWorkLedgerProjectSchema,
  type NativeWorkExecutionRevision,
  type NativeWorkExecutionIdentity,
  type NativeWorkExecutionRequest,
  type NativeWorkExecutionSnapshot,
} from './native-execution-wire.js';

export interface OperatorNativeWorkExecutionOptions {
  /** Cancels only this local request. It does not establish the server outcome. */
  readonly signal?: AbortSignal;
}

export interface OperatorNativeWorkExecutionClient {
  start(input: NativeWorkExecutionIdentity, options?: OperatorNativeWorkExecutionOptions): Promise<NativeWorkExecutionSnapshot>;
  status(input: NativeWorkExecutionIdentity, options?: OperatorNativeWorkExecutionOptions): Promise<NativeWorkExecutionSnapshot>;
  cancel(input: NativeWorkExecutionIdentity, options?: OperatorNativeWorkExecutionOptions): Promise<NativeWorkExecutionSnapshot>;
  /** Explicit recovery: passed executions only verify/publish or reconcile their original receipt, never restart effects. */
  resume(input: NativeWorkExecutionIdentity, options?: OperatorNativeWorkExecutionOptions): Promise<NativeWorkExecutionSnapshot>;
  /** Detaches local requests; never cancels server execution or disposes the shared operator client. */
  dispose(): void;
}

/** Local validation/lifecycle failure. Operator transport errors are propagated unchanged. */
export class NativeWorkExecutionClientError extends Error {
  constructor(readonly code: 'invalid_request' | 'invalid_response' | 'aborted' | 'disposed') {
    super(code === 'aborted' || code === 'disposed'
      ? `Native work execution: local request ${code}; server outcome is unknown`
      : `Native work execution: ${code}`);
    this.name = 'NativeWorkExecutionClientError';
  }
}

function bounded(value: unknown, limit: number): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= limit;
  } catch { return false; }
}

function sameRevision(a: NativeWorkExecutionRevision, b: NativeWorkExecutionRevision): boolean {
  return a.work === b.work && a.criteria === b.criteria && a.attempt === b.attempt;
}

/** Read the selected host project identity without loading legacy planning state. */
export async function getOperatorWorkLedgerProject(
  client: Pick<OperatorRemoteClient, 'invoke'>,
  options: OperatorNativeWorkExecutionOptions = {},
): Promise<string> {
  const signal = options.signal;
  if (signal?.aborted) throw new NativeWorkExecutionClientError('aborted');
  const controller = new AbortController();
  let cancel = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new NativeWorkExecutionClientError('aborted'));
    controller.signal.addEventListener('abort', cancel, { once: true });
  });
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new NativeWorkExecutionClientError('aborted');
        return client.invoke<unknown>('workLedger.project', {}, { signal: controller.signal });
      }),
      cancelled,
    ]);
    if (controller.signal.aborted) throw new NativeWorkExecutionClientError('aborted');
    let projectId: string;
    try {
      if (!bounded(value, NATIVE_WORK_EXECUTION_MAX_REQUEST_BYTES)) throw new Error();
      projectId = nativeWorkLedgerProjectSchema.parse(value).projectId;
    } catch { throw new NativeWorkExecutionClientError('invalid_response'); }
    if (controller.signal.aborted) throw new NativeWorkExecutionClientError('aborted');
    return projectId;
  } finally {
    controller.signal.removeEventListener('abort', cancel);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Uses only the selected operator client's authenticated invoke transport. No
 * credentials, host runtime, retries, polling, or implicit recovery are acquired.
 * After an interrupted mutation, explicitly query status for that same attempt.
 */
export function createOperatorNativeWorkExecutionClient(
  client: Pick<OperatorRemoteClient, 'invoke'>,
  projectId: string,
): OperatorNativeWorkExecutionClient {
  if (!nativeWorkExecutionRequestSchema.shape.projectId.safeParse(projectId).success) {
    throw new NativeWorkExecutionClientError('invalid_request');
  }
  let disposed = false;
  const requests = new Set<AbortController>();
  function active(signal?: AbortSignal): void {
    if (disposed) throw new NativeWorkExecutionClientError('disposed');
    if (signal?.aborted) throw new NativeWorkExecutionClientError('aborted');
  }

  async function invoke(
    operation: 'start' | 'status' | 'cancel' | 'resume',
    input: NativeWorkExecutionIdentity,
    options: OperatorNativeWorkExecutionOptions = {},
  ): Promise<NativeWorkExecutionSnapshot> {
    active(options.signal);
    let identity: NativeWorkExecutionIdentity;
    try {
      // Parse before adding projectId so supplied project/authority fields cannot
      // be silently overwritten. Zod detaches the expected revision from callers.
      identity = nativeWorkExecutionIdentitySchema.parse(input);
    } catch { throw new NativeWorkExecutionClientError('invalid_request'); }
    const request = nativeWorkExecutionRequestSchema.parse({ projectId, ...identity });
    if (!bounded(request, NATIVE_WORK_EXECUTION_MAX_REQUEST_BYTES)) throw new NativeWorkExecutionClientError('invalid_request');
    active(options.signal);

    const controller = new AbortController();
    requests.add(controller);
    let cancel = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new NativeWorkExecutionClientError(disposed ? 'disposed' : 'aborted'));
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    const signal = options.signal;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      // Install cancellation before entering the shared transport, including a
      // synchronously throwing or reentrant invoke implementation. The race owns
      // late transport rejection and fences transports which ignore AbortSignal.
      const value = await Promise.race([
        Promise.resolve().then(() => {
          active(controller.signal);
          return client.invoke<unknown>(`workLedger.execution.${operation}`, request, { signal: controller.signal });
        }),
        cancelled,
      ]);
      active(controller.signal);
      let snapshot: NativeWorkExecutionSnapshot;
      try {
        if (!bounded(value, NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES)) throw new Error();
        snapshot = nativeWorkExecutionSnapshotSchema.parse(value);
        // Bound the parsed projection too; custom toJSON must not bypass limits.
        if (!bounded(snapshot, NATIVE_WORK_EXECUTION_MAX_RESPONSE_BYTES)) throw new Error();
      } catch { throw new NativeWorkExecutionClientError('invalid_response'); }
      if (snapshot.projectId !== projectId || snapshot.workId !== identity.workId || snapshot.attemptId !== identity.attemptId
        || ((operation === 'start' || operation === 'resume') && !sameRevision(snapshot.expectedRevision, identity.expectedRevision))) {
        throw new NativeWorkExecutionClientError('invalid_response');
      }
      if (snapshot.kind === 'execution' && snapshot.integration && snapshot.integration.state !== 'unavailable') {
        const integration = snapshot.integration;
        if (integration.contractId !== snapshot.receipt?.contractId || snapshot.state !== 'launch-claimed' || snapshot.recovery !== 'available'
          || !snapshot.currentAttempt || snapshot.stale || !snapshot.currentRevision || !sameRevision(snapshot.expectedRevision, snapshot.currentRevision)
          || !snapshot.progress || ['passed', 'failed', 'cancelled'].includes(snapshot.progress.status)
          || (integration.state === 'live' && snapshot.progress.sessionMode)) throw new NativeWorkExecutionClientError('invalid_response');
        if (integration.state === 'not-applicable' && ((integration.reason === 'session-mode') !== snapshot.progress.sessionMode)) {
          throw new NativeWorkExecutionClientError('invalid_response');
        }
        if (integration.state === 'live') {
          const units = new Map(integration.units.map(unit => [unit.unitId, unit]));
          const itemIds = integration.units.flatMap(unit => unit.item.state === 'recorded' ? [JSON.stringify([unit.item.workstreamId, unit.item.itemId])] : []);
          if (units.size !== integration.units.length || new Set(itemIds).size !== itemIds.length || integration.units.some(unit =>
            (unit.item.state === 'recorded' && (unit.item.workstreamId !== unit.groupId || (unit.item.mergeHash !== undefined && unit.item.integration !== 'merged')))
            || (unit.attemptOf === undefined && unit.attemptIndex !== undefined)
            || (unit.attemptOf !== undefined && (units.get(unit.attemptOf)?.groupId !== unit.groupId || units.get(unit.attemptOf)?.attemptOf !== undefined)))) {
            throw new NativeWorkExecutionClientError('invalid_response');
          }
          for (const parent of units.values()) {
            const attempts = integration.units.filter(unit => unit.attemptOf === parent.unitId);
            const indexes = attempts.map(unit => unit.attemptIndex);
            if (new Set(indexes).size !== indexes.length || indexes.some(index => index === undefined || index >= attempts.length)) {
              throw new NativeWorkExecutionClientError('invalid_response');
            }
          }
        }
      }
      // status/cancel intentionally return the server's admitted revisions even
      // when the current caller has a different revision for this same attempt.
      active(controller.signal);
      return snapshot;
    } finally {
      controller.signal.removeEventListener('abort', cancel);
      signal?.removeEventListener('abort', onAbort);
      requests.delete(controller);
    }
  }

  return Object.freeze({
    start: (input: NativeWorkExecutionIdentity, options?: OperatorNativeWorkExecutionOptions) => invoke('start', input, options),
    status: (input: NativeWorkExecutionIdentity, options?: OperatorNativeWorkExecutionOptions) => invoke('status', input, options),
    cancel: (input: NativeWorkExecutionIdentity, options?: OperatorNativeWorkExecutionOptions) => invoke('cancel', input, options),
    resume: (input: NativeWorkExecutionIdentity, options?: OperatorNativeWorkExecutionOptions) => invoke('resume', input, options),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const request of requests) request.abort();
    },
  });
}
