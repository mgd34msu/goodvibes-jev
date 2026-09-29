/**
 * The external work seam (docs/design/contract-runner.md 8.4): surfaces and
 * partner apps that do not embed the contract runner dispatch, poll, cancel
 * and fetch contract work through an adapter with these four methods. The
 * in-process hosted adapter and the operator adapter implement it.
 */
import type { ContractStatus } from './types.js';

export type ContractExternalWorkStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export interface ContractExternalWorkRequest {
  readonly task: string;
  readonly contractId?: string | undefined;
  readonly status?: ContractStatus | undefined;
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
