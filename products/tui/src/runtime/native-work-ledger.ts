import { NativeWorkExecutionControls, type NativeWorkExecutionAction, type NativeWorkExecutionState } from './native-work-execution.ts';
import { createOperatorNativeWorkExecutionClient, type OperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import type { WorkLedgerReadBinding, WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import type { WorkLedgerReadEvent } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import { createOperatorWorkLedgerReadClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/operator-read-client';
import type { OperatorRemoteClient } from '@goodvibes-jev/engine/operator-sdk';

export type NativeWorkLedgerBinding = WorkLedgerReadBinding & { readonly execution?: OperatorNativeWorkExecutionClient };

/** Identity must change on host, project, workspace or authentication replacement. */
export type NativeWorkLedgerSelection =
  | { readonly available: false; readonly identity: string; readonly reason: string }
  | { readonly available: true; readonly identity: string; readonly projectId: string;
      readonly bind: (onUnavailable: (error: Error) => void) => NativeWorkLedgerBinding };
export type NativeWorkLedgerSelectionReader = () => NativeWorkLedgerSelection;
export function operatorWorkLedgerSelection(identity: string, projectId: string,
  operator: Pick<OperatorRemoteClient, 'invoke'>): NativeWorkLedgerSelection {
  return { available: true, identity, projectId, bind: onUnavailable => ({ available: true,
    client: createOperatorWorkLedgerReadClient(operator, projectId, { onUnavailable }),
    execution: createOperatorNativeWorkExecutionClient(operator, projectId) }) };
}

/** Owns local authenticated clients only; authority and execution remain on the host. */
export class NativeWorkLedgerModel {
  snapshot: WorkLedgerReadSnapshot | null = null;
  history: readonly WorkLedgerReadEvent[] = [];
  reason = 'Native work ledger is closed.';
  identity = 'closed';
  executionAvailable = false;
  private readonly controls = new NativeWorkExecutionControls(() => this.changed());
  get execution() { return this.controls.state; }
  observedExecutionAttempt(workId: string): string | undefined { return this.controls.observedAttempt(workId); }
  execute(action: NativeWorkExecutionAction, workId: string): Promise<NativeWorkExecutionState | undefined> { this.synchronize(); return this.controls.run(action, workId); }
  private epoch = 0;
  private selected = '';
  private opened = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private release: (() => void) | undefined;
  private changed: () => void = () => {};
  constructor(private readonly select: NativeWorkLedgerSelectionReader) {}
  open(changed: () => void): void {
    const epoch = this.epoch + 1;
    this.close();
    if (this.epoch !== epoch) return; // cleanup reentered: the newer lifecycle wins
    this.changed = changed; this.opened = true; this.synchronize();
    if (!this.opened || this.timer) return;
    this.timer = setInterval(() => {
      const identity = this.identity; this.synchronize();
      if (identity !== this.identity) this.changed();
    }, 1000);
    this.timer.unref?.();
  }
  close(): void {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    this.opened = false; this.selected = ''; this.changed = () => {};
    this.clear('Native work ledger is closed.');
  }
  private clear(reason: string): number {
    const epoch = ++this.epoch;
    this.executionAvailable = false;
    this.identity = `native:${epoch}`;
    this.snapshot = null; this.history = []; this.reason = reason;
    const release = this.release; this.release = undefined;
    // Revoke before calling untrusted cleanup. Reentrant close cannot find it twice.
    this.controls.clear();
    try { release?.(); } catch { /* a cleanup failure cannot retain old host rows */ }
    return epoch;
  }
  synchronize(): void {
    if (!this.opened) return;
    let selection: NativeWorkLedgerSelection;
    try { selection = this.select(); }
    catch { selection = { available: false, identity: 'selection-error', reason: 'Selected host is unavailable.' }; }
    if (selection.identity === this.selected) return;
    this.selected = selection.identity;
    const epoch = this.clear(selection.available ? 'Loading native work ledger…' : selection.reason);
    if (!selection.available || !this.opened || this.epoch !== epoch) return;
    const current = (): boolean => {
      if (!this.opened || epoch !== this.epoch) return false;
      this.synchronize(); // Re-check host/auth/workspace across every async gap.
      return this.opened && epoch === this.epoch;
    };
    const fail = (error: unknown): void => {
      if (!current()) return;
      const cleared = this.clear(error instanceof Error ? error.message : 'Native work ledger unavailable.');
      if (this.epoch === cleared) this.changed();
    };
    try {
      const binding = selection.bind(fail);
      if (!binding.available) { fail(new Error(binding.reason)); return; }
      const client = binding.client;
      if (!current()) { try { binding.execution?.dispose(); } catch {} try { client.dispose(); } catch {} return; }
      let unsubscribe: (() => void) | undefined;
      let detached = false; let disposed = false;
      const cleanup = (): void => {
        try { if (unsubscribe && !detached) { detached = true; unsubscribe(); } }
        finally { if (!disposed) { disposed = true; client.dispose(); } }
      };
      this.release = cleanup;
      if (binding.execution) { this.controls.bind(binding.execution, client, current); this.executionAvailable = true; }
      if (client.projectId !== selection.projectId) throw new Error('Selected host project mismatch.');
      let busy = false; let pending = false; let cursor = 0;
      let provenance: WorkLedgerReadSnapshot['provenance']; let projectionEpoch = 0;
      const protect = (events: readonly WorkLedgerReadEvent[]): WorkLedgerReadEvent[] => events.map(event => event.type === 'import_legacy' && provenance === 'requires_read_knowledge'
        ? { type: event.type, sequence: event.sequence, actorId: event.actorId, requestId: event.requestId, at: event.at, works: event.works, manifest: null, provenance: 'requires_read_knowledge' } : event);
      const observe = (snapshot: WorkLedgerReadSnapshot): void => {
        if (!current() || snapshot.projectId !== selection.projectId || snapshot.provenance === undefined || snapshot.provenance === provenance) return;
        const prior = provenance; provenance = snapshot.provenance; projectionEpoch += 1;
        if (provenance === 'requires_read_knowledge') this.history = protect(this.history);
        else if (prior === 'requires_read_knowledge') { this.history = []; cursor = 0; this.reason = 'Refreshing authorized legacy provenance…'; }
        if (this.snapshot) this.snapshot = { ...this.snapshot, provenance };
        // A permission boundary must purge interaction-frozen source rows now.
        this.identity = `native:${epoch}:projection:${projectionEpoch}`;
        this.changed();
      };
      const catchUp = async (): Promise<void> => {
        if (!current()) return;
        if (busy) { pending = true; return; }
        busy = true;
        try {
          do {
            pending = false;
            const snapshot = await client.readSnapshot();
            if (!current()) return;
            if (snapshot.projectId !== selection.projectId || snapshot.cursor < cursor) throw new Error('Selected host project or cursor changed.');
            observe(snapshot);
            const projection = projectionEpoch;
            const events = await client.history(cursor);
            if (!current()) return;
            if (projection !== projectionEpoch) { pending = true; continue; }
            let next = cursor;
            for (const event of events) {
              if (event.sequence !== next + 1) throw new Error('Native work history has a cursor gap.');
              next = event.sequence;
            }
            if (next < snapshot.cursor) throw new Error('Native work history is behind the snapshot.');
            cursor = next;
            this.history = [...this.history, ...protect(events)].slice(-500);
            // A newer durable event landed during the snapshot read: catch up again
            // before presenting it. Notifications themselves never advance cursor.
            if (cursor > snapshot.cursor) { pending = true; continue; }
            // Retire this binding's loading-only structure once. ConfigModal may
            // already be interaction-frozen after host/auth replacement (or a
            // key pressed during loading); ready rows must paint without a key.
            // Later live updates retain the identity and normal scroll guards.
            if (!this.snapshot) this.identity = `native:${epoch}:ready`;
            this.controls.observe(snapshot);
            this.snapshot = snapshot; this.reason = ''; this.changed();
          } while (pending && current());
        } catch (error) { fail(error); }
        finally { busy = false; }
      };
      // Subscribe before initial snapshot, including synchronous subscription callbacks.
      unsubscribe = client.subscribe(snapshot => { observe(snapshot); void catchUp(); });
      if (!current()) { cleanup(); return; }
      void catchUp();
    } catch (error) { fail(error); }
  }
}
