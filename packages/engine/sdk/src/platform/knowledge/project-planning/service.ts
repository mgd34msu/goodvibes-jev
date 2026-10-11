import { JudgmentAuthorityRetiredError, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { captureOwnedJson, JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { SQLiteObservationRetiredError } from '../../state/sqlite-store.js';
import { randomUUID } from 'node:crypto';
import { knowledgeSpaceMetadata, normalizeProjectId } from '../spaces.js';
import type { KnowledgeSourceRecord, KnowledgeSourceUpsertInput } from '../types.js';
import { KnowledgeSourcePublicationHeldError, type KnowledgeSourceSnapshot } from '../store-source-generation.js';
import { KnowledgeStore } from '../store.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import {
  emitWorkPlanSnapshotInvalidated,
  emitWorkPlanTaskCreated,
  emitWorkPlanTaskDeleted,
  emitWorkPlanTaskStatusChanged,
  emitWorkPlanTaskUpdated,
} from '../../runtime/emitters/index.js';
import {
  PROJECT_PLANNING_CONNECTOR_ID,
  PROJECT_PLANNING_TAG,
  type ProjectPlanningArtifactKind,
  projectPlanningArtifactSummary,
  projectPlanningCanonicalUri,
  projectPlanningSourceId,
  readPlanningMetadataObject,
  resolveProjectPlanningSpace,
  stablePlanningId,
  withStoredContractId,
} from './helpers.js';
import { composeReadiness, planningSemanticFacts, readPlanningSemanticFacts, type PreparedPlanningReadiness } from './readiness.js';
import type {
  ProjectPlanningAnswerInput,
  ProjectPlanningAnswerResult,
  ProjectPlanningDecision,
  ProjectPlanningDecisionRecordInput,
  ProjectPlanningDecisionResult,
  ProjectPlanningDecisionsResult,
  ProjectPlanningEvaluateInput,
  ProjectPlanningEvaluation,
  ProjectPlanningQuestion,
  ProjectPlanningLanguageArtifact,
  ProjectPlanningLanguageResult,
  ProjectPlanningLanguageUpsertInput,
  ProjectPlanningSpaceInput,
  ProjectPlanningState,
  ProjectPlanningStateResult,
  ProjectPlanningStateActionInput,
  ProjectPlanningStateActionResult,
  ProjectPlanningRevision,
  ProjectPlanningStateUpsertInput,
  ProjectPlanningStatus,
  ProjectPlanningTask,
  ProjectWorkPlanArtifact,
  ProjectWorkPlanClearCompletedInput,
  ProjectWorkPlanCounts,
  ProjectWorkPlanMutationResult,
  ProjectWorkPlanSnapshot,
  ProjectWorkPlanTask,
  ProjectWorkPlanTaskCreateInput,
  ProjectWorkPlanTaskDeleteInput,
  ProjectWorkPlanTaskGetInput,
  ProjectWorkPlanTaskListInput,
  ProjectWorkPlanTaskMutationSource,
  ProjectWorkPlanTaskReorderInput,
  ProjectWorkPlanTaskResult,
  ProjectWorkPlanTaskStatus,
  ProjectWorkPlanTaskStatusInput,
  ProjectWorkPlanTaskUpdateInput,
} from './types.js';

type MutableProjectWorkPlanCounts = {
  -readonly [K in keyof ProjectWorkPlanCounts]: ProjectWorkPlanCounts[K];
};

type WorkPlanTaskCandidate = {
  readonly [K in keyof ProjectWorkPlanTask]?: ProjectWorkPlanTask[K] | undefined;
} & {
  readonly title?: string | undefined;
};

export interface ProjectPlanningServiceOptions {
  readonly defaultProjectId?: string | undefined;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
}

export class ProjectPlanningService {
  private readonly defaultProjectId: string;
  private runtimeBus: RuntimeEventBus | null;
  private runtimeBusEpoch = 0;
  private readonly readinessOwners = new WeakMap<ProjectPlanningEvaluation, () => void>();

  constructor(
    private readonly store: KnowledgeStore,
    options: ProjectPlanningServiceOptions = {},
  ) {
    const defaultProjectId = snapshotJudgmentInput(options.defaultProjectId) as string | undefined;
    this.defaultProjectId = normalizeProjectId(defaultProjectId ?? 'default');
    this.runtimeBus = options.runtimeBus ?? null;
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null | undefined): void {
    this.runtimeBusEpoch += 1;
    this.runtimeBus = runtimeBus ?? null;
  }

  async status(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningStatus> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const sources = this.sourcesForSpace(space.knowledgeSpaceId);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      passiveOnly: true,
      counts: {
        states: sources.filter((source) => artifactKind(source) === 'state').length,
        decisions: sources.filter((source) => artifactKind(source) === 'decision').length,
        languageArtifacts: sources.filter((source) => artifactKind(source) === 'language').length,
        workPlans: sources.filter((source) => artifactKind(source) === 'work-plan').length,
        workPlanTasks: sources
          .filter((source) => artifactKind(source) === 'work-plan')
          .reduce((count, source) => count + (readWorkPlan(source)?.tasks.length ?? 0), 0),
      },
      capabilities: [
        'project-scoped-storage',
        'planning-state-validation',
        'project-language-artifacts',
        'decision-records',
        'durable-work-plan-tasks',
        'work-plan-transition-events',
        'agent-task-graph-metadata',
        'passive-daemon-only',
      ],
    };
  }

  async getState(input: ProjectPlanningSpaceInput & { readonly planningId?: string | undefined } = {}): Promise<ProjectPlanningStateResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const planningId = normalizePlanningId(input.planningId);
    const snapshot = this.getArtifactSnapshot(space.knowledgeSpaceId, 'state', planningId);
    const source = snapshot.source;
    const state = source ? readState(source) : null;
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      state,
      ...(source ? { source, revision: this.planningRevision(snapshot)! } : {}),
    };
  }

  /** Explicit operator action, bound to one captured source generation. */
  async applyStateAction(input: ProjectPlanningStateActionInput, options: JudgmentReadingOptions = {}): Promise<ProjectPlanningStateActionResult> {
    // Capture before the first await. Later caller mutations cannot change the
    // selected source, expected generation, or requested operator action.
    options = { signal: options.signal, assertCurrent: options.assertCurrent };
    const captured = snapshotJudgmentInput(input) as ProjectPlanningStateActionInput;
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    if (captured.expected?.kind !== 'current' && captured.expected?.kind !== 'revision') throw new TypeError('Invalid planning state expectation');
    if (captured.expected.kind === 'revision') {
      const revision = captured.expected.revision;
      if (!revision || typeof revision.sourceId !== 'string' || !revision.sourceId || typeof revision.generation !== 'string' || !/^[a-f0-9]{64}$/.test(revision.generation)) {
        throw new TypeError('Invalid planning revision');
      }
      Object.freeze(revision);
    }
    Object.freeze(captured.expected);
    if (captured.action?.kind !== 'approve' && captured.action?.kind !== 'answer' && captured.action?.kind !== 'dismiss') throw new TypeError('Invalid planning state action');
    if (captured.action.kind === 'answer' && typeof captured.action.answer !== 'string') throw new TypeError('Invalid planning answer');
    Object.freeze(captured.action);
    await this.store.init();
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const space = this.resolveSpace(captured);
    const observation = this.store.captureSourcePublication();
    const snapshot = this.getArtifactSnapshot(space.knowledgeSpaceId, 'state', normalizePlanningId(captured.planningId));
    const current = snapshot.source ? readState(snapshot.source) : null;
    const revision = this.planningRevision(snapshot);
    const hold = (reason: Extract<ProjectPlanningStateActionResult, { applied: false }>['reason']): ProjectPlanningStateActionResult => ({
      ok: true, applied: false, reason, state: current, ...(revision ? { revision } : {}),
    });
    if (!current || !snapshot.source || !revision) return hold('no-state');
    if (captured.expected.kind === 'revision' && (captured.expected.revision.sourceId !== revision.sourceId || captured.expected.revision.generation !== revision.generation)) return hold('state-changed');
    // Current-mode captures once here, then uses the same compare-and-write as
    // view-selected actions. It never silently retargets a later state.
    let question: ProjectPlanningQuestion | undefined;
    let changed: ProjectPlanningState;
    if (captured.action.kind === 'approve') {
      changed = { ...current, executionApproved: true,
        metadata: { ...(current.metadata ?? {}), approvedFrom: 'plan-command', approvedAt: Date.now() },
      };
    } else if (captured.action.kind === 'dismiss') {
      changed = { ...current, metadata: { ...(current.metadata ?? {}), active: false,
        dismissedAt: new Date(Date.now()).toISOString(), dismissedFrom: 'plan-command' } };
    } else {
      const answer = captured.action.answer.trim();
      if (!answer) return hold('empty-answer');
      const { questionId, questionIndex } = captured.action;
      if (questionId === undefined && questionIndex === undefined) return hold('missing-selector');
      const index = questionId !== undefined
        ? current.openQuestions.findIndex((entry) => entry.id === questionId)
        : Number.isInteger(questionIndex) && questionIndex! >= 0 && questionIndex! < current.openQuestions.length ? questionIndex! : -1;
      if (index < 0) return hold('question-not-found');
      question = { ...current.openQuestions[index]!, status: 'answered', answer, answeredAt: Date.now() };
      changed = { ...current,
        openQuestions: current.openQuestions.filter((_, at) => at !== index),
        answeredQuestions: [...current.answeredQuestions.filter((entry) => entry.id !== question!.id), question],
      };
    }
    let published = false;
    try {
      const committed = await this.publishPlanningReadiness(space, normalizeState(changed, space.projectId, space.knowledgeSpaceId), snapshot, options, observation);
      published = true;
      committed.assertCurrent();
      this.readinessOwners.set(committed.evaluation, committed.assertCurrent);
      return { ok: true, applied: true, state: committed.evaluation.state,
        revision: Object.freeze({ sourceId: committed.source.id, generation: committed.generation }),
        evaluation: committed.evaluation, ...(question ? { question } : {}) };
    } catch (error) {
      if (published) throw new Error('Planning state was published, but its response observation retired.', { cause: error });
      options.signal?.throwIfAborted();
      if (!(error instanceof SQLiteObservationRetiredError) && !(error instanceof KnowledgeSourcePublicationHeldError) && !(error instanceof JudgmentAuthorityRetiredError)) throw error;
      const latest = this.getArtifactSnapshot(space.knowledgeSpaceId, 'state', current.id);
      const latestRevision = this.planningRevision(latest);
      return { ok: true, applied: false, reason: error instanceof KnowledgeSourcePublicationHeldError ? error.reason : 'state-changed', state: latest.source ? readState(latest.source) : null,
        ...(latestRevision ? { revision: latestRevision } : {}) };
    }
  }

  private planningRevision(snapshot: KnowledgeSourceSnapshot): ProjectPlanningRevision | undefined {
    return snapshot.source && snapshot.generation
      ? Object.freeze({ sourceId: snapshot.source.id, generation: snapshot.generation }) : undefined;
  }

  private getArtifactSnapshot(spaceId: string, kind: ProjectPlanningArtifactKind, id: string): KnowledgeSourceSnapshot {
    const direct = this.store.getSourceSnapshot({ id: projectPlanningSourceId(spaceId, kind, id) });
    const snapshot = direct.source ? direct : this.store.getSourceSnapshot({ canonicalUri: projectPlanningCanonicalUri(spaceId, kind, id) });
    admitPlanningSource(snapshot);
    return snapshot;
  }

  async upsertState(input: ProjectPlanningStateUpsertInput, options: JudgmentReadingOptions = {}): Promise<ProjectPlanningStateResult> {
    options = { signal: options.signal, assertCurrent: options.assertCurrent };
    const captured = snapshotJudgmentInput(input) as ProjectPlanningStateUpsertInput;
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    await this.store.init();
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const space = this.resolveSpace(captured);
    const state = normalizeState(captured.state, space.projectId, space.knowledgeSpaceId);
    const observation = this.store.captureSourcePublication();
    const previous = this.getArtifactSnapshot(space.knowledgeSpaceId, 'state', state.id);
    const committed = await this.publishPlanningReadiness(space, state, previous, options, observation);
    committed.assertCurrent();
    return { ok: true, projectId: space.projectId, knowledgeSpaceId: space.knowledgeSpaceId,
      state: committed.evaluation.state, source: committed.source };
  }

  async evaluate(input: ProjectPlanningEvaluateInput = {}, options: JudgmentReadingOptions = {}): Promise<ProjectPlanningEvaluation> {
    const captured = snapshotJudgmentInput(input) as ProjectPlanningEvaluateInput;
    const signal = options.signal, callerCurrent = options.assertCurrent;
    const check = () => { signal?.throwIfAborted(); callerCurrent?.(); };
    check(); await this.store.init(); check();
    const space = this.resolveSpace(captured);
    const observed = this.store.captureSourcePublication();
    const current = () => { check(); observed(); };
    let state: ProjectPlanningState;
    if (captured.state) state = normalizeState(captured.state, space.projectId, space.knowledgeSpaceId);
    else {
      const snapshot = this.getArtifactSnapshot(space.knowledgeSpaceId, 'state', normalizePlanningId(captured.planningId));
      state = snapshot.source ? readState(snapshot.source) ?? normalizeState({}, space.projectId, space.knowledgeSpaceId)
        : normalizeState({}, space.projectId, space.knowledgeSpaceId);
    }
    const reading = await prepareOwnedPlanningReadiness(state, { signal, assertCurrent: current });
    reading.assertCurrent();
    return reading.evaluation;
  }

  /** Record a current-mode answer using the same persisted guard as selected actions.
   * Validation and conflict holds return answered:false; storage failures still
   * reject. State and derived work-plan changes share one publication boundary.
   */
  async answerQuestion(input: ProjectPlanningAnswerInput, options: JudgmentReadingOptions = {}): Promise<ProjectPlanningAnswerResult> {
    options = { signal: options.signal, assertCurrent: options.assertCurrent };
    input = snapshotJudgmentInput(input) as ProjectPlanningAnswerInput;
    // Capture identity before awaiting; the action captures its own structured input.
    const space = this.resolveSpace(input);
    const result = await this.applyStateAction({
      projectId: input.projectId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      planningId: input.planningId,
      expected: { kind: 'current' },
      action: { kind: 'answer', questionId: input.questionId, questionIndex: input.questionIndex, answer: input.answer },
    }, options);
    const state = result.state;
    const observed = result.applied ? this.readinessOwners.get(result.evaluation)! : this.store.captureSourcePublication();
    const capturedSignal = options.signal, capturedCheck = options.assertCurrent;
    const current = result.applied ? observed
      : () => { capturedSignal?.throwIfAborted(); capturedCheck?.(); observed(); };
    if (!result.applied) {
      const source = this.getArtifactSnapshot(space.knowledgeSpaceId, 'state', normalizePlanningId(input.planningId));
      if (source.generation !== (result.revision?.generation ?? null)) throw new SQLiteObservationRetiredError();
    }
    const evaluation = result.applied ? result.evaluation
      : (await prepareOwnedPlanningReadiness(state ?? normalizeState({}, space.projectId, space.knowledgeSpaceId), { signal: capturedSignal, assertCurrent: current })).evaluation;
    current();
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      answered: result.applied,
      ...(result.applied ? { question: result.question } : { reason: result.reason }),
      openQuestions: state?.openQuestions ?? [],
      state,
      evaluation,
    };
  }

  async listDecisions(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningDecisionsResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const decisions = this.sourcesForSpace(space.knowledgeSpaceId)
      .filter((source) => artifactKind(source) === 'decision')
      .map(readDecision)
      .filter((decision): decision is ProjectPlanningDecision => decision !== null)
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      decisions,
    };
  }

  async recordDecision(input: ProjectPlanningDecisionRecordInput): Promise<ProjectPlanningDecisionResult> {
    input = snapshotJudgmentInput(input) as ProjectPlanningDecisionRecordInput;
    await this.store.init();
    const space = this.resolveSpace(input);
    const now = Date.now();
    const decision: ProjectPlanningDecision = {
      id: input.decision.id ?? stablePlanningId('decision', input.decision.title),
      title: input.decision.title.trim(),
      ...(input.decision.context ? { context: input.decision.context } : {}),
      decision: input.decision.decision.trim(),
      ...(input.decision.alternatives ? { alternatives: [...input.decision.alternatives] } : {}),
      ...(input.decision.reasoning ? { reasoning: input.decision.reasoning } : {}),
      ...(input.decision.consequences ? { consequences: [...input.decision.consequences] } : {}),
      status: input.decision.status ?? 'accepted',
      createdAt: input.decision.createdAt ?? now,
      updatedAt: now,
      ...(input.decision.metadata ? { metadata: { ...input.decision.metadata } } : {}),
    };
    const source = await this.upsertArtifactSource(space, 'decision', decision.id, decision);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      decision,
      source,
    };
  }

  async getLanguage(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningLanguageResult> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const source = this.getArtifactSource(space.knowledgeSpaceId, 'language', 'current');
    const language = source ? readLanguage(source) : null;
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      language,
      ...(source ? { source } : {}),
    };
  }

  async upsertLanguage(input: ProjectPlanningLanguageUpsertInput): Promise<ProjectPlanningLanguageResult> {
    input = snapshotJudgmentInput(input) as ProjectPlanningLanguageUpsertInput;
    await this.store.init();
    const space = this.resolveSpace(input);
    const now = Date.now();
    const existing = await this.getLanguage(space);
    const language: ProjectPlanningLanguageArtifact = {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      terms: input.language.terms ? [...input.language.terms] : existing.language?.terms ?? [],
      ambiguities: input.language.ambiguities ? [...input.language.ambiguities] : existing.language?.ambiguities ?? [],
      ...(input.language.examples ? { examples: [...input.language.examples] } : existing.language?.examples ? { examples: existing.language.examples } : {}),
      updatedAt: now,
      metadata: {
        ...(existing.language?.metadata ?? {}),
        ...(input.language.metadata ?? {}),
      },
    };
    const source = await this.upsertArtifactSource(space, 'language', 'current', language);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      language,
      source,
    };
  }

  async getWorkPlanSnapshot(input: ProjectWorkPlanTaskListInput = {}): Promise<ProjectWorkPlanSnapshot> {
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlan = this.getWorkPlanArtifact(space, normalizeWorkPlanId(input.workPlanId));
    return snapshotFromWorkPlan(space, workPlan, {
      status: input.status,
      parentTaskId: input.parentTaskId,
      contractId: input.contractId,
      owner: input.owner,
      limit: input.limit,
    });
  }

  async getWorkPlanTask(input: ProjectWorkPlanTaskGetInput): Promise<ProjectWorkPlanTaskResult> {
    await this.store.init();
    const snapshot = await this.getWorkPlanSnapshot(input);
    return {
      ok: true,
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task: snapshot.tasks.find((task) => task.taskId === input.taskId) ?? null,
      snapshot,
    };
  }

  async createWorkPlanTask(input: ProjectWorkPlanTaskCreateInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskCreateInput;
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const now = Date.now();
    const task = normalizeWorkPlanTask(input.task, {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      now,
      fallbackOrder: nextWorkPlanOrder(existing.tasks),
    });
    if (existing.tasks.some((entry) => entry.taskId === task.taskId)) {
      throw new Error(`Work plan task already exists: ${task.taskId}`);
    }
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks: sortWorkPlanTasks([...existing.tasks, task]),
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    this.emitWorkPlanTaskCreated(snapshot, task);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      workPlanId,
      task,
      snapshot,
    };
  }

  async updateWorkPlanTask(input: ProjectWorkPlanTaskUpdateInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskUpdateInput;
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const previousTask = existing.tasks.find((task) => task.taskId === input.taskId);
    if (!previousTask) throw new Error(`Work plan task not found: ${input.taskId}`);
    const now = Date.now();
    const task = normalizeWorkPlanTask({
      ...previousTask,
      ...input.patch,
      metadata: {
        ...(previousTask.metadata ?? {}),
        ...(input.patch.metadata ?? {}),
      },
      taskId: previousTask.taskId,
      createdAt: previousTask.createdAt,
      updatedAt: now,
    }, {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      now,
      fallbackOrder: previousTask.order,
    });
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks: sortWorkPlanTasks(existing.tasks.map((entry) => entry.taskId === input.taskId ? task : entry)),
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    this.emitWorkPlanTaskUpdated(snapshot, task, previousTask);
    if (previousTask.status !== task.status) {
      this.emitWorkPlanTaskStatusChanged(snapshot, task, previousTask);
    }
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      workPlanId,
      task,
      previousTask,
      snapshot,
    };
  }

  async setWorkPlanTaskStatus(input: ProjectWorkPlanTaskStatusInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskStatusInput;
    return this.updateWorkPlanTask({
      projectId: input.projectId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      workPlanId: input.workPlanId,
      taskId: input.taskId,
      patch: {
        status: normalizeWorkPlanStatus(input.status),
        ...(input.source ? { source: input.source } : {}),
        metadata: {
          ...(input.reason ? { statusReason: input.reason } : {}),
        },
      },
    });
  }

  async reorderWorkPlanTasks(input: ProjectWorkPlanTaskReorderInput): Promise<ProjectWorkPlanSnapshot> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskReorderInput;
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const previousById = new Map(existing.tasks.map((task) => [task.taskId, task]));
    const orderById = new Map(input.orderedTaskIds.map((taskId, index) => [taskId, index]));
    for (const taskId of orderById.keys()) {
      if (!previousById.has(taskId)) throw new Error(`Work plan task not found: ${taskId}`);
    }
    const now = Date.now();
    const tasks = sortWorkPlanTasks(existing.tasks.map((task) => ({
      ...task,
      order: orderById.get(task.taskId) ?? task.order + input.orderedTaskIds.length,
      updatedAt: orderById.has(task.taskId) ? now : task.updatedAt,
    })));
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks,
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    for (const task of tasks) {
      const previousTask = previousById.get(task.taskId);
      if (previousTask && previousTask.order !== task.order) {
        this.emitWorkPlanTaskUpdated(snapshot, task, previousTask, true);
      }
    }
    this.emitWorkPlanSnapshotInvalidated(snapshot, 'reordered');
    return snapshot;
  }

  async deleteWorkPlanTask(input: ProjectWorkPlanTaskDeleteInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskDeleteInput;
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const deletedTask = existing.tasks.find((task) => task.taskId === input.taskId);
    if (!deletedTask) throw new Error(`Work plan task not found: ${input.taskId}`);
    const now = Date.now();
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks: existing.tasks.filter((task) => task.taskId !== input.taskId),
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    this.emitWorkPlanTaskDeleted(snapshot, deletedTask);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      workPlanId,
      deletedTask,
      snapshot,
    };
  }

  async clearCompletedWorkPlanTasks(input: ProjectWorkPlanClearCompletedInput = {}): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanClearCompletedInput;
    await this.store.init();
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const existing = this.getWorkPlanArtifact(space, workPlanId);
    const statuses = new Set(input.statuses?.length ? input.statuses.map(normalizeWorkPlanStatus) : ['done']);
    const cleared = existing.tasks.filter((task) => statuses.has(task.status));
    const now = Date.now();
    const workPlan = await this.saveWorkPlanArtifact(space, {
      ...existing,
      tasks: existing.tasks.filter((task) => !statuses.has(task.status)),
      updatedAt: now,
    });
    const snapshot = snapshotFromWorkPlan(space, workPlan);
    for (const task of cleared) {
      this.emitWorkPlanTaskDeleted(snapshot, task, true);
    }
    this.emitWorkPlanSnapshotInvalidated(snapshot, 'cleared-completed');
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      workPlanId,
      clearedTaskIds: cleared.map((task) => task.taskId),
      snapshot,
    };
  }

  private resolveSpace(input: ProjectPlanningSpaceInput = {}) {
    snapshotJudgmentInput({ input, defaultProjectId: this.defaultProjectId });
    return resolveProjectPlanningSpace(input, this.defaultProjectId);
  }

  private sourcesForSpace(spaceId: string): readonly KnowledgeSourceRecord[] {
    return this.store.listSources(Number.MAX_SAFE_INTEGER).filter((source) => {
      const metadata = source.metadata ?? {};
      return metadata.projectPlanning === true && metadata.knowledgeSpaceId === spaceId;
    }).map(source => {
      const snapshot = this.store.getSourceSnapshot({ id: source.id });
      admitPlanningSource(snapshot);
      return snapshot.source!;
    });
  }

  private getArtifactSource(
    spaceId: string,
    kind: ProjectPlanningArtifactKind,
    id: string,
  ): KnowledgeSourceRecord | null {
    return this.getArtifactSnapshot(spaceId, kind, id).source;
  }

  private getWorkPlanArtifact(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    workPlanId: string,
  ): ProjectWorkPlanArtifact {
    const source = this.getArtifactSource(space.knowledgeSpaceId, 'work-plan', workPlanId);
    const value = source ? readWorkPlan(source) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return normalizeWorkPlanArtifact(value as Partial<ProjectWorkPlanArtifact>, space, workPlanId);
    }
    const now = Date.now();
    return {
      id: workPlanId,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      tasks: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async saveWorkPlanArtifact(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    workPlan: ProjectWorkPlanArtifact,
  ): Promise<ProjectWorkPlanArtifact> {
    const normalized = normalizeWorkPlanArtifact(workPlan, space, workPlan.id);
    await this.upsertArtifactSource(space, 'work-plan', normalized.id, normalized);
    return normalized;
  }

  /** One readiness observation owns the original state and work-plan until publication. */
  private async publishPlanningReadiness(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    state: ProjectPlanningState,
    previous: KnowledgeSourceSnapshot,
    options: JudgmentReadingOptions,
    initialObservation: () => void,
  ) {
    const signal = options.signal, callerCurrent = options.assertCurrent;
    const busEpoch = this.runtimeBusEpoch;
    let observation = initialObservation;
    const current = () => {
      signal?.throwIfAborted(); callerCurrent?.(); observation();
      if (this.runtimeBusEpoch !== busEpoch) throw new JudgmentAuthorityRetiredError();
    };
    const workSnapshot = this.getArtifactSnapshot(space.knowledgeSpaceId, 'work-plan', 'current');
    // Inspect complete persisted sources before selecting state fields or acquiring a port.
    admitPlanningSource(previous);
    admitPlanningSource(workSnapshot);
    const reading = await prepareOwnedPlanningReadiness(state, { signal, assertCurrent: current });
    reading.assertCurrent();
    const normalized = reading.evaluation.state;
    const now = Date.now();
    let workPlan = workSnapshot.source && readWorkPlan(workSnapshot.source)
      ? normalizeWorkPlanArtifact(readWorkPlan(workSnapshot.source)!, space, 'current')
      : normalizeWorkPlanArtifact({ id: 'current', tasks: [] }, space, 'current');
    const events: { task: ProjectWorkPlanTask; previous?: ProjectWorkPlanTask; snapshot: ProjectWorkPlanSnapshot }[] = [];
    for (const [index, task] of normalized.tasks.entries()) {
      if (!task.title?.trim()) continue;
      const taskId = normalizeWorkPlanTaskId(`planning-${normalized.id}-${task.id || task.title}`);
      const workPlanTask = {
        taskId,
        title: task.title,
        notes: task.why,
        owner: task.recommendedAgent,
        status: workPlanStatusFromPlanningTask(task),
        priority: task.needsReview ? 10 : 0,
        order: index,
        source: 'planning',
        tags: [
          'planning',
          ...(task.needsReview ? ['needs-review'] : []),
          ...(task.blockedOnUserInput ? ['blocked-on-user-input'] : []),
        ],
        originSurface: 'daemon',
        metadata: {
          planningId: normalized.id,
          planningTaskId: task.id,
          dependencies: task.dependencies ?? [],
          likelyFiles: task.likelyFiles ?? [],
          verification: task.verification ?? [],
          canRunConcurrently: task.canRunConcurrently === true,
        },
      };
      const prior = workPlan.tasks.find(entry => entry.taskId === taskId);
      const updated = normalizeWorkPlanTask({ ...prior, ...workPlanTask,
        metadata: { ...(prior?.metadata ?? {}), ...workPlanTask.metadata },
        createdAt: prior?.createdAt ?? now, updatedAt: now,
      }, { ...space, now, fallbackOrder: index });
      workPlan = { ...workPlan, tasks: sortWorkPlanTasks(prior
        ? workPlan.tasks.map(entry => entry.taskId === taskId ? updated : entry)
        : [...workPlan.tasks, updated]), updatedAt: now };
      events.push({ task: updated, ...(prior ? { previous: prior } : {}), snapshot: snapshotFromWorkPlan(space, workPlan) });
    }
    const stateInput = this.artifactSourceInput(space, 'state', normalized.id, normalized);
    const writes = [{ input: { ...stateInput, id: previous.source?.id ?? stateInput.id! }, generation: previous.generation }];
    if (events.length) {
      const workInput = this.artifactSourceInput(space, 'work-plan', workPlan.id, workPlan);
      writes.push({ input: { ...workInput, id: workSnapshot.source?.id ?? workInput.id! }, generation: workSnapshot.generation });
    }
    let durable = false;
    try {
      const written = await this.store.upsertOwnedCanonicalSources(writes, reading.assertCurrent, (_sources, successor) => { observation = successor; durable = true; });
      reading.assertCurrent();
      for (const event of events) {
        reading.assertCurrent();
        if (event.previous) {
          this.emitWorkPlanTaskUpdated(event.snapshot, event.task, event.previous, false, reading.assertCurrent);
          reading.assertCurrent();
          if (event.previous.status !== event.task.status) this.emitWorkPlanTaskStatusChanged(event.snapshot, event.task, event.previous);
        } else this.emitWorkPlanTaskCreated(event.snapshot, event.task, reading.assertCurrent);
      }
      reading.assertCurrent();
      const publicationCurrent = () => {
        try { reading.assertCurrent(); }
        catch (error) { throw new Error('Planning state was published, but its response observation retired.', { cause: error }); }
      };
      return { evaluation: reading.evaluation, source: written[0]!.source!, generation: written[0]!.generation!, assertCurrent: publicationCurrent };
    } catch (error) {
      // An effect already committed must never be reported as a no-write hold.
      if (durable) throw new Error('Planning state was published, but its readiness observation retired before response publication.', { cause: error });
      throw error;
    }
  }

  private async upsertArtifactSource(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    kind: ProjectPlanningArtifactKind,
    id: string,
    value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact | ProjectWorkPlanArtifact,
  ): Promise<KnowledgeSourceRecord> {
    return this.store.upsertCanonicalSource(this.artifactSourceInput(space, kind, id, value));
  }

  private artifactSourceInput(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    kind: ProjectPlanningArtifactKind,
    id: string,
    value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact | ProjectWorkPlanArtifact,
  ): KnowledgeSourceUpsertInput {
    const spaceId = space.knowledgeSpaceId;
    return {
      id: projectPlanningSourceId(spaceId, kind, id),
      connectorId: PROJECT_PLANNING_CONNECTOR_ID,
      sourceType: 'dataset',
      title: titleForArtifact(kind, value),
      canonicalUri: projectPlanningCanonicalUri(spaceId, kind, id),
      summary: projectPlanningArtifactSummary(kind, value),
      tags: [PROJECT_PLANNING_TAG, `project-planning:${kind}`],
      status: 'indexed',
      metadata: knowledgeSpaceMetadata(spaceId, {
        projectPlanning: true,
        planningArtifactKind: kind,
        planningArtifactId: id,
        projectId: space.projectId,
        value: snapshotJudgmentInput(planningClockRepresentation(value, kind, 'encode')),
      }),
    };
  }

  private emitWorkPlanTaskCreated(snapshot: ProjectWorkPlanSnapshot, task: ProjectWorkPlanTask, assertCurrent?: () => void): void {
    assertCurrent?.();
    if (!this.runtimeBus) return;
    emitWorkPlanTaskCreated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task,
    });
    assertCurrent?.();
    this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-created');
  }

  private emitWorkPlanTaskUpdated(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    previousTask: ProjectWorkPlanTask,
    skipSnapshotInvalidation = false,
    assertCurrent?: () => void,
  ): void {
    assertCurrent?.();
    if (!this.runtimeBus) return;
    emitWorkPlanTaskUpdated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task,
      previousTask,
    });
    assertCurrent?.();
    if (!skipSnapshotInvalidation) this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-updated');
  }

  private emitWorkPlanTaskStatusChanged(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    previousTask: ProjectWorkPlanTask,
  ): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskStatusChanged(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      taskId: task.taskId,
      status: task.status,
      previousStatus: previousTask.status,
      task,
    });
  }

  private emitWorkPlanTaskDeleted(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    skipSnapshotInvalidation = false,
  ): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskDeleted(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      taskId: task.taskId,
      task,
    });
    if (!skipSnapshotInvalidation) this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-deleted');
  }

  private emitWorkPlanSnapshotInvalidated(snapshot: ProjectWorkPlanSnapshot, reason: string): void {
    if (!this.runtimeBus) return;
    emitWorkPlanSnapshotInvalidated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      reason,
      snapshot,
    });
  }
}

