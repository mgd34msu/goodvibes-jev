import type { NativeWorkSubmissionState } from './native-work-submission.ts';
import { NativeWorkExecutionControls, type NativeWorkExecutionAction, type NativeWorkExecutionState } from './native-work-execution.ts';
import type { OperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import type { WorkLedgerReadBinding, WorkLedgerReadClient, WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import type { WorkLedgerReadEvent } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';

export type NativeWorkLedgerBinding = WorkLedgerReadBinding & { readonly execution?: OperatorNativeWorkExecutionClient };

export type NativeWorkLedgerState =
  | { readonly status: 'closed' | 'loading' | 'unavailable'; readonly reason: string }
  | { readonly status: 'ready'; readonly snapshot: WorkLedgerReadSnapshot; readonly history: readonly WorkLedgerReadEvent[]; readonly cursor: number; readonly execution?: NativeWorkExecutionState };

/** One view owns one reader and its durable history cursor. It never owns a store. */
export class NativeWorkLedgerModel {
  private epoch = 0;
  private client: WorkLedgerReadClient | undefined;
  private unsubscribe: (() => void) | undefined;
  private pending: WorkLedgerReadSnapshot | undefined;
  private draining = false;
  private cursor = 0;
  private highestSnapshotCursor = -1;
  private history: WorkLedgerReadEvent[] = [];
  private provenance: WorkLedgerReadSnapshot['provenance'];
  private projectionEpoch = 0;
  private protect(events: readonly WorkLedgerReadEvent[]): WorkLedgerReadEvent[] {
    return events.map(event => event.type === 'import_legacy' && this.provenance === 'requires_read_knowledge'
      ? { type: event.type, sequence: event.sequence, actorId: event.actorId, requestId: event.requestId, at: event.at, works: event.works, manifest: null, provenance: 'requires_read_knowledge' } : event);
  }
  state: NativeWorkLedgerState = { status: 'closed', reason: 'Native work ledger view is closed.' };
  private readonly execution = new NativeWorkExecutionControls(() => {
    if (this.state.status === 'ready') this.publish(this.state);
  });
  constructor(private readonly changed: () => void = () => {}, private readonly current: () => boolean = () => true) {}
  private publish(state: NativeWorkLedgerState): void { this.state = state.status === 'ready' ? { ...state, execution: this.execution.state } : state; this.changed(); }
  execute(action: NativeWorkExecutionAction, workId: string): Promise<NativeWorkExecutionState | undefined> { return this.execution.run(action, workId); }
  private release(): number {
    const epoch = ++this.epoch;
    const unsubscribe = this.unsubscribe; const client = this.client;
    this.unsubscribe = undefined; this.client = undefined; this.pending = undefined;
    this.provenance = undefined; this.projectionEpoch += 1;
    this.draining = false; this.cursor = 0; this.highestSnapshotCursor = -1; this.history = [];
    // Revoke local references before any external cleanup can reenter.
    this.execution.clear();
    // Independent cleanup: a throwing observer must not retain the reader.
    try { unsubscribe?.(); } catch { /* best effort */ }
    try { client?.dispose(); } catch { /* best effort */ }
    return epoch;
  }
  loading(reason: string): void { const epoch = this.release(); if (epoch === this.epoch) this.publish({ status: 'loading', reason }); }
  close(): void { const epoch = this.release(); if (epoch === this.epoch) this.publish({ status: 'closed', reason: 'Native work ledger view is closed.' }); }
  unavailable(reason: string): void { const epoch = this.release(); if (epoch === this.epoch) this.publish({ status: 'unavailable', reason }); }
  open(binding: NativeWorkLedgerBinding): void {
    const released = this.release();
    if (released !== this.epoch) {
      if (binding.available && binding.client !== this.client) {
        try { binding.execution?.dispose(); } catch {}
        try { binding.client.dispose(); } catch {}
      }
      return;
    }
    if (!binding.available) { this.publish({ status: 'unavailable', reason: binding.reason }); return; }
    const client = binding.client; this.client = client; const epoch = this.epoch;
    if (binding.execution) this.execution.bind(binding.execution, client, () => this.current() && epoch === this.epoch && this.client === client);
    this.publish({ status: 'loading', reason: 'Reading native work ledger and durable history…' });
    if (epoch !== this.epoch) return;
    try {
      const unsubscribe = client.subscribe(snapshot => this.accept(snapshot, epoch));
      if (epoch !== this.epoch) { try { unsubscribe(); } catch {} return; }
      this.unsubscribe = unsubscribe;
      const projectionEpoch = this.projectionEpoch;
      void client.readSnapshot().then(snapshot => {
        // The reader can notify a newer projection before an older snapshot's
        // promise continuation runs. Keep that notification's provenance while
        // still accepting durable snapshot contents through the cursor fence.
        this.accept(projectionEpoch === this.projectionEpoch ? snapshot : { ...snapshot, provenance: this.provenance }, epoch);
      }, error => this.fail(error, epoch));
    } catch (error) { this.fail(error, epoch); }
  }
  private fail(error: unknown, epoch: number): void {
    if (epoch !== this.epoch) return;
    this.unavailable(error instanceof Error ? error.message : String(error));
  }
  private accept(snapshot: WorkLedgerReadSnapshot, epoch: number): void {
    if (epoch !== this.epoch || !this.client) return;
    if (snapshot.projectId !== this.client.projectId) { this.fail(new Error('Host project binding changed.'), epoch); return; }
    if (snapshot.cursor < this.highestSnapshotCursor) return;
    if (snapshot.provenance !== undefined && snapshot.provenance !== this.provenance) {
      const prior = this.provenance; this.provenance = snapshot.provenance; this.projectionEpoch += 1;
      if (this.provenance === 'requires_read_knowledge') {
        this.history = this.protect(this.history);
        if (this.state.status === 'ready') this.publish({ ...this.state, snapshot: { ...this.state.snapshot, provenance: this.provenance }, history: [...this.history] });
      } else if (prior === 'requires_read_knowledge') { this.history = []; this.cursor = 0; }
      if (epoch !== this.epoch || !this.client) return;
    }
    this.highestSnapshotCursor = snapshot.cursor;
    this.pending = snapshot;
    if (!this.draining) void this.drain(epoch);
  }
  private enqueue(snapshot: WorkLedgerReadSnapshot): void {
    this.highestSnapshotCursor = Math.max(this.highestSnapshotCursor, snapshot.cursor);
    if (!this.pending || this.pending.cursor < snapshot.cursor) this.pending = snapshot;
  }
  private async drain(epoch: number): Promise<void> {
    this.draining = true;
    try {
      while (epoch === this.epoch && this.pending && this.client) {
        let snapshot = this.pending; this.pending = undefined;
        const projectionEpoch = this.projectionEpoch;
        const events = await this.client.history(this.cursor);
        if (epoch !== this.epoch) return;
        if (projectionEpoch !== this.projectionEpoch) continue;
        let cursor = this.cursor;
        for (const event of events) {
          if (event.sequence !== cursor + 1) throw new Error('Native ledger history has a sequence gap. Reopen to reload.');
          cursor = event.sequence;
        }
        if (cursor < snapshot.cursor) throw new Error('Native ledger history is behind its snapshot. Reopen to reload.');
        this.history.push(...this.protect(events)); this.cursor = cursor;
        if (cursor > snapshot.cursor) {
          snapshot = await this.client.readSnapshot();
          if (epoch !== this.epoch) return;
          if (projectionEpoch !== this.projectionEpoch) continue;
          if (snapshot.projectId !== this.client.projectId || snapshot.cursor < cursor) throw new Error('Native ledger snapshot is behind durable history. Reopen to reload.');
          if (snapshot.cursor > cursor) { this.enqueue(snapshot); continue; }
        }
        this.execution.observe(snapshot);
        this.publish({ status: 'ready', snapshot, history: [...this.history], cursor });
      }
    } catch (error) { this.fail(error, epoch); }
    finally { if (epoch === this.epoch) this.draining = false; }
  }
}

export interface NativeWorkLedgerView {
  readonly intake?: import('./native-conversation-intake.ts').NativeConversationIntakeActions;
  readonly state: NativeWorkLedgerState;
  submitFile?(path: string): Promise<NativeWorkSubmissionState | undefined>;
  submissionStatus?(): Promise<NativeWorkSubmissionState | undefined>;
  retrySubmission?(): Promise<NativeWorkSubmissionState | undefined>;
  selectProject(projectId: string): void;
  open(): void;
  sync(): void;
  close(): void;
  execute?(action: NativeWorkExecutionAction, workId: string): Promise<NativeWorkExecutionState | undefined>;
}
