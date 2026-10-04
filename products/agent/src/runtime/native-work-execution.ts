import type { WorkLedgerReadClient, WorkLedgerReadSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger';
import type { OperatorNativeWorkExecutionClient, NativeWorkExecutionIdentity, NativeWorkExecutionSnapshot } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';

export type NativeWorkExecutionAction = 'start' | 'status' | 'cancel' | 'resume';
export interface NativeWorkExecutionState {
  readonly workId: string;
  readonly action: NativeWorkExecutionAction;
  readonly busy: boolean;
  readonly message: string;
  readonly snapshot?: NativeWorkExecutionSnapshot;
}

function failureMessage(error: unknown, action: NativeWorkExecutionAction): string {
  const known: Readonly<Record<string, string>> = {
    NATIVE_EXECUTION_NOT_FOUND: 'No admitted native execution exists for this attempt. Start is an explicit separate action.',
    NATIVE_EXECUTION_UNSUPPORTED_AUTHORITY: 'This operation requires an existing live paired operator with native work execution authority.',
    NATIVE_EXECUTION_REFUSED: 'Jev refused this execution. It will not be retried automatically.',
    NATIVE_EXECUTION_STALE: 'Native work, attempt or authority changed. Inspect status before choosing a new action.',
    NATIVE_EXECUTION_CONFLICT: 'Native execution conflicts with the recorded admission. Inspect status before choosing a new action.',
    NATIVE_EXECUTION_RECOVERY_REQUIRED: 'Host recovery is required. Inspect status, then use explicit resume only if still appropriate.',
  };
  try {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && Object.hasOwn(known, code)) return known[code]!;
  } catch { /* no untrusted error detail is shown */ }
  return `Native ${action} failed or was interrupted; server outcome is unknown. Check status and daemon authorization before retrying.`;
}

function resultMessage(snapshot: NativeWorkExecutionSnapshot): string {
  if (snapshot.kind === 'pending-intent') {
    if (snapshot.state === 'refused') return 'Admission refused. No execution receipt exists. Recovery requires an explicit resume action.';
    return snapshot.recovery === 'required'
      ? 'Admission pending. No execution receipt exists. Recovery requires an explicit resume action.'
      : 'Admission pending. No execution receipt exists. Inspect status to observe the outcome.';
  }
  if (snapshot.kind === 'prevented-before-admission') return 'Cancelled before admission. No execution receipt was created. A new native attempt is required to run this work.';
  if (snapshot.state !== 'cancelled' && snapshot.settlement?.state === 'published') return 'Verification publication recorded. Explicit resume reconciles this receipt without restarting execution.';
  if (snapshot.state !== 'cancelled' && snapshot.progress?.status === 'passed') return 'Execution passed. Explicit resume retries verification and publication without restarting execution.';
  return snapshot.recovery === 'required'
    ? 'Host recovery required. Resume only through the explicit resume control.'
    : 'Execution snapshot received. Completion is determined by native ledger verification.';
}

