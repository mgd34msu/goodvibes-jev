/**
 * contract-work.ts, the external work seam of the contract runner
 * (docs/design/contract-runner.md 8.4).
 *
 * Surfaces and partner apps that do not embed the runner dispatch, poll,
 * cancel and fetch contract work through an adapter with these four methods.
 * Two implementations exist: the in-process hosted adapter
 * (sdk platform/hosted-sessions/contract-work-adapter.ts) and the operator
 * adapter over the `contracts.*` methods (operator-sdk
 * contract-work-adapter.ts). The types and the mapping from a contract to a
 * snapshot or result live here, in the wire contracts package both reach, so
 * the two adapters report a contract the same way.
 *
 * The mapping is code: a fixed table from the runner's statuses to the seam's
 * six, and fields copied from the contract as the runner recorded them.
 */
import type { OperatorMethodOutput } from './generated/foundation-client-types.js';

/** A contract as `contracts.get` returns it. */
export type ContractWorkView = OperatorMethodOutput<'contracts.get'>;
/** The runner's status of a contract. */
export type ContractRunStatus = ContractWorkView['status'];

export type ContractExternalWorkStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface ContractExternalWorkRequest {
  /** The work, in the requester's words: the new contract's ask. */
  readonly task: string;
  /** The contract on the requesting side this work is for, when there is one. */
  readonly contractId?: string | undefined;
  /** That contract's status when it asked. */
  readonly status?: ContractRunStatus | undefined;
  /** Adapter-specific options (the hosted adapter reads `sessionId` and `workspaceRoot`). */
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ContractExternalWorkHandle {
  readonly externalTaskId: string;
  readonly status: ContractExternalWorkStatus;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ContractExternalWorkSnapshot extends ContractExternalWorkHandle {
  readonly progress?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface ContractExternalWorkResult {
  readonly externalTaskId: string;
  readonly status: Extract<ContractExternalWorkStatus, 'completed' | 'failed' | 'cancelled'>;
  readonly summary: string;
  readonly output?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface ContractExternalWorkAdapter {
  dispatch(request: ContractExternalWorkRequest): Promise<ContractExternalWorkHandle>;
  status(externalTaskId: string): Promise<ContractExternalWorkSnapshot>;
  cancel(externalTaskId: string, reason?: string | undefined): Promise<void>;
  result(externalTaskId: string): Promise<ContractExternalWorkResult>;
}

/** Hands each call to the adapter it was built over. */
export class ContractExternalWorkBridge {
  constructor(private readonly adapter: ContractExternalWorkAdapter) {}

  dispatch(request: ContractExternalWorkRequest): Promise<ContractExternalWorkHandle> {
    return this.adapter.dispatch(request);
  }

  status(externalTaskId: string): Promise<ContractExternalWorkSnapshot> {
    return this.adapter.status(externalTaskId);
  }

  cancel(externalTaskId: string, reason?: string | undefined): Promise<void> {
    return this.adapter.cancel(externalTaskId, reason);
  }

  result(externalTaskId: string): Promise<ContractExternalWorkResult> {
    return this.adapter.result(externalTaskId);
  }
}

/** Every runner status and the seam status it reports as. */
export const CONTRACT_WORK_STATUS: Readonly<Record<ContractRunStatus, ContractExternalWorkStatus>> = {
  queued: 'queued',
  shaping: 'running',
  planning: 'running',
  'checking-plan': 'running',
  running: 'running',
  judging: 'running',
  fixing: 'running',
  committing: 'running',
  'awaiting-owner': 'blocked',
  passed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** The fields of a contract the seam reports; both a `contracts.get` output and the runner's own view have them. */
export interface ContractWorkFields {
  readonly id: string;
  readonly status: ContractRunStatus;
  readonly sessionId: string;
  readonly ownerAgentId: string;
  readonly createdAt: number;
  readonly completedAt?: number | undefined;
  readonly answer?: string | undefined;
  readonly statusLine?: string | undefined;
  readonly error?: string | undefined;
  readonly escalations: readonly {
    readonly id: string;
    readonly at: number;
    readonly question: string;
    readonly resolvedAt?: number | undefined;
  }[];
  readonly decisions: readonly { readonly at: number }[];
}

/** The newest escalation still waiting on the owner. */
function openEscalationOf(contract: ContractWorkFields): ContractWorkFields['escalations'][number] | undefined {
  return contract.escalations.filter((escalation) => escalation.resolvedAt === undefined).sort((a, b) => b.at - a.at)[0];
}

function workMetadata(contract: ContractWorkFields): Record<string, unknown> {
  const open = openEscalationOf(contract);
  return {
    contractId: contract.id,
    sessionId: contract.sessionId,
    ownerAgentId: contract.ownerAgentId,
    ...(open === undefined ? {} : { escalationId: open.id }),
  };
}

export function contractWorkHandle(contract: ContractWorkFields, metadata: Record<string, unknown> = {}): ContractExternalWorkHandle {
  return { externalTaskId: contract.id, status: CONTRACT_WORK_STATUS[contract.status], metadata: { ...workMetadata(contract), ...metadata } };
}

/**
 * The status line once the contract has one (it ends with one); while it
 * waits on its owner, the question it asks; otherwise its status.
 */
export function contractWorkProgress(contract: ContractWorkFields): string {
  if (contract.statusLine !== undefined) return contract.statusLine;
  const open = openEscalationOf(contract);
  if (contract.status === 'awaiting-owner' && open !== undefined) return `Contract ${contract.id} waits on its owner: ${open.question}`;
  return `Contract ${contract.id}: ${contract.status}`;
}

export function contractWorkSnapshot(contract: ContractWorkFields): ContractExternalWorkSnapshot {
  const last = Math.max(contract.createdAt, contract.completedAt ?? 0, ...contract.decisions.map((decision) => decision.at));
  return { ...contractWorkHandle(contract), progress: contractWorkProgress(contract), updatedAt: new Date(last).toISOString() };
}

/** The result of an ended contract: its answer as output, its status line as summary. Throws while it runs. */
export function contractWorkResult(contract: ContractWorkFields): ContractExternalWorkResult {
  const status = CONTRACT_WORK_STATUS[contract.status];
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
    throw new Error(`Contract ${contract.id} has not ended (${contract.status}); its result is not ready.`);
  }
  return {
    externalTaskId: contract.id,
    status,
    summary: contract.statusLine ?? `Contract ${contract.id} ${contract.status}${contract.error === undefined ? '' : `: ${contract.error}`}`,
    ...(contract.answer === undefined ? {} : { output: contract.answer }),
    metadata: workMetadata(contract),
  };
}
