/**
 * TUI trust/wording adapter for the engine-owned consolidation receipt seam.
 * builtin-modals resolves this lazily for every refresh, using the same daemon
 * connection as commands. The engine owns the verb and unavailable classifier.
 */
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  createMemoryConsolidationGateway as createEngineMemoryConsolidationGateway,
  classifyConsolidationFetchError as classifyEngineConsolidationFetchError,
  type MemoryConsolidationFetchFailure,
  type MemoryConsolidationGatewayResolution,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { resolveOperatorRpc, describeOperatorRpcError } from '../input/commands/operator-rpc.ts';

export type {
  MemoryConsolidationReceiptsResult,
  MemoryConsolidationProposal,
  MemoryConsolidationGateway,
  MemoryConsolidationGatewayResolution,
  MemoryConsolidationFetchFailure,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';

export interface MemoryConsolidationGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string;
}

export function createMemoryConsolidationGateway(deps: MemoryConsolidationGatewayDeps): MemoryConsolidationGatewayResolution {
  return createEngineMemoryConsolidationGateway(resolveOperatorRpc(deps));
}

export function classifyConsolidationFetchError(error: unknown): MemoryConsolidationFetchFailure {
  return classifyEngineConsolidationFetchError(error, describeOperatorRpcError);
}
