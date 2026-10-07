import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import type {
  ProjectPlanningDecision,
  ProjectPlanningEvaluation,
  ProjectPlanningLanguageArtifact,
  ProjectPlanningQuestion,
  ProjectPlanningRevision,
  ProjectPlanningService,
  ProjectPlanningState,
  ProjectPlanningStatus,
} from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { buildAnswerActions, readProjectPlanningAnswerActions, type PlanningAnswerAction, type ProjectPlanningAnswerActionsReading } from '../project-planning-answer-actions.ts';
import { selectedPlanningTarget } from '../../input/commands/planning-action-target.ts';

// ---------------------------------------------------------------------------
// Historical Project Planning → 'planning' config-modal surface. Explicit
// /project-plan history opens this retained record view; native intake and the
// default planning entry use the native work ledger instead.
//
// Historical answers and approval remain revision-bound. Approval here does
// not create a native execution grant or migrate a historical record.
// - Canned answers to saved open questions dispatch /project-plan answer.
// - Custom opens manual /project-plan answer guidance; the composer does not
//   inherit the selected revision. Plain text is a separate native request.
// - Synthetic suggestions close the modal before source-less submitInput; the
//   runtime treats them as derived input and may hold them, not start a turn.
// - Dismiss is a confirmed /project-plan dismiss action; Esc only closes.
// ---------------------------------------------------------------------------

const HISTORICAL_TITLE = 'Historical planning';
const HISTORICAL_BOUNDARY = 'Historical approval does not grant native execution or migrate records.';
const CUSTOM_ANSWER_GUIDANCE = 'Reopen /project-plan history to review the current saved question. Use /project-plan answer <question-number|question-id> <your answer> for a saved historical question. This targets the current saved plan. Plain text enters native intake as a separate request.';

export type PlanningModalService = Pick<ProjectPlanningService, 'status' | 'getState' | 'listDecisions' | 'getLanguage' | 'evaluate'>;

export interface PlanningModalDeps {
  readonly service: PlanningModalService;
  readonly projectId: string;
  readonly requestRender?: () => void;
  readonly readAnswerActions?: typeof readProjectPlanningAnswerActions;
}

interface PlanningModalSnapshot {
  readonly status: ProjectPlanningStatus | null;
  readonly state: ProjectPlanningState | null;
  readonly revision: ProjectPlanningRevision | null;
  readonly evaluation: ProjectPlanningEvaluation | null;
  readonly decisions: readonly ProjectPlanningDecision[];
  readonly language: ProjectPlanningLanguageArtifact | null;
}

interface TextLine { readonly content: string; readonly fg?: string; }

function questionBinding(question: Pick<ProjectPlanningQuestion, 'id' | 'prompt' | 'whyItMatters' | 'recommendedAnswer' | 'consequence' | 'status'>): string {
  return JSON.stringify([question.id, question.prompt, question.whyItMatters, question.recommendedAnswer, question.consequence, question.status]);
}

function getCurrentQuestion(state: ProjectPlanningState, evaluation: ProjectPlanningEvaluation | null): ProjectPlanningQuestion | null {
  const open = state.openQuestions.find((question) => (question.status ?? 'open') === 'open');
  return open ?? evaluation?.nextQuestion ?? null;
}

function buildStateLines(state: ProjectPlanningState, evaluation: ProjectPlanningEvaluation | null): TextLine[] {
  const readiness = evaluation?.readiness ?? state.readiness;
  const readinessColor = readiness === 'executable' ? MODAL_TONES.good : readiness === 'needs-user-input' ? MODAL_TONES.warn : undefined;
  const blockingGaps = evaluation?.gaps.filter((gap) => gap.severity === 'blocking').length ?? 'unknown';
  const lines: TextLine[] = [
    { content: `readiness ${readiness}  historical approval ${state.executionApproved ? 'yes' : 'no'}`, ...(readinessColor ? { fg: readinessColor } : {}) },
    { content: `questions ${state.openQuestions.length} open / ${state.answeredQuestions.length} answered  blocking gaps ${blockingGaps}  tasks ${state.tasks.length}  gates ${state.verificationGates.length}` },
    { content: `goal: ${state.goal || '(not set)'}` },
  ];
  if (state.scope) lines.push({ content: `scope: ${state.scope}` });
  if (state.knownContext.length) lines.push({ content: `known context: ${state.knownContext.join(' | ')}` });
  if (evaluation?.nextQuestion) lines.push({ content: `next question: ${evaluation.nextQuestion.prompt}`, fg: MODAL_TONES.info });
  return lines;
}

