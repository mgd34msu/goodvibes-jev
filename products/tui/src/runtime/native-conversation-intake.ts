import type { OperatorNativeWorkExecutionClient } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';
import { nativeWorkExecutionLines, type NativeWorkExecutionState } from './native-work-execution.ts';
import { nativeConversationExecutionIntent, sameNativeExecutionIntent, inspectNativeConversationExecution, dispatchNativeConversationExecution } from './native-conversation-execution.ts';
import {
  nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeResultSchema,
  type NativeConversationIntakeCaptureRequest, type NativeConversationIntakeResult,
  type OperatorNativeConversationIntakeClient, type NativeConversationTurnPermit,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import type { NativeConversationInput } from './native-conversation-input.ts';
import type { NativeIntakeJournalBinding, NativeConversationIntakeJournal } from './native-conversation-intake-journal.ts';

export interface NativeConversationIntakeBinding {
  readonly client: OperatorNativeConversationIntakeClient;
  readonly execution: OperatorNativeWorkExecutionClient;
  readonly readPrincipal: (signal: AbortSignal) => Promise<string>;
  readonly dispose: () => void;
}
export type NativeConversationIntakeSelection =
  | { readonly available: false; readonly identity: string; readonly reason: string }
  | { readonly available: true; readonly identity: string; readonly endpoint: string; readonly projectId: string; readonly workspace: string;
      readonly journal: Pick<NativeConversationIntakeJournal, 'read' | 'save' | 'confirm' | 'claimTurn' | 'saveExecutionIntent'>; readonly bind: () => NativeConversationIntakeBinding };
export interface NativeConversationIntakeState {
  readonly status: 'pending' | 'recorded' | 'unknown' | 'invalid' | 'unavailable';
  readonly message: string;
  readonly request?: Readonly<Pick<NativeConversationIntakeCaptureRequest, 'requestId' | 'inputId'>>;
  readonly result?: NativeConversationIntakeResult;
  /** Durable local dispatch claim acquired by this call only, never get/status. */
  readonly turnReady?: boolean;
  readonly turnPermit?: NativeConversationTurnPermit;
  readonly execution?: NativeWorkExecutionState;
}
export interface NativeConversationIntakeActions {
  submit(source: NativeConversationInput): Promise<NativeConversationIntakeState | undefined>;
  status(): Promise<NativeConversationIntakeState | undefined>;
  retry(): Promise<NativeConversationIntakeState | undefined>;
  resume(): Promise<NativeConversationIntakeState | undefined>;
  cancel(): Promise<NativeConversationIntakeState | undefined>;
  close(): void;
}
type Mode = 'submit' | 'status' | 'retry' | 'resume' | 'cancel';
const terminal = (result: NativeConversationIntakeResult) => ['turn', 'work', 'blocked', 'refused', 'cancelled'].includes(result.kind);
const sameCommand = (left: NativeConversationIntakeCaptureRequest, right: NativeConversationIntakeCaptureRequest) => JSON.stringify(left) === JSON.stringify(right);

/** Persist exact input first. Interrupted processing requires an explicit resume. */
export class NativeConversationIntakeControls implements NativeConversationIntakeActions {
  private epoch = 0;
  private active: { readonly identity: string; readonly detach: () => void } | undefined;
  private retained: { readonly identity: string; readonly scope: NativeIntakeJournalBinding; readonly command: NativeConversationIntakeCaptureRequest; persisted: boolean; readonly expectedRequestId: string | null } | undefined;
  constructor(private readonly select: () => NativeConversationIntakeSelection, private readonly newId: () => string = () => crypto.randomUUID()) {}
  private selection(): NativeConversationIntakeSelection {
    try { return this.select(); } catch { return { available: false, identity: 'selection-error', reason: 'Native intake host or journal is unavailable.' }; }
  }
  close(): void { ++this.epoch; this.active?.detach(); this.active = undefined; }
  submit(source: NativeConversationInput) { return this.run('submit', structuredClone(source)); }
  status() { return this.run('status'); }
  retry() { return this.run('retry'); }
  resume() { return this.run('resume'); }
  cancel() { return this.run('cancel'); }

  private async run(mode: Mode, source?: NativeConversationInput): Promise<NativeConversationIntakeState | undefined> {
    const selected = this.selection();
    if (this.active) {
      if (!selected.available || selected.identity !== this.active.identity) { this.close(); return; }
      if (mode === 'cancel') this.close();
      else return { status: 'pending', message: 'Native intake is already pending. No second input or dispatch was created.' };
    }
    if (!selected.available) return { status: 'unavailable', message: selected.reason };
    // Validate source before network access or identity allocation.
    if (source && !nativeConversationIntakeCaptureRequestSchema.safeParse({ requestId: 'validation', inputId: 'validation', text: source.text, unsupportedSources: source.unsupportedSources }).success) {
      return { status: 'invalid', message: 'Native intake requires complete bounded original text and at most 100 source references.' };
    }
    const epoch = ++this.epoch; const controller = new AbortController();
    let binding: NativeConversationIntakeBinding | undefined; let disposed = false;
    let command: NativeConversationIntakeCaptureRequest | undefined; let phase = 'principal';
    const current = (): boolean => {
      if (epoch !== this.epoch || controller.signal.aborted) return false;
      const now = this.selection(); return now.available && now.identity === selected.identity;
    };
    const dispose = () => { if (!disposed && binding) { disposed = true; try { binding.dispose(); } catch {} } };
    const detach = () => { controller.abort(); dispose(); };
    this.active = { identity: selected.identity, detach };
    const timer = setInterval(() => { if (!current()) detach(); }, 100); timer.unref?.();
    const request = () => command ? { requestId: command.requestId, inputId: command.inputId } : undefined;
    const validate = (result: NativeConversationIntakeResult): NativeConversationIntakeResult => {
      const parsed = nativeConversationIntakeResultSchema.parse(result);
      if (!command || parsed.projectId !== selected.projectId || parsed.requestId !== command.requestId || parsed.sourceRef.inputId !== command.inputId
        || (parsed.kind === 'turn' && parsed.text !== command.text) || (parsed.kind === 'work' && parsed.receipt.goal !== command.text)) throw new Error('Native intake source identity mismatch');
      return result;
    };
    try {
      binding = selected.bind(); if (!current()) return;
      const principalId = await binding.readPrincipal(controller.signal); if (!current()) return;
      if (!principalId || principalId === 'shared-token' || principalId.length > 200) throw new Error('Unsupported native principal');
      const scope: NativeIntakeJournalBinding = { endpoint: selected.endpoint, projectId: selected.projectId, workspace: selected.workspace, principalId };
      phase = 'journal-read';
      const stored = await selected.journal.read(scope); if (!current()) return;
      const retained = this.retained;
      if (retained?.identity === selected.identity && JSON.stringify(retained.scope) === JSON.stringify(scope)) {
        if (stored?.command.requestId === retained.command.requestId && !sameCommand(stored.command, retained.command)) throw new Error('Retained source changed');
        command = !retained.persisted ? retained.command : stored?.command ?? retained.command;
      } else command = stored?.command;
      let result: NativeConversationIntakeResult | undefined;
      let eligibleTurn = false;
      if (command) {
        phase = 'get'; const found = await binding.client.get({ inputId: command.inputId }, { signal: controller.signal }); if (!current()) return;
        if (found.kind !== 'not-found') result = validate(found);
      }
      if (mode === 'submit' && command && result?.kind === 'work') {
        const intent = nativeConversationExecutionIntent(result.receipt);
        if (stored?.execution && !sameNativeExecutionIntent(stored.execution, intent)) throw new Error('Execution intent differs from recorded work');
        phase = 'execution-status';
        const execution = await inspectNativeConversationExecution(binding.execution, selected.projectId, intent, controller.signal); if (!current()) return;
        if (!execution.snapshot) return { status: 'recorded', message: 'The original admitted work has an unresolved dispatch. Inspect status or use /work intake-retry before submitting another input.', request: request(), result, execution };
      }
      if (mode === 'submit') {
        if (command && (!result || !terminal(result))) return { status: 'unknown', message: 'An original input is unresolved. Use /work intake-status, intake-retry or intake-resume before submitting another input.', request: request(), ...(result ? { result } : {}) };
        command = nativeConversationIntakeCaptureRequestSchema.parse({ requestId: this.newId(), inputId: this.newId(), text: source!.text, unsupportedSources: source!.unsupportedSources });
        this.retained = { identity: selected.identity, scope, command: structuredClone(command), persisted: false, expectedRequestId: stored?.command.requestId ?? null };
        phase = 'journal-save'; await selected.journal.save(scope, command, stored?.command.requestId ?? null); if (!current()) return;
        this.retained.persisted = true;
        result = undefined;
      } else if (!command) return { status: 'unavailable', message: 'No retained ordinary input exists for this host, project, workspace and verified principal.' };
      if (!command) throw new Error('Missing original source');
      // A definite pre-publication failure can be repaired by explicit retry,
      // using the same command and original CAS predecessor. Published bytes
      // are confirmed in place; a competing durable identity is never replaced.
      if (mode === 'retry' && retained && !retained.persisted && sameCommand(command, retained.command)) {
        if (!stored || !sameCommand(stored.command, command)) {
          phase = 'journal-save';
          await selected.journal.save(scope, command, retained.expectedRequestId); if (!current()) return;
        }
        phase = 'journal-confirm'; await selected.journal.confirm(scope, command); if (!current()) return;
        retained.persisted = true;
      }
      if (!result && (mode === 'submit' || mode === 'retry')) {
        phase = 'journal-confirm'; await selected.journal.confirm(scope, command); if (!current()) return;
        phase = 'capture'; result = validate(await binding.client.capture(command, { signal: controller.signal })); if (!current()) return; eligibleTurn = result.kind === 'turn';
      }
      if (!result) return { status: 'unknown', message: 'Original input was not found at this lookup. Only intake-retry may replay its exact durable capture.', request: request() };
      const transition = { inputId: command.inputId, sourceRevision: result.sourceRef.sourceRevision };
      const confirm = async () => { phase = 'journal-confirm'; await selected.journal.confirm(scope, command!); };
      if (result.kind === 'captured' && (mode === 'submit' || mode === 'retry')) {
        await confirm(); if (!current()) return;
        phase = 'admit'; result = validate(await binding.client.admit(transition, { signal: controller.signal })); if (!current()) return; eligibleTurn = result.kind === 'turn';
      } else if (mode === 'resume' && (result.kind === 'processing' || result.kind === 'captured')) {
        await confirm(); if (!current()) return;
        phase = 'resume'; result = validate(await binding.client.resume(transition, { signal: controller.signal })); if (!current()) return; eligibleTurn = result.kind === 'turn';
      } else if (mode === 'cancel' && !terminal(result)) {
        await confirm(); if (!current()) return;
        phase = 'cancel'; result = validate(await binding.client.cancel(transition, { signal: controller.signal })); if (!current()) return;
      }
      // Lookup cannot authorize a local turn. Explicit recovery may request the
      // same immutable terminal response, provided no dispatch was claimed.
      if (result.kind === 'turn' && !eligibleTurn && (mode === 'retry' || mode === 'resume') && !stored?.dispatch) {
        await confirm(); if (!current()) return;
        phase = 'resume'; result = validate(await binding.client.resume(transition, { signal: controller.signal })); if (!current()) return;
        eligibleTurn = result.kind === 'turn';
      }
      let turnReady = false;
      if (result.kind === 'turn' && eligibleTurn && mode !== 'status' && mode !== 'cancel') {
        phase = 'journal-claim'; turnReady = await selected.journal.claimTurn(scope, command, result.sourceRef.sourceRevision); if (!current()) return;
      }
      let execution: NativeWorkExecutionState | undefined;
      if (result.kind === 'work') {
        const intent = nativeConversationExecutionIntent(result.receipt);
        const existing = stored?.command.requestId === command.requestId ? stored.execution : undefined;
        if (existing && !sameNativeExecutionIntent(existing, intent)) throw new Error('Execution intent differs from recorded work');
        if (mode === 'submit' || mode === 'retry' || mode === 'resume') {
          phase = 'journal-execution'; await selected.journal.saveExecutionIntent(scope, command, intent); if (!current()) return;
          phase = 'execution-dispatch'; execution = await dispatchNativeConversationExecution(binding.execution, selected.projectId, intent, controller.signal); if (!current()) return;
        } else {
          phase = 'execution-status'; execution = await inspectNativeConversationExecution(binding.execution, selected.projectId, intent, controller.signal); if (!current()) return;
        }
      }
      const turnPermit = turnReady ? binding.client.bindTurn(result) : undefined;
      return { status: 'recorded', message: describeResult(result, turnReady, Boolean(stored?.dispatch)), request: request(), result, ...(execution ? { execution } : {}), ...(turnReady ? { turnReady: true, turnPermit } : {}) };
    } catch {
      if (!current()) return;
      return { status: command ? 'unknown' : 'unavailable', request: request(), message: phase.startsWith('journal-')
        ? 'The durable intake journal could not be confirmed. No further request or ordinary turn was sent. The visible original input and dispatch claim are preserved.'
        : 'Native intake outcome is unknown or unavailable. Inspect /work intake-status before retrying the same input. No legacy turn or work execution was started.' };
    } finally { clearInterval(timer); dispose(); if (epoch === this.epoch) this.active = undefined; }
  }
}
function describeResult(result: NativeConversationIntakeResult, turnReady: boolean, dispatched: boolean): string {
  switch (result.kind) {
    case 'captured': return 'Original text is durably captured. Use /work intake-retry to request admission.';
    case 'processing': return `Native intake is ${result.stage}. Use /work intake-status to inspect or intake-resume for explicit recovery.`;
    case 'turn': return turnReady ? `Native ${result.route} decision recorded; original turn dispatch claimed.` : dispatched ? 'Recovery required: this original turn already has a durable dispatch claim and may have run. Inspect the conversation before submitting a new input; it will not be automatically replayed.' : 'Native conversational decision is recorded. This lookup did not dispatch it. Use /work intake-retry for explicit recovery.';
    case 'blocked': return `Native intake blocked: ${result.reason}. This input is unchanged; submit a new complete input to proceed.`;
    case 'refused': return `Native intake refused: ${result.reason}. This input cannot be retried into new work.`;
    case 'cancelled': return 'Native intake cancelled. No ordinary turn or work execution was started.';
    case 'work': return 'Native work admission recorded against the original source. Execution status is shown separately.';
  }
}
export function nativeConversationIntakeLines(state: NativeConversationIntakeState | undefined): string[] {
  if (!state) return ['Native intake detached because its host, credentials or workspace changed. No stale turn was dispatched.'];
  const lines = [state.message];
  if (state.request) lines.push(`requestId ${state.request.requestId} · inputId ${state.request.inputId}`);
  if (state.result?.kind === 'work') {
    const receipt = state.result.receipt;
    lines.push(`Native target: work ${receipt.workId} · attempt ${receipt.attemptId} · ledger revision ${receipt.ledgerRevision}`,
      `Inspect /work for native status and explicit recovery controls. Source ${receipt.source.sourceId} revision ${receipt.source.sourceRevision}.`);
  }
  if (state.execution) lines.push(...nativeWorkExecutionLines(state.execution));
  return lines.map(line => line.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' '));
}
