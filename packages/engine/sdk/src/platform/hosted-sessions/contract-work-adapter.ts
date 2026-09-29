/**
 * contract-work-adapter.ts, the in-process external work adapter over hosted
 * sessions (docs/design/contract-runner.md 8.4).
 *
 * `dispatch` starts a contract in a hosted session: the one the request's
 * `metadata.sessionId` names, or a new one created for the dispatch in
 * `metadata.workspaceRoot` (else the adapter's default workspace). The
 * contract runs on that session's workspace floor, so its questions for the
 * owner are the session's replies and a turn in the session answers them.
 * `status` maps the contract to a snapshot (its status line, or its question
 * while it waits on the owner, as progress), `cancel` cancels it, and
 * `result` returns its answer as output and its status line as summary.
 *
 * The external task id is the contract id.
 */
import {
  contractWorkHandle,
  contractWorkResult,
  contractWorkSnapshot,
  type ContractExternalWorkAdapter,
} from '../contract/external.js';
import type { ContractOperatorService } from '../contract/operator-service.js';
import type { HostedSessionManager } from './manager.js';

export interface HostedContractWorkAdapterDeps {
  /** The contracts operator surface: it starts a hosted session's contract on the session's floor. */
  readonly runner: Pick<ContractOperatorService, 'start' | 'get' | 'cancel'>;
  readonly hostedSessions: Pick<HostedSessionManager, 'create' | 'hosts'>;
  /** Where a session created for a dispatch works when the request names no workspace. Absolute. */
  readonly workspaceRoot?: string | undefined;
}

/** The reason a cancel through the adapter records when the caller gives none. */
export const EXTERNAL_CANCEL_REASON = 'cancelled by the requester';

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function createHostedContractWorkAdapter(deps: HostedContractWorkAdapterDeps): ContractExternalWorkAdapter {
  const contractOf = (externalTaskId: string) => {
    const contract = deps.runner.get(externalTaskId);
    if (contract === null) throw new Error(`No contract ${externalTaskId} on this daemon.`);
    return contract;
  };

  return {
    async dispatch(request) {
      let sessionId = metadataString(request.metadata, 'sessionId');
      if (sessionId !== undefined && !deps.hostedSessions.hosts(sessionId)) {
        throw new Error(`This daemon hosts no live session ${sessionId}.`);
      }
      if (sessionId === undefined) {
        const workspaceRoot = metadataString(request.metadata, 'workspaceRoot') ?? deps.workspaceRoot;
        if (workspaceRoot === undefined) throw new Error('A dispatch without a hosted session needs metadata.workspaceRoot: no default workspace is set.');
        sessionId = (await deps.hostedSessions.create({ workspaceRoot })).id;
      }
      const started = await deps.runner.start({ ask: request.task, sessionId });
      return contractWorkHandle(started.contract, {
        ...(request.contractId === undefined ? {} : { requestingContractId: request.contractId }),
        ...(request.status === undefined ? {} : { requestingStatus: request.status }),
      });
    },
    async status(externalTaskId) {
      return contractWorkSnapshot(contractOf(externalTaskId));
    },
    async cancel(externalTaskId, reason) {
      contractOf(externalTaskId);
      deps.runner.cancel(externalTaskId, reason ?? EXTERNAL_CANCEL_REASON);
    },
    async result(externalTaskId) {
      return contractWorkResult(contractOf(externalTaskId));
    },
  };
}
