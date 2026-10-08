/**
 * Client read seam for the daemon's retained consolidation receipts. Connection
 * resolution and error wording belong to the consuming surface; the receipt
 * verb and the distinction between an absent verb and a failed read do not.
 */
import type { GoodVibesSdk } from '../../client.js';
import type { OperatorMethodOutput } from '../../contracts.js';
import { GoodVibesSdkError } from '../../errors.js';

export type MemoryConsolidationReceiptsResult = OperatorMethodOutput<'memory.consolidation.receipts'>;
export type MemoryConsolidationProposal = MemoryConsolidationReceiptsResult['pendingProposals'][number];

export interface MemoryConsolidationGateway {
  fetchReceipts(): Promise<MemoryConsolidationReceiptsResult>;
}

export type MemoryConsolidationGatewayResolution =
  | { readonly available: true; readonly gateway: MemoryConsolidationGateway }
  | { readonly available: false; readonly reason: string };

/** The product supplies its resolved, trusted operator connection. */
export type MemoryConsolidationConnection =
  | { readonly available: true; readonly sdk: Pick<GoodVibesSdk, 'operator'> }
  | { readonly available: false; readonly reason: string };

/** Resolve per refresh so a newly available daemon can serve the next read. */
export function createMemoryConsolidationGateway(connection: MemoryConsolidationConnection): MemoryConsolidationGatewayResolution {
  if (!connection.available) return { available: false, reason: connection.reason };
  return {
    available: true,
    gateway: { fetchReceipts: () => connection.sdk.operator.invoke('memory.consolidation.receipts', {}) },
  };
}

export type MemoryConsolidationFetchFailure =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

/** Only SDK 404/501 responses mean this daemon does not serve the receipt verb. */
export function classifyConsolidationFetchError(
  error: unknown,
  describeError: (error: unknown) => string,
): MemoryConsolidationFetchFailure {
  const description = describeError(error);
  if (error instanceof GoodVibesSdkError && (error.status === 501 || error.status === 404)) {
    return { kind: 'unavailable', reason: description };
  }
  return { kind: 'error', message: description };
}