function normalizeState(
  input: Partial<ProjectPlanningState> & { readonly goal?: string },
  projectId: string,
  knowledgeSpaceId: string,
): ProjectPlanningState {
  const now = Date.now();
  const id = normalizePlanningId(input.id);
  return {
    id,
    projectId,
    knowledgeSpaceId,
    goal: typeof input.goal === 'string' ? input.goal : '',
    ...(typeof input.scope === 'string' ? { scope: input.scope } : {}),
    knownContext: arrayOfObjectsOrStrings(input.knownContext),
    openQuestions: arrayOfObjects(input.openQuestions),
    answeredQuestions: arrayOfObjects(input.answeredQuestions),
    decisions: arrayOfObjects(input.decisions),
    assumptions: arrayOfObjectsOrStrings(input.assumptions),
    constraints: arrayOfObjectsOrStrings(input.constraints),
    risks: arrayOfObjectsOrStrings(input.risks),
    tasks: arrayOfObjects(input.tasks),
    dependencies: arrayOfObjects(input.dependencies),
    verificationGates: arrayOfObjects(input.verificationGates),
    agentAssignments: arrayOfObjects(input.agentAssignments),
    readiness: input.readiness ?? 'not-ready',
    executionApproved: input.executionApproved === true,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now,
    updatedAt: now,
    metadata: readPlanningMetadataObject(input.metadata),
  } as ProjectPlanningState;
}

