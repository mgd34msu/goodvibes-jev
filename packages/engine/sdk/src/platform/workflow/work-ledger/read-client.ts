import {
  WorkLedgerAccessError,
  type WorkLedgerAuthority,
  projectWorkLedgerReadEvent,
  type WorkLedgerReadEvent,
  type WorkLedgerService,
  type WorkLedgerSnapshot,
  type WorkLedgerView,
} from './types.js';

/** Read-only projection; edit affordances are intentionally absent. */
export interface WorkLedgerReadSnapshot extends Omit<WorkLedgerSnapshot, 'works'> {
  readonly provenance?: 'available' | 'requires_read_knowledge';
  readonly works: readonly Omit<WorkLedgerView, 'allowedActions'>[];
}

/** An injected project binding. Consumers cannot select actors, projects or stores. */
export interface WorkLedgerReadClient {
  readonly projectId: string;
  readSnapshot(): Promise<WorkLedgerReadSnapshot>;
  history(afterSequence: number): Promise<readonly WorkLedgerReadEvent[]>;
  /** Subscribe before reading; notifications may coalesce. Catch up through history. */
  subscribe(listener: (snapshot: WorkLedgerReadSnapshot) => void): () => void;
  /** Revoke only this consumer. The host still owns service/store shutdown. */
  dispose(): void;
}

export type WorkLedgerReadBinding =
  | { readonly available: true; readonly client: WorkLedgerReadClient }
  | { readonly available: false; readonly reason: string };

/** Trusted host input only. Never construct this from editable consumer data. */
export type LocalWorkLedgerReadBindingOptions =
  | { readonly available: false; readonly reason: string }
  | {
    readonly available: true;
    readonly projectId: string;
    readonly actorId: string;
    /** Explicit trusted-host grant to disclose complete imported KnowledgeSourceRecords. */
    readonly allowLegacyProvenance?: boolean;
    readonly service: Pick<WorkLedgerService, 'readSnapshot' | 'history' | 'subscribe'>;
    readonly authority: WorkLedgerAuthority;
  };

/**
 * Bind a local consumer to an EXISTING host owner. This never opens storage or
 * creates an authority, and is not a separate-process transport. An unavailable
 * host stays unavailable; there is no surface-local fallback.
 *
 * The dedicated worker actor remains private. There is no core reader role;
 * this capability deliberately exposes no execute method and removes action
 * affordances from snapshots. Host revocation may call client.dispose(); host
 * close retains the core's existing admitted-I/O drain semantics.
 */
export function createLocalWorkLedgerReadBinding(options: LocalWorkLedgerReadBindingOptions): WorkLedgerReadBinding {
  if (!options.available) return Object.freeze({ available: false, reason: options.reason });
  const { projectId, actorId, service, authority, allowLegacyProvenance = false } = options;
  const actor = authority.issueActor({ projectId, actorId, role: 'worker' });
  let disposed = false;
  function requireOpen(): void {
    if (disposed) throw new WorkLedgerAccessError('closed', 'Work ledger reader is disposed');
  }
  function readOnly(snapshot: WorkLedgerSnapshot): WorkLedgerReadSnapshot {
    if (snapshot.projectId !== projectId) throw new WorkLedgerAccessError('forbidden', 'Host ledger project binding mismatch');
    return { ...snapshot, provenance: allowLegacyProvenance ? 'available' : 'requires_read_knowledge', works: snapshot.works.map(({ allowedActions: _actions, ...view }) => view) };
  }
  const client: WorkLedgerReadClient = Object.freeze({
    projectId,
    async readSnapshot() {
      requireOpen();
      const snapshot = await service.readSnapshot(actor);
      requireOpen();
      return readOnly(snapshot);
    },
    async history(afterSequence: number) {
      requireOpen();
      const events = await service.history(afterSequence, actor);
      requireOpen();
      return events.map(event => projectWorkLedgerReadEvent(event, allowLegacyProvenance === true));
    },
    subscribe(listener: (snapshot: WorkLedgerReadSnapshot) => void) {
      requireOpen();
      return service.subscribe(actor, snapshot => {
        if (!disposed) return listener(readOnly(snapshot));
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      authority.revokeActor(actor);
    },
  });
  return Object.freeze({ available: true, client });
}
