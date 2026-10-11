import type { ArtifactStore } from '../artifacts/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { KnowledgeConnectorRegistry } from './connectors.js';
import type { KnowledgeConnector, KnowledgeIssueRecord } from './types.js';
import type { KnowledgeStore } from './store.js';

export interface KnowledgeIngestContext {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly connectorRegistry: KnowledgeConnectorRegistry;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
  readonly syncReviewedMemory: () => Promise<void>;
  readonly semanticEnrichSource?: ((sourceId: string, knowledgeSpaceId?: string) => void | Promise<void>) | undefined;
  readonly lint: () => Promise<readonly KnowledgeIssueRecord[]>;
  readonly listConnectors: () => readonly KnowledgeConnector[];
}

/** Host-only ownership for an explicit ingest, separate from untrusted input metadata. */
export interface KnowledgeIngestOwnership {
  /** The host repair caller will perform guarded enrichment/promotion itself. */
  readonly deferSemanticEnrichment?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Called after the guarded atomic commit; later cancellation cannot undo that commit. */
  readonly onCommitted?: ((sourceId: string) => void) | undefined;
}