function normalizeWorkPlanArtifact(
  input: Partial<ProjectWorkPlanArtifact>,
  space: { readonly projectId: string; readonly knowledgeSpaceId: string },
  workPlanId: string,
): ProjectWorkPlanArtifact {
  const now = Date.now();
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : now;
  const tasks = Array.isArray(input.tasks)
    ? input.tasks.map((task, index) => normalizeWorkPlanTask(withStoredContractId(task), {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      now,
      fallbackOrder: index,
    }))
    : [];
  return {
    id: normalizeWorkPlanId(input.id ?? workPlanId),
    projectId: space.projectId,
    knowledgeSpaceId: space.knowledgeSpaceId,
    tasks: sortWorkPlanTasks(tasks),
    createdAt,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
    ...(input.metadata ? { metadata: readPlanningMetadataObject(input.metadata) } : {}),
  };
}

function normalizeWorkPlanTask(
  input: WorkPlanTaskCandidate,
  options: {
    readonly projectId: string;
    readonly knowledgeSpaceId: string;
    readonly now: number;
    readonly fallbackOrder: number;
  },
): ProjectWorkPlanTask {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new Error('Work plan task title is required.');
  const status = normalizeWorkPlanStatus(input.status ?? 'pending');
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : options.now;
  return {
    taskId: normalizeWorkPlanTaskId(input.taskId ?? `task-${randomUUID().slice(0, 12)}`),
    projectId: options.projectId,
    knowledgeSpaceId: options.knowledgeSpaceId,
    title,
    ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
    ...(typeof input.owner === 'string' && input.owner.trim() ? { owner: input.owner.trim() } : {}),
    status,
    ...(typeof input.priority === 'number' && Number.isFinite(input.priority) ? { priority: input.priority } : {}),
    order: typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : options.fallbackOrder,
    ...(typeof input.source === 'string' && input.source.trim() ? { source: input.source.trim() } : {}),
    tags: stringList(input.tags),
    ...(typeof input.parentTaskId === 'string' && input.parentTaskId.trim() ? { parentTaskId: normalizeWorkPlanTaskId(input.parentTaskId) } : {}),
    ...(typeof input.contractId === 'string' && input.contractId.trim() ? { contractId: input.contractId.trim() } : {}),
    ...(typeof input.phaseId === 'string' && input.phaseId.trim() ? { phaseId: input.phaseId.trim() } : {}),
    ...(typeof input.agentId === 'string' && input.agentId.trim() ? { agentId: input.agentId.trim() } : {}),
    ...(typeof input.turnId === 'string' && input.turnId.trim() ? { turnId: input.turnId.trim() } : {}),
    ...(typeof input.decisionId === 'string' && input.decisionId.trim() ? { decisionId: input.decisionId.trim() } : {}),
    ...(typeof input.sourceMessageId === 'string' && input.sourceMessageId.trim() ? { sourceMessageId: input.sourceMessageId.trim() } : {}),
    linkedArtifactIds: stringList(input.linkedArtifactIds),
    linkedSourceIds: stringList(input.linkedSourceIds),
    linkedNodeIds: stringList(input.linkedNodeIds),
    ...(typeof input.originSurface === 'string' && input.originSurface.trim() ? { originSurface: input.originSurface.trim() } : {}),
    createdAt,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : options.now,
    ...(status === 'done' || status === 'failed' || status === 'cancelled'
      ? { completedAt: typeof input.completedAt === 'number' ? input.completedAt : options.now }
      : {}),
    ...(input.metadata ? { metadata: readPlanningMetadataObject(input.metadata) } : {}),
  };
}