function buildGapsLines(evaluation: ProjectPlanningEvaluation | null): TextLine[] {
  if (!evaluation) return [{ content: 'Readiness gaps have not been read.', fg: MODAL_TONES.dim }];
  const gaps = evaluation.gaps;
  if (gaps.length === 0) return [{ content: 'Readiness gaps: none.', fg: MODAL_TONES.good }];
  return [{ content: 'Readiness gaps:' }, ...gaps.slice(0, 12).map((gap) => ({ content: `  ${gap.severity.toUpperCase()} ${gap.kind}: ${gap.message}`, fg: gap.severity === 'blocking' ? MODAL_TONES.bad : MODAL_TONES.warn }))];
}

function buildTasksLines(state: ProjectPlanningState): TextLine[] {
  const lines: TextLine[] = [{ content: 'Task graph:' }];
  if (state.tasks.length === 0) {
    lines.push({ content: '  No decomposed tasks recorded yet.' });
  } else {
    for (const task of state.tasks) {
      lines.push({ content: `  ${task.id}: ${task.title} [${task.status ?? 'pending'}]${task.canRunConcurrently ? ' - concurrent' : ''}`, ...(task.blockedOnUserInput ? { fg: MODAL_TONES.warn } : {}) });
      if (task.dependencies?.length) lines.push({ content: `    dependencies: ${task.dependencies.join(', ')}` });
      if (task.verification?.length) lines.push({ content: `    verification: ${task.verification.join(' | ')}`, fg: MODAL_TONES.good });
    }
  }
  if (state.verificationGates.length) {
    lines.push({ content: 'Verification gates:' });
    for (const gate of state.verificationGates) lines.push({ content: `  ${gate.id}: ${gate.description} [${gate.status ?? 'pending'}]`, fg: gate.required === false ? undefined : MODAL_TONES.good });
  }
  if (state.agentAssignments.length) {
    lines.push({ content: 'Agent handoff candidates:' });
    for (const assignment of state.agentAssignments) lines.push({ content: `  ${assignment.taskId}: ${assignment.agentType ?? 'none'}${assignment.canRunConcurrently ? ' - can run concurrently' : ''}`, fg: MODAL_TONES.info });
  }
  return lines;
}

function buildDecisionsLines(state: ProjectPlanningState, storedDecisions: readonly ProjectPlanningDecision[]): TextLine[] {
  const byId = new Map<string, ProjectPlanningDecision>();
  for (const decision of [...storedDecisions, ...state.decisions]) byId.set(decision.id, decision);
  const decisions = [...byId.values()];
  if (decisions.length === 0) return [{ content: 'Decisions: none recorded yet.' }];
  return [{ content: 'Decisions:' }, ...decisions.slice(0, 12).map((decision) => ({ content: `  ${decision.title}: ${decision.decision} [${decision.status ?? 'accepted'}]`, fg: decision.status === 'rejected' ? MODAL_TONES.bad : undefined }))];
}

function buildLanguageLines(language: ProjectPlanningLanguageArtifact | null): TextLine[] {
  if (!language || (language.terms.length === 0 && language.ambiguities.length === 0)) return [{ content: 'Project language: no terms or ambiguity resolutions recorded yet.' }];
  const lines: TextLine[] = [{ content: 'Project language:' }];
  for (const term of language.terms.slice(0, 8)) {
    lines.push({ content: `  ${term.term}: ${term.definition}` });
    if (term.avoid?.length) lines.push({ content: `    avoid: ${term.avoid.join(', ')}`, fg: MODAL_TONES.bad });
  }
  for (const ambiguity of language.ambiguities.slice(0, 8)) lines.push({ content: `  resolved ambiguity - ${ambiguity.phrase}: ${ambiguity.resolution}`, fg: MODAL_TONES.info });
  return lines;
}

class PlanningModalSurface implements ConfigModalSurface {
  readonly name = 'planning-modal';
  readonly title = HISTORICAL_TITLE;
  private snapshot: PlanningModalSnapshot | null = null;
  private loading = false;
  private generation = 0;
  private submission: { readonly generation: number } | null = null;
  private controller: AbortController | null = null;
  private reading: ProjectPlanningAnswerActionsReading | undefined;
  private suggestions: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle';
  private requestRender: () => void = () => {};

  constructor(private readonly deps: PlanningModalDeps) {}

