/**
 * contract-work-adapter.ts, the external work adapter for partner surfaces
 * over the daemon's `contracts.*` operator methods
 * (docs/design/contract-runner.md 8.4 and 10.2).
 *
 * `dispatch` calls `contracts.start` with the task as the ask (and the
 * request's `metadata.sessionId`, `metadata.workspaceRoot` and
 * `metadata.isolation` when given: a hosted session's id starts the contract
 * in that session), `status` reads `contracts.get` into a snapshot, `cancel`
 * calls `contracts.cancel`, and `result` reads `contracts.get` into the
 * contract's answer and status line. The external task id is the contract
 * id. The mapping is the contracts package's, shared with the in-process
 * hosted adapter, so both report a contract the same way.
 */
import {
  contractWorkHandle,
  contractWorkResult,
  contractWorkSnapshot,
  type ContractExternalWorkAdapter,
} from '@goodvibes-jev/engine/contracts';
import type { OperatorRemoteClient } from './client-core.js';

/** The reason a cancel through the adapter records when the caller gives none. */
export const OPERATOR_WORK_CANCEL_REASON = 'cancelled by the requester';

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function metadataIsolation(metadata: Record<string, unknown> | undefined): 'auto' | 'worktree' | 'shared' | undefined {
  const value = metadata?.['isolation'];
  return value === 'auto' || value === 'worktree' || value === 'shared' ? value : undefined;
}

/** An adapter over an operator client; the client's own auth and transport carry every call. */
export function createOperatorContractWorkAdapter(client: Pick<OperatorRemoteClient, 'invoke'>): ContractExternalWorkAdapter {
  return {
    async dispatch(request) {
      const sessionId = metadataString(request.metadata, 'sessionId');
      const workspaceRoot = metadataString(request.metadata, 'workspaceRoot');
      const isolation = metadataIsolation(request.metadata);
      const started = await client.invoke('contracts.start', {
        ask: request.task,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(isolation === undefined ? {} : { isolation }),
      });
      return contractWorkHandle(started.contract, {
        ...(request.contractId === undefined ? {} : { requestingContractId: request.contractId }),
        ...(request.status === undefined ? {} : { requestingStatus: request.status }),
      });
    },
    async status(externalTaskId) {
      return contractWorkSnapshot(await client.invoke('contracts.get', { contractId: externalTaskId }));
    },
    async cancel(externalTaskId, reason) {
      await client.invoke('contracts.cancel', { contractId: externalTaskId, reason: reason ?? OPERATOR_WORK_CANCEL_REASON });
    },
    async result(externalTaskId) {
      return contractWorkResult(await client.invoke('contracts.get', { contractId: externalTaskId }));
    },
  };
}