/** Explicit controls over existing native work. No intake, criteria editing or automatic recovery. */
export class NativeWorkExecutionControls {
  state: NativeWorkExecutionState | undefined;
  private binding: { client: OperatorNativeWorkExecutionClient; reader: WorkLedgerReadClient; current: () => boolean } | undefined;
  private readonly observed = new Map<string, NativeWorkExecutionIdentity>();
  private generation = 0;
  private request = 0;
  private pending: AbortController | undefined;
  constructor(private readonly changed: () => void) {}
  bind(client: OperatorNativeWorkExecutionClient, reader: WorkLedgerReadClient, current: () => boolean): void {
    this.clear(); this.binding = { client, reader, current };
  }
  clear(): void {
    ++this.generation; ++this.request;
    const binding = this.binding; this.binding = undefined;
    const pending = this.pending; this.pending = undefined; this.state = undefined; this.observed.clear();
    pending?.abort();
    try { binding?.client.dispose(); } catch { /* local cleanup cannot retain an old host */ }
  }
  observe(snapshot: WorkLedgerReadSnapshot): void {
    if (!this.binding || snapshot.projectId !== this.binding.reader.projectId) return;
    // Remember authenticated rows before their first action. A newly fetched
    // handoff must not silently retarget an explicitly displayed cancellation.
    for (const { work, attempt } of snapshot.works) {
      if (this.observed.has(work.id) || !attempt || work.currentAttemptId !== attempt.id || attempt.workId !== work.id) continue;
      this.observed.set(work.id, { workId: work.id, attemptId: attempt.id, expectedRevision: { work: work.revision, criteria: work.criteriaRevision, attempt: attempt.revision } });
    }
  }
  observedAttempt(workId: string): string | undefined { return this.observed.get(workId)?.attemptId; }
  async run(action: NativeWorkExecutionAction, workId: string): Promise<NativeWorkExecutionState | undefined> {
    const binding = this.binding;
    if (!binding) return;
    const generation = this.generation;
    // A second mutation is never queued. Explicit Cancel may interrupt a pending
    // local request and separately ask the host to cancel the selected attempt.
    if (this.pending && action !== 'cancel') return;
    this.pending?.abort();
    const controller = new AbortController(); this.pending = controller;
    const request = ++this.request;
    const current = (): boolean => binding.current() && generation === this.generation && request === this.request && !controller.signal.aborted;
    if (!current()) { if (this.pending === controller) this.pending = undefined; controller.abort(); return; }
    this.state = { workId, action, busy: true, message: `Reading current native attempt for ${action}…` }; this.changed();
    try {
      if (!current()) return;
      const snapshot = await binding.reader.readSnapshot();
      if (!current()) return;
      if (snapshot.projectId !== binding.reader.projectId) throw new Error('project changed');
      const view = snapshot.works.find(item => item.work.id === workId);
      const retained = action === 'status' || action === 'cancel' ? this.observed.get(workId) : undefined;
      if (!retained && (!view?.attempt || view.work.currentAttemptId !== view.attempt.id || view.attempt.workId !== view.work.id)) {
        this.state = { workId, action, busy: false, message: 'Select an existing native work item with a current attempt.' }; this.changed(); return current() ? this.state : undefined;
      }
      const active = view?.attempt?.state === 'active' && view.work.reportedState !== 'complete' && view.work.reportedState !== 'cancelled';
      if (action === 'start' && !active) {
        this.state = { workId, action, busy: false, message: 'Start requires an existing active native attempt.' }; this.changed(); return current() ? this.state : undefined;
      }
      // Only current authenticated ledger facts become trusted identity fields.
      // Original goal/criteria never leave this read model as writable input.
      let identity = retained ?? (view?.attempt ? { workId: view.work.id, attemptId: view.attempt.id, expectedRevision: {
        work: view.work.revision, criteria: view.work.criteriaRevision, attempt: view.attempt.revision,
      } } : undefined);
      if (!identity) return;
      if (action === 'resume') {
        // Read the selected current attempt first. A completed ledger may be a
        // lost publication acknowledgment, so retain its admitted revisions for
        // exact receipt reconciliation rather than silently retargeting work.
        const observed = await binding.client.status(identity, { signal: controller.signal });
        if (!current()) return;
        const settlement = observed.kind === 'execution' && observed.state !== 'cancelled'
          && (observed.settlement?.state === 'published' || observed.progress?.status === 'passed');
        if (settlement) identity = { workId: observed.workId, attemptId: observed.attemptId, expectedRevision: observed.expectedRevision };
        else if (!active || (observed.kind === 'execution' && (observed.state === 'cancelled' || observed.recovery === 'terminal'))) {
          this.state = { workId, action, busy: false, snapshot: observed, message: 'This attempt cannot resume execution. Only a passed execution can retry verification or reconcile publication.' };
          this.changed(); return current() ? this.state : undefined;
        }
      }
      // Retain the observed attempt across handoff/revision drift, including an
      // uncertain transport result. Only explicit start/resume selects a new one.
      this.observed.set(workId, identity);
      this.state = { workId, action, busy: true, message: `Native ${action} request pending…` }; this.changed();
      if (!current()) return;
      const result = await binding.client[action](identity, { signal: controller.signal });
      if (!current()) return;
      this.state = { workId, action, busy: false, snapshot: result, message: resultMessage(result) };
      this.changed();
      return current() ? this.state : undefined;
    } catch (error) {
      if (!current()) return;
      // Transport errors can contain host URLs or credentials. Keep them out of
      // terminal output and do not convert an uncertain request into success.
      this.state = { workId, action, busy: false, message: failureMessage(error, action) };
      this.changed();
      return current() ? this.state : undefined;
    } finally { if (generation === this.generation && request === this.request) this.pending = undefined; }
  }
}

/** Honest transport progress, separate from work verification and success evidence. */
export function nativeWorkExecutionLines(state: NativeWorkExecutionState | undefined): string[] {
  if (!state) return [];
  const lines = [`Native work ${state.workId} · ${state.action}${state.busy ? ' pending' : ''}`, state.message];
  const snapshot = state.snapshot;
  if (!snapshot) return lines;
  const requested = snapshot.expectedRevision; const current = snapshot.currentRevision;
  const execution = snapshot.kind === 'execution';
  lines.push(`${execution ? 'Execution attempt' : 'Admission intent'} ${snapshot.attemptId} · ${snapshot.state} · recovery ${snapshot.recovery}`,
    `${execution ? 'Admitted' : 'Requested'} revisions: work ${requested.work} · criteria ${requested.criteria} · attempt ${requested.attempt}`,
    current ? `Current revisions: work ${current.work} · criteria ${current.criteria} · attempt ${current.attempt}` : 'Current revisions unavailable.',
    `Current attempt: ${snapshot.currentAttempt} · stale: ${snapshot.stale}`);
  if (snapshot.kind !== 'execution') return lines;
  if (snapshot.receipt) lines.push(`Receipt: contract ${snapshot.receipt.contractId} · owner ${snapshot.receipt.ownerAgentId}`);
  if (snapshot.settlement) lines.push(`Verification publication: ${snapshot.settlement.state}${snapshot.settlement.evidenceId ? ` · evidence ${snapshot.settlement.evidenceId}` : ''}`);
  const progress = snapshot.progress;
  if (progress) lines.push(`Progress: ${progress.status} · semantic ${progress.semanticState ?? 'none'} · stage ${progress.stage ?? 'none'} · retrying ${progress.retrying}`,
    `Units: ${progress.units.passed}/${progress.units.total} passed · ${progress.units.failed} failed`,
    `Criteria progress: ${progress.criteria.met}/${progress.criteria.total} met · ${progress.criteria.unmet} unmet · ${progress.criteria.unshown} unshown`);
  return lines;
}
