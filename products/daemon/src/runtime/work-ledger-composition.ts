import { randomUUID } from 'node:crypto';
import type { KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import {
  createWorkLedger,
  type KnowledgeWorkLedgerStorage,
  type WorkLedgerAuthority,
  type WorkLedgerClock,
  type WorkLedgerService,
  type WorkLedgerState,
  type WorkLedgerStorage,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';

/** Trusted native composition only. Never copy authority onto RuntimeServices. */
export interface NativeWorkLedgerOwner {
  readonly service: WorkLedgerService;
  readonly authority: WorkLedgerAuthority;
  close(): Promise<void>;
}

/**
 * One authority over the regular KnowledgeStore's project-scoped ledger.
 * Construction is synchronous; the existing store acquires persistence lazily.
 * In particular, an unused ledger never opens another database or starts work.
 */
export function createNativeWorkLedgerOwner(options: {
  readonly projectId: string;
  readonly knowledgeStore: Pick<KnowledgeStore, 'openWorkLedgerStorage'>;
  readonly clock?: WorkLedgerClock;
}): NativeWorkLedgerOwner {
  let storage: KnowledgeWorkLedgerStorage | undefined;
  let ready: Promise<KnowledgeWorkLedgerStorage> | undefined;
  let stopObservation: (() => void) | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const listeners = new Set<(state: WorkLedgerState) => void>();

  function acquire(): Promise<KnowledgeWorkLedgerStorage> {
    // Already-admitted core operations may reach this forwarding seam after
    // close was invoked. They still acquire/drain; only the core admits work.
    return ready ??= Promise.resolve().then(() => options.knowledgeStore.openWorkLedgerStorage(options.projectId)).then((opened) => {
      storage = opened; // Own it before observer setup, which may throw.
      if (!closed) {
        stopObservation = opened.subscribe((state) => {
          for (const listener of [...listeners]) {
            try { listener(state); } catch { /* Observers cannot change a durable receipt. */ }
          }
        });
      }
      return opened;
    });
  }

  const forwarding: WorkLedgerStorage = {
    async read() { return (await acquire()).read(); },
    async transaction(decide) { return (await acquire()).transaction(decide); },
    subscribe(listener) {
      listeners.add(listener);
      // Subscription is synchronous, while persistence acquisition is not.
      // Snapshot/history surface initialization errors; close also retains them.
      // Consumers subscribe before reading, then catch up from the durable cursor.
      void acquire().catch(() => {});
      return () => { listeners.delete(listener); };
    },
  };
  const core = createWorkLedger({
    projectId: options.projectId,
    storage: forwarding,
    clock: options.clock ?? { now: Date.now, newId: (kind) => `${kind}:${randomUUID()}` },
  });

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    // This is deliberately outside any await: product admission and observers
    // are fenced at invocation, even while older graph owners are draining.
    const drained = core.service.close();
    closing = (async () => {
      await drained;
      const failures: unknown[] = [];
      try { await ready; } catch (error) { failures.push(error); }
      try { stopObservation?.(); } catch (error) { failures.push(error); }
      stopObservation = undefined;
      listeners.clear();
      try { await storage?.close(); } catch (error) { failures.push(error); }
      if (failures.length > 0) throw new AggregateError(failures, 'Native work ledger cleanup failed');
    })();
    return closing;
  }

  return { service: { ...core.service, close }, authority: core.authority, close };
}