function normalizeWorkPlanId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('work-plan', value)
    : 'current';
}

function normalizeWorkPlanTaskId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('task', value)
    : `task-${randomUUID().slice(0, 12)}`;
}

function normalizeWorkPlanStatus(value: unknown): ProjectWorkPlanTaskStatus {
  if (
    value === 'pending'
    || value === 'in_progress'
    || value === 'blocked'
    || value === 'done'
    || value === 'failed'
    || value === 'cancelled'
  ) {
    return value;
  }
  if (value === 'in-progress') return 'in_progress';
  if (value === 'completed') return 'done';
  throw new Error(`Invalid work plan task status: ${String(value)}`);
}

function workPlanStatusFromPlanningTask(task: ProjectPlanningTask): ProjectWorkPlanTaskStatus {
  if (task.status === 'in-progress') return 'in_progress';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'completed') return 'done';
  if (task.blockedOnUserInput === true) return 'blocked';
  return 'pending';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))];
}

function nextWorkPlanOrder(tasks: readonly ProjectWorkPlanTask[]): number {
  return tasks.reduce((max, task) => Math.max(max, task.order), -1) + 1;
}

function sortWorkPlanTasks(tasks: readonly ProjectWorkPlanTask[]): ProjectWorkPlanTask[] {
  return [...tasks].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
}