  readonly actions = [
    { key: 'enter', id: 'submit', label: 'submit', enabledFor: () => this.currentAnswerActions().actions.length > 0 },
    { key: 'a', id: 'approve', label: 'approve historical plan' },
    { key: 'd', id: 'dismiss', label: 'dismiss historical plan', confirm: true },
    { key: 'r', id: 'refresh', label: 'refresh' },
  ];

  onOpen(requestRender: () => void): void { this.requestRender = requestRender; this.refresh(); }

  onClose(): void {
    this.controller?.abort();
    this.controller = null;
    this.generation++;
    this.submission = null;
    this.loading = false;
    this.reading = undefined;
  }

  private repaint(): void { this.requestRender(); this.deps.requestRender?.(); }

  private refresh(): void {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.submission = null;
    this.loading = true;
    this.snapshot = null;
    this.reading = undefined;
    this.suggestions = 'idle';
    void this.load(generation, controller.signal);
  }

  private current(generation: number, signal: AbortSignal): boolean {
    return generation === this.generation && !signal.aborted;
  }

  private async load(generation: number, signal: AbortSignal): Promise<void> {
    try {
      const [status, stateResult, decisionsResult, languageResult] = await Promise.all([
        this.deps.service.status({ projectId: this.deps.projectId }),
        this.deps.service.getState({ projectId: this.deps.projectId }),
        this.deps.service.listDecisions({ projectId: this.deps.projectId }),
        this.deps.service.getLanguage({ projectId: this.deps.projectId }),
      ]);
      if (!this.current(generation, signal)) return;
      const snapshot: PlanningModalSnapshot = {
        status, state: stateResult.state ? structuredClone(stateResult.state) : null,
        revision: stateResult.revision ? Object.freeze({ ...stateResult.revision }) : null,
        evaluation: null, decisions: decisionsResult.decisions, language: languageResult.language,
      };
      this.snapshot = snapshot;
      this.loading = false;
      this.repaint();
      const open = stateResult.state ? getCurrentQuestion(stateResult.state, null) : null;
      if (open) void this.loadSuggestions(open, generation, signal);
      // A failed/held readiness reader cannot hide the saved question or block
      // the operator's explicit routes while semantic suggestions are pending.
      const evaluation = await this.deps.service.evaluate({ projectId: this.deps.projectId, ...(snapshot.state ? { state: snapshot.state } : {}) }).catch(() => null);
      if (!this.current(generation, signal)) return;
      this.snapshot = { ...snapshot, evaluation };
      if (!open && stateResult.state && evaluation?.nextQuestion) {
        void this.loadSuggestions(evaluation.nextQuestion, generation, signal);
      }
      this.repaint();
    } catch {
      if (!this.current(generation, signal)) return;
      this.snapshot = null;
      this.loading = false;
      this.repaint();
    }
  }

  private async loadSuggestions(question: ProjectPlanningQuestion, generation: number, signal: AbortSignal): Promise<void> {
    this.suggestions = 'loading';
    this.repaint();
    try {
      const reading = await (this.deps.readAnswerActions ?? readProjectPlanningAnswerActions)(question, { signal });
      if (!this.current(generation, signal)) return;
      this.reading = reading;
      this.suggestions = 'ready';
    } catch {
      if (!this.current(generation, signal)) return;
      this.reading = undefined;
      this.suggestions = 'unavailable';
    }
    this.repaint();
  }

  private rowId(action: PlanningAnswerAction): string { return `answer:${this.generation}:${action.id}`; }

  private currentAnswerActions(): { readonly question: ProjectPlanningQuestion | null; readonly actions: readonly PlanningAnswerAction[] } {
    if (!this.snapshot?.state) return { question: null, actions: [] };
    const question = getCurrentQuestion(this.snapshot.state, this.snapshot.evaluation);
    if (!question) return { question: null, actions: [] };
    return { question, actions: buildAnswerActions(question, '', this.reading) };
  }

