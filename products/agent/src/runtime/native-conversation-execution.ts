import { nativeWorkExecutionSnapshotSchema, type NativeWorkExecutionIdentity, type NativeWorkExecutionSnapshot, type OperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import type { NativeConversationIntakeWorkReceipt } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import type { NativeIntakeExecutionIntent } from './native-conversation-intake-journal.ts';
import type { NativeWorkExecutionState } from './native-work-execution.ts';

export const nativeConversationExecutionIntent = (receipt: NativeConversationIntakeWorkReceipt): NativeIntakeExecutionIntent => ({
  sourceRevision: receipt.source.sourceRevision,
  target: { workId: receipt.workId, attemptId: receipt.attemptId, expectedRevision: { ...receipt.expectedRevision } },
});
export const sameNativeExecutionIntent = (left: NativeIntakeExecutionIntent, right: NativeIntakeExecutionIntent): boolean => JSON.stringify(left) === JSON.stringify(right);
const notFound = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'NATIVE_EXECUTION_NOT_FOUND';

const sameRevisions = (left: NativeWorkExecutionIdentity['expectedRevision'], right: NativeWorkExecutionIdentity['expectedRevision']): boolean => left.work === right.work && left.criteria === right.criteria && left.attempt === right.attempt;
const describeRevisions = (value: NativeWorkExecutionIdentity['expectedRevision']): string => `work r${value.work}, criteria r${value.criteria}, attempt r${value.attempt}`;

function validate(snapshot: NativeWorkExecutionSnapshot, projectId: string, target: NativeWorkExecutionIdentity, action: 'status' | 'start'): NativeWorkExecutionSnapshot {
  const result = nativeWorkExecutionSnapshotSchema.parse(snapshot);
  if (result.projectId !== projectId || result.workId !== target.workId || result.attemptId !== target.attemptId
    || (action === 'start' && !sameRevisions(result.expectedRevision, target.expectedRevision))) throw new Error('Native execution target changed');
  return result;
}
function observed(snapshot: NativeWorkExecutionSnapshot, action: 'status' | 'start', target: NativeWorkExecutionIdentity): NativeWorkExecutionState {
  return { workId: snapshot.workId, action, busy: false, snapshot,
    message: !sameRevisions(snapshot.expectedRevision, target.expectedRevision)
      ? `Recorded native revisions differ: saved ${describeRevisions(target.expectedRevision)}; recorded ${describeRevisions(snapshot.expectedRevision)}. The saved dispatch target is unchanged; this status check does not start or resume execution.`
      : snapshot.recovery === 'required' ? 'Native execution requires explicit recovery. Inspect /work and use its Resume control only if appropriate.'
      : snapshot.kind === 'pending-intent' ? 'Native execution admission is recorded and pending. Status checks will not resume it.'
      : 'Native execution is recorded on the original work and attempt. Completion still requires native verification.' };
}

/** Read-only reconciliation cannot create, resume or rewrite an execution. */
export async function inspectNativeConversationExecution(client: OperatorNativeWorkExecutionClient, projectId: string, intent: NativeIntakeExecutionIntent, signal: AbortSignal): Promise<NativeWorkExecutionState> {
  try { return observed(validate(await client.status(intent.target, { signal }), projectId, intent.target, 'status'), 'status', intent.target); }
  catch (error) { return { workId: intent.target.workId, action: 'status', busy: false,
    message: notFound(error) ? 'Native work is admitted, but execution has not been found. Use /work intake-retry to reconcile the same original target.'
      : 'Native execution status is unknown or unavailable. Its original dispatch intent is retained; no new execution was requested.' };
  }
}

/** Call only after the exact intent is durably confirmed. Never resume here. */
export async function dispatchNativeConversationExecution(client: OperatorNativeWorkExecutionClient, projectId: string, intent: NativeIntakeExecutionIntent, signal: AbortSignal): Promise<NativeWorkExecutionState> {
  try { return observed(validate(await client.status(intent.target, { signal }), projectId, intent.target, 'status'), 'status', intent.target); }
  catch (error) {
    if (!notFound(error) || signal.aborted) return { workId: intent.target.workId, action: 'status', busy: false, message: 'Native execution could not be reconciled. The durable target is retained; no start or resume was requested.' };
  }
  try { return observed(validate(await client.start(intent.target, { signal }), projectId, intent.target, 'start'), 'start', intent.target); }
  catch {
    if (signal.aborted) return { workId: intent.target.workId, action: 'start', busy: false, message: 'Native execution start detached. The original dispatch intent is retained; inspect its status before explicit recovery.' };
    // A lost acknowledgement may already have committed the same host intent.
    // Reconcile once by reading; never send an automatic second start.
    const status = await inspectNativeConversationExecution(client, projectId, intent, signal);
    return { ...status, message: status.snapshot ? status.message : 'Native execution start outcome is unknown. The original work, attempt and revisions are retained. Inspect status before explicit recovery.' };
  }
}