function snapshotFromWorkPlan(
  space: { readonly projectId: string; readonly knowledgeSpaceId: string },
  workPlan: ProjectWorkPlanArtifact,
  filter: {
    readonly status?: ProjectWorkPlanTaskStatus | undefined;
    readonly parentTaskId?: string | undefined;
    readonly contractId?: string | undefined;
    readonly owner?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): ProjectWorkPlanSnapshot {
  const tasks = sortWorkPlanTasks(workPlan.tasks).filter((task) => {
    if (filter.status && task.status !== filter.status) return false;
    if (filter.parentTaskId && task.parentTaskId !== filter.parentTaskId) return false;
    if (filter.contractId && task.contractId !== filter.contractId) return false;
    if (filter.owner && task.owner !== filter.owner) return false;
    return true;
  });
  const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
    ? Math.floor(filter.limit)
    : undefined;
  return {
    ok: true,
    projectId: space.projectId,
    knowledgeSpaceId: space.knowledgeSpaceId,
    workPlanId: workPlan.id,
    tasks: limit ? tasks.slice(0, limit) : tasks,
    counts: countWorkPlanTasks(workPlan.tasks),
    updatedAt: workPlan.updatedAt,
  };
}

function countWorkPlanTasks(tasks: readonly ProjectWorkPlanTask[]): ProjectWorkPlanCounts {
  const counts: MutableProjectWorkPlanCounts = {
    total: tasks.length,
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

function workPlanEmitterContext(snapshot: ProjectWorkPlanSnapshot): {
  readonly traceId: string;
  readonly sessionId: string;
  readonly source: string;
} {
  return {
    traceId: `project-planning:work-plan:${snapshot.workPlanId}:${snapshot.updatedAt}`,
    sessionId: `project:${snapshot.projectId}`,
    source: 'project-planning.work-plan',
  };
}

function normalizePlanningId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('plan', value)
    : 'current';
}

function arrayOfObjects<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is T => !!entry && typeof entry === 'object' && !Array.isArray(entry));
}

function arrayOfObjectsOrStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object' && 'text' in entry && typeof entry.text === 'string') return [entry.text];
    return [];
  });
}

function artifactKind(source: KnowledgeSourceRecord): ProjectPlanningArtifactKind | null {
  const kind = source.metadata.planningArtifactKind;
  return kind === 'state' || kind === 'decision' || kind === 'language' || kind === 'work-plan' ? kind : null;
}

function readState(source: KnowledgeSourceRecord): ProjectPlanningState | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? planningClockRepresentation(value, 'state', 'decode') as ProjectPlanningState : null;
}

function readDecision(source: KnowledgeSourceRecord): ProjectPlanningDecision | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? planningClockRepresentation(value, 'decision', 'decode') as ProjectPlanningDecision : null;
}

function readLanguage(source: KnowledgeSourceRecord): ProjectPlanningLanguageArtifact | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? planningClockRepresentation(value, 'language', 'decode') as ProjectPlanningLanguageArtifact : null;
}

function readWorkPlan(source: KnowledgeSourceRecord): ProjectWorkPlanArtifact | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? planningClockRepresentation(value, 'work-plan', 'decode') as ProjectWorkPlanArtifact : null;
}

function titleForArtifact(
  kind: ProjectPlanningArtifactKind,
  value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact | ProjectWorkPlanArtifact,
): string {
  if (kind === 'state') return `Planning: ${(value as ProjectPlanningState).goal || 'Current plan'}`;
  if (kind === 'decision') return `Decision: ${(value as ProjectPlanningDecision).title}`;
  if (kind === 'work-plan') return 'Project Work Plan';
  return 'Project Language';
}