  buildView(): ConfigModalView {
    if (!this.snapshot) {
      return { title: HISTORICAL_TITLE, tabs: [{ id: 'planning', label: 'History', header: [HISTORICAL_BOUNDARY], rows: [infoRow('load', this.loading ? 'Loading historical planning records...' : 'Historical planning records unavailable.', { fg: MODAL_TONES.dim })] }], hints: ['r refresh'] };
    }

    const { status, state, evaluation, decisions, language } = this.snapshot;
    const header = [
      `project ${this.deps.projectId}  space ${status?.knowledgeSpaceId ?? `project:${this.deps.projectId}`}`,
      HISTORICAL_BOUNDARY,
    ];
    const rows: ConfigModalRow[] = [];
    let n = 0;
    const line = (l: TextLine): void => { rows.push({ id: `p:${n++}`, label: l.content, selectable: false, ...(l.fg ? { style: { fg: l.fg } } : {}) }); };

    if (!state) {
      line({ content: 'No historical planning state has been saved for this workspace.' });
      line({ content: 'Start native work with /project-plan <goal>; /project-plan opens the native work ledger.', fg: undefined });
      return { title: HISTORICAL_TITLE, tabs: [{ id: 'planning', label: 'History', header, rows, emptyText: '' }], hints: ['r refresh'] };
    }

    for (const l of buildStateLines(state, evaluation)) line(l);

    const { question, actions } = this.currentAnswerActions();
    if (question) {
      line({ content: 'Answer Historical Question' });
      line({ content: question.prompt, fg: MODAL_TONES.info });
      if (question.whyItMatters) line({ content: `Why this matters: ${question.whyItMatters}` });
      if (this.reading?.recommendation && questionBinding(question) === questionBinding(this.reading.question)) line({ content: `Recommendation: ${this.reading.recommendation}`, fg: MODAL_TONES.good });
      if (this.suggestions === 'loading') line({ content: 'Reading answer suggestions…', fg: MODAL_TONES.dim });
      if (this.suggestions === 'unavailable') line({ content: 'Answer suggestions unavailable. You can still answer, approve this historical plan, or dismiss.', fg: MODAL_TONES.dim });
      for (const action of actions) {
        rows.push(action.id === 'custom'
          ? { id: this.rowId(action), label: 'Custom historical answer - Close history for /project-plan answer guidance.' }
          : { id: this.rowId(action), label: action.kind === 'approve'
            ? 'Approve historical plan - Record approval for this revision only; no native execution grant.'
            : `${action.label} - ${action.detail}`, ...(action.disabled ? { selectable: false } : {}) });
      }
      const savedQuestion = state.openQuestions.some((saved) => saved.id === question.id && (saved.status ?? 'open') === 'open');
      line({ content: savedQuestion
        ? 'Enter records saved-question answers or approval on this historical revision.'
        : 'Approval records this historical revision. Other suggestions enter native intake as derived input; they may be held and do not save a historical answer.' });
      line({ content: 'Custom shows /project-plan answer guidance. Plain text is a separate native request.' });
    }

    for (const l of buildGapsLines(evaluation)) line(l);
    for (const l of buildTasksLines(state)) line(l);
    for (const l of buildDecisionsLines(state, decisions)) line(l);
    for (const l of buildLanguageLines(language)) line(l);

    return {
      title: HISTORICAL_TITLE,
      tabs: [{ id: 'planning', label: 'History', header, rows }],
    };
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    if (id === 'refresh') { this.refresh(); ctx.setStatus('Reloading historical planning records…'); return; }
    if (id === 'approve') { void this.submit(ctx, true); return; }
    if (id === 'dismiss') {
      // First-class, confirmed (host two-press) mutating dismiss.
      void ctx.executeCommand?.('project-plan', ['dismiss']);
      ctx.setStatus('Dispatched /project-plan dismiss for historical planning.');
      ctx.close();
      return;
    }
    if (id !== 'submit') return;
    void this.submit(ctx);
  }

  private async submit(ctx: ConfigModalActionContext, approve = false): Promise<void> {
    if (this.submission?.generation === this.generation) return;
    // Admission is synchronous: two Enter events must not start parallel reads.
    const submission = { generation: this.generation };
    this.submission = submission;
    try {
      if (approve) await this.approveCurrent(ctx);
      else await this.submitCurrent(ctx);
    } catch {
      if (submission.generation === this.generation) ctx.setStatus('Could not submit the planning answer. Refresh before trying again.');
    } finally {
      // An older generation cannot unlock a newer submission after reopen.
      if (this.submission === submission) this.submission = null;
    }
  }

  private selectedTarget(ctx: ConfigModalActionContext): { readonly args: string[]; readonly state: ProjectPlanningState; readonly revision: ProjectPlanningRevision } | null {
    const { state, revision } = this.snapshot ?? {};
    if (!state || !revision) {
      ctx.setStatus('The selected planning revision is unavailable. Refresh before changing it.');
      return null;
    }
    return { args: selectedPlanningTarget(state.id, revision), state, revision };
  }

  private async approveCurrent(ctx: ConfigModalActionContext): Promise<void> {
    const selected = this.selectedTarget(ctx);
    if (!selected) return;
    if (!ctx.executeCommand) { ctx.setStatus('Planning commands are unavailable in this view.'); return; }
    const generation = this.generation;
    await ctx.executeCommand('project-plan', ['approve', ...selected.args]);
    if (generation === this.generation) ctx.setStatus('Dispatched historical revision approval; no native execution grant.');
  }