/** The complete persisted original is admitted before reading its numeric view. */
function admitPlanningSource(snapshot: KnowledgeSourceSnapshot): void {
  if (!snapshot.source) return;
  if (!snapshot.raw) throw new JudgmentInputError('unsupported-input');
  snapshotJudgmentInput(snapshot.raw);
  snapshotJudgmentInput(snapshot.source.metadata);
  snapshotJudgmentInput(snapshot.source.tags);
  for (const key of ['created_at', 'updated_at'] as const) {
    const value = snapshot.raw[key];
    const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp) > 8.64e15
      || (typeof value === 'string' && new Date(timestamp).toISOString() !== value)) throw new JudgmentInputError('unsupported-input');
  }
}

/** Module-private: inputs originate only in raw-admitted calls or admitted stored
 * originals. The canonical candidate is itself fully admitted before deriving the
 * numeric compatibility view. No caller or row-shaped object can select this flow. */
async function prepareOwnedPlanningReadiness(input: ProjectPlanningState, options: JudgmentReadingOptions): Promise<PreparedPlanningReadiness> {
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const check = () => { signal?.throwIfAborted(); callerCurrent?.(); };
  check();
  const canonical = snapshotJudgmentInput(planningClockRepresentation(input, 'state', 'encode'));
  const state = planningClockRepresentation(canonical, 'state', 'decode') as ProjectPlanningState;
  if (!state.goal.trim()) return { evaluation: composeReadiness(state, 'unavailable'), assertCurrent: check };
  const reading = await readPlanningSemanticFacts(planningSemanticFacts(state), { signal, assertCurrent: check });
  reading.assertCurrent();
  return { evaluation: composeReadiness(state, reading.semantic), assertCurrent: reading.assertCurrent };
}

/** A representation codec, never an admission shortcut. Encoding is reachable
 * only after original caller/storage admission; decoding follows canonical
 * original admission. Unknown fields and named array properties are preserved. */
function planningClockRepresentation(value: unknown, kind: ProjectPlanningArtifactKind, direction: 'encode' | 'decode'): unknown {
  const captured = captureOwnedJson(value);
  const root = captured as Record<string, unknown>;
  const metadata = root?.metadata as Record<string, unknown> | undefined;
  function clockPath(path: readonly string[]): boolean {
    if (path.length === 1 && ['createdAt', 'updatedAt'].includes(path[0]!)) return true;
    if (kind === 'state' && path.length === 3 && /^(0|[1-9][0-9]*)$/.test(path[1]!)) {
      if (['openQuestions', 'answeredQuestions'].includes(path[0]!) && path[2] === 'answeredAt') return true;
      if (path[0] === 'decisions' && ['createdAt', 'updatedAt'].includes(path[2]!)) return true;
    }
    if (kind === 'state' && path.join('.') === 'metadata.approvedAt'
      && root.executionApproved === true && metadata?.approvedFrom === 'plan-command') return true;
    return kind === 'work-plan' && path.length === 3 && path[0] === 'tasks'
      && /^(0|[1-9][0-9]*)$/.test(path[1]!) && ['createdAt', 'updatedAt', 'completedAt'].includes(path[2]!);
  }
  function visit(entry: unknown, path: readonly string[]): unknown {
    if (clockPath(path)) {
      if (direction === 'encode' && typeof entry === 'number') {
        if (!Number.isSafeInteger(entry) || Math.abs(entry) > 8.64e15) throw new JudgmentInputError('unsupported-input');
        return new Date(entry).toISOString();
      }
      if (direction === 'decode' && typeof entry === 'string') {
        const timestamp = Date.parse(entry);
        if (Number.isFinite(timestamp) && new Date(timestamp).toISOString() === entry) return timestamp;
      }
    }
    if (!entry || typeof entry !== 'object') return entry;
    const result: object = Array.isArray(entry) ? new Array(entry.length) : Object.create(null) as object;
    for (const [key, item] of Object.entries(entry)) {
      Object.defineProperty(result, key, { value: visit(item, [...path, key]), enumerable: true });
    }
    return Object.freeze(result);
  }
  return visit(captured, []);
}