  private async submitCurrent(ctx: ConfigModalActionContext): Promise<void> {
    const { question, actions } = this.currentAnswerActions();
    if (!question || actions.length === 0) return;
    const action = ctx.row ? actions.find((a) => this.rowId(a) === ctx.row!.id) : undefined;
    if (action?.id === 'custom') {
      ctx.close();
      ctx.print(CUSTOM_ANSWER_GUIDANCE);
      return;
    }
    if (!action || action.disabled) { ctx.print('Choose an answer option.'); return; }
    const selected = this.selectedTarget(ctx);
    if (!selected) return;
    const generation = this.generation;
    const selectedState = selected.state;
    const stateId = selectedState.id;
    const updatedAt = selectedState.updatedAt;
    const binding = questionBinding(question);
    try {
      const latestResult = await this.deps.service.getState({ projectId: this.deps.projectId, planningId: stateId });
      const latest = latestResult.state;
      if (generation !== this.generation) return;
      if (!latest || latest.id !== stateId || latest.updatedAt !== updatedAt ||
          latestResult.revision?.sourceId !== selected.revision.sourceId || latestResult.revision.generation !== selected.revision.generation) {
        ctx.setStatus('Planning changed. Refresh and choose an answer again.');
        return;
      }
      const open = getCurrentQuestion(latest, null);
      const evaluation = open ? null : await this.deps.service.evaluate({ projectId: this.deps.projectId });
      if (generation !== this.generation) return;
      if (evaluation && (evaluation.state.id !== stateId || evaluation.state.updatedAt !== updatedAt)) {
        ctx.setStatus('Planning changed. Refresh and choose an answer again.');
        return;
      }
      // Evaluation can await arbitrary readers. Keep the captured source binding
      // through that gap, and again through the actual command/store write.
      if (evaluation) {
        const afterEvaluation = await this.deps.service.getState({ projectId: this.deps.projectId, planningId: stateId });
        if (generation !== this.generation) return;
        if (afterEvaluation.revision?.sourceId !== selected.revision.sourceId || afterEvaluation.revision.generation !== selected.revision.generation) {
          ctx.setStatus('Planning changed. Refresh and choose an answer again.');
          return;
        }
      }
      const current = open ?? evaluation?.nextQuestion;
      if (!current || questionBinding(current) !== binding) {
        ctx.setStatus('The planning question changed. Refresh and choose an answer again.');
        return;
      }
    } catch {
      if (generation === this.generation) ctx.setStatus('Could not confirm the current question. Refresh before submitting.');
      return;
    }
    if (action.kind === 'approve') {
      if (!ctx.executeCommand) { ctx.setStatus('Planning commands are unavailable in this view.'); return; }
      await ctx.executeCommand('project-plan', ['approve', ...selected.args]);
      if (generation === this.generation) ctx.setStatus('Dispatched historical revision approval; no native execution grant.');
      return;
    }

    const answerText = action.answer.trim();
    if (!answerText) { ctx.print('Choose a non-empty answer, or type an answer for the custom row.'); return; }

    // A canned answer to a REAL open question records structurally via /project-plan answer.
    const isOpenQuestion = this.snapshot?.state?.openQuestions.some(
      (q) => q.id === question.id && (q.status ?? 'open') === 'open',
    ) ?? false;
    if (action.id !== 'custom' && isOpenQuestion) {
      if (!ctx.executeCommand) { ctx.setStatus('Planning commands are unavailable in this view.'); return; }
      await ctx.executeCommand('project-plan', ['answer', ...selected.args, question.id, answerText]);
      if (generation !== this.generation) return;
      ctx.setStatus('Dispatched /project-plan answer for the historical question.');
      return;
    }

    // A synthetic readiness suggestion has no saved question to answer. Source-less
    // submitInput is derived input to native intake, which may hold it; this
    // does not write a historical answer or establish direct-owner provenance.
    // ORDERING GUARD: close the modal BEFORE handing off the suggestion.
    if (ctx.submitInput) {
      ctx.close();
      ctx.submitInput(answerText);
      return;
    }
    ctx.print('Submitting to chat is unavailable in this runtime; answer left unsent.');
  }
}

export function createPlanningModalSurface(deps: PlanningModalDeps): ConfigModalSurface {
  return new PlanningModalSurface(deps);
}
