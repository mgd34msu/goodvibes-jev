import type { AgentNoteRecord } from '../agent/note-registry.ts';
import { type AgentResearchRunRecord } from '../agent/research-run-registry.ts';
import type { WorkPlanItem } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { previewHarnessText } from './agent-harness-text.ts';
import { acquireLearningCuratorSource, type LearningRecord, type LearningCuratorSource, type LearningCandidateCollection, type LearningCuratorNativeContext } from './agent-harness-learning-curator-source.ts';
import { readLearningGrade, readLearningProposalTarget, readLearningMemoryClass } from './agent-harness-learning-curator-readings.ts';
import { captureCatalogData, captureCatalogMethods, captureCatalogSnapshotGuard, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { LearningCandidate, LearningCandidateDraft, LearningProposalTarget, SessionInfoLike, VibeCandidateKind, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
import { candidateBase, isReviewed, learningPromotionReference, recordedPromotionReferences, localRegistryModelRoute, localRegistryRoute, missingRequirementCount, routeValue } from './agent-harness-learning-curator-common.ts';
import { consolidationCandidatesForDomain } from './agent-harness-learning-curator-consolidation.ts';
function captureCandidate(): LearningCandidateDraft {
  return {
    id: 'capture:reviewed-lesson',
    label: 'Capture reviewed lesson',
    domain: 'capture',
    recordId: null,
    status: 'ready',
    reason: 'No urgent local-learning review candidates are present.',
    next: 'After a repeated workflow, useful preference, or durable lesson appears, capture it as a local memory, skill, routine, or persona for review.',
    inspectRoute: 'agent_harness mode:"workspace_action" actionId:"learned-behavior"',
    modelRoute: 'agent_harness mode:"workspace_actions" query:"learned behavior"',
    createRoute: 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior"',
  };
}

function stableVibeIdSuffix(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52) || 'vibe';
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0;
  }
  return `${slug}-${hash.toString(36)}`;
}

function vibeStatusRoute(): string {
  return 'vibe action:"status"';
}

function vibeCommandInspectRoute(): string {
  return 'vibe action:"status"';
}

function vibeCandidate(
  kind: VibeCandidateKind,
  path: string,
  scope: string,
  reason: string,
): LearningCandidateDraft {
  const isBlocked = kind === 'blocked';
  return {
    id: `vibe:${kind}:${stableVibeIdSuffix(path)}`,
    label: `${isBlocked ? 'Blocked' : 'Truncated'} ${scope} VIBE.md`,
    domain: 'vibe',
    recordId: path,
    status: isBlocked ? 'needs-setup' : 'needs-review',
    reason,
    next: isBlocked
      ? 'Inspect /vibe status, edit or remove blocked content, then rerun status before relying on personality instructions.'
      : 'Inspect /vibe status and shorten the file if omitted personality instructions matter for this user.',
    ...(isBlocked ? { missingRequirements: ['VIBE.md file is not loaded into the prompt until the blocked content is repaired.'] } : {}),
    proposalFields: {
      path,
      scope,
      kind,
      reason: previewHarnessText(reason, 220),
      statusRoute: vibeStatusRoute(),
    },
    inspectRoute: vibeStatusRoute(),
    modelRoute: 'memory action:"curator" query:"vibe"',
    reviewRoute: vibeCommandInspectRoute(),
    createRoute: 'vibe action:"init" scope:"project"',
  };
}

function vibeHealthCandidates(source: LearningCuratorSource): readonly LearningCandidateDraft[] {
  const health = source.source.vibe;
  if (!health) return [];
  return [
    ...health.blocked.map((file) => vibeCandidate('blocked', file.path, file.scope, file.reason)),
    ...health.files
      .filter((file) => file.truncated)
      .map((file) => vibeCandidate(
        'truncated',
        file.path,
        file.scope,
        'VIBE.md was loaded, but only the first safe prompt budget was applied.',
      )),
  ];
}

function proposalSubject(target: LearningProposalTarget): string {
  return target === 'memory' ? 'durable memory' : `reusable ${target} behavior`;
}

async function noteBehaviorProposalCandidate(record: LearningRecord, source: LearningCuratorSource): Promise<LearningCandidateDraft | null> {
  const { item } = record;
  if (!isReviewed(item)) return null;
  const target = await readLearningProposalTarget({ origin: 'note', ...record }, source.options);
  source.assertCurrent();
  if (!target) return null;
  const actionId = target === 'memory'
    ? 'notes-to-memory'
    : target === 'skill'
    ? 'notes-to-skill'
    : target === 'routine'
      ? 'notes-to-routine'
      : 'notes-to-persona';
  const note = record.record as AgentNoteRecord;
  if (typeof note.title !== 'string' || typeof note.body !== 'string' || !Array.isArray(note.tags))
    throw new ToolInputProjectionError('held');
  const proposalFields: NonNullable<LearningCandidateDraft['proposalFields']> = target === 'memory' ? {
    cls: await readLearningMemoryClass({ origin: 'note', ...record }, source.options),
    scope: 'project', summary: note.title, detail: note.body, tags: note.tags.join(','),
  } : {
    target, name: note.title, description: note.title,
    detail: note.body, body: note.body, notes: note.body, steps: note.body,
    triggers: '', tags: note.tags.join(','), enable: 'yes',
  };
  source.assertCurrent();
  const label = `${item.name} -> ${target}`;
  return {
    id: `note-proposal:${target}:${item.id}`,
    label,
    domain: 'note',
    recordId: item.id,
    status: 'proposal-ready',
    reason: `Reviewed note looks like ${proposalSubject(target)}.`,
    next: `Preview the selected-note ${target} promotion, then save it only if the user wants this durable context.`,
    reviewState: item.reviewState,
    proposalTarget: target,
    proposalFields,
    inspectRoute: localRegistryRoute('note', 'get', item.id),
    modelRoute: `agent_harness mode:"workspace_action" actionId:"${actionId}"`,
    createRoute: `agent_harness mode:"run_workspace_action" actionId:"${actionId}" recordId:"${item.id}"`,
  };
}

function completedWorkDetail(item: Omit<WorkPlanItem, 'createdAt' | 'updatedAt' | 'completedAt'>, notes: string): string {
  return [
    `Completed work: ${item.title}`,
    item.owner ? `Owner: ${item.owner}` : '',
    item.source ? `Source: ${item.source}` : '',
    '',
    notes,
  ].filter(Boolean).join('\n');
}

async function workPlanCompletionCandidate(item: Omit<WorkPlanItem, 'createdAt' | 'updatedAt' | 'completedAt'>, source: LearningCuratorSource): Promise<LearningCandidateDraft | null> {
  if (item.status !== 'done') return null;
  const target = await readLearningProposalTarget({ origin: 'work_plan', record: item }, source.options);
  source.assertCurrent();
  if (!target) return null;
  const notes = item.notes?.trim() || `Completed work item: ${item.title}`;
  const name = previewHarnessText(item.title, 80);
  const description = target === 'memory'
    ? `Durable memory learned from completed work: ${name}`
    : target === 'routine'
    ? `Repeatable workflow learned from completed work: ${name}`
    : target === 'persona'
      ? `Operating preference learned from completed work: ${name}`
      : `Reusable skill learned from completed work: ${name}`;
  const detail = completedWorkDetail(item, notes);
  return {
    id: `work-plan-proposal:${target}:${item.id}`,
    label: `${item.title} -> ${target}`,
    domain: 'work_plan',
    recordId: item.id,
    status: 'proposal-ready',
    reason: `Completed work item looks like ${proposalSubject(target)}.`,
    next: `Review the completed work notes, then capture this as Agent-local ${target} only if the user wants it reused.`,
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: await readLearningMemoryClass({ origin: 'work_plan', record: item }, source.options),
      scope: 'project',
      summary: previewHarnessText(item.title, 140),
      detail,
      tags: 'learned,completed-work,memory',
    } : {
      target,
      name,
      description: previewHarnessText(description, 140),
      notes: detail,
      triggers: target === 'routine' ? 'workflow, checklist' : target === 'persona' ? 'preference' : 'lesson, procedure',
      tags: `learned,completed-work,${target}`,
      enable: 'yes',
    },
    inspectRoute: `agent_work_plan action:"get" id:"${item.id}"`,
    modelRoute: 'agent_work_plan action:"get"',
    createRoute: target === 'memory'
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create"'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior"',
  };
}

function researchRunDetail(run: AgentResearchRunRecord): string {
  return [
    `Completed research run: ${run.title}`,
    `Question: ${run.question}`,
    `Goal: ${run.goal}`,
    run.reportArtifactId ? `Report artifact: ${run.reportArtifactId}` : '',
    run.sourceIds.length > 0 ? `Sources: ${run.sourceIds.join(', ')}` : '',
    '',
    run.note ? `Completion note: ${run.note}` : '',
    run.plan.length > 0 ? `Plan:\n${run.plan.map((step) => `- ${step}`).join('\n')}` : '',
    run.checkpoints.length > 0 ? `Recent checkpoints:\n${run.checkpoints.slice(-3).map((checkpoint) => `- ${checkpoint.note}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

async function researchRunCompletionCandidate(run: AgentResearchRunRecord, source: LearningCuratorSource): Promise<LearningCandidateDraft | null> {
  if (run.status !== 'completed') return null;
  const target = await readLearningProposalTarget({ origin: 'research_run', record: run }, source.options);
  source.assertCurrent();
  if (!target) return null;
  const name = previewHarnessText(run.title, 80);
  const detail = researchRunDetail(run);
  const description = target === 'memory'
    ? `Durable memory learned from completed research: ${name}`
    : target === 'routine'
      ? `Repeatable research workflow learned from completed run: ${name}`
      : target === 'persona'
        ? `Operating preference learned from completed research: ${name}`
        : `Reusable research skill learned from completed run: ${name}`;
  return {
    id: `research-run-proposal:${target}:${run.id}`,
    label: `${run.title} -> ${target}`,
    domain: 'research_run',
    recordId: run.id,
    status: 'proposal-ready',
    reason: `Completed research run looks like ${proposalSubject(target)}.`,
    next: `Review the run ledger and report artifact, then capture this as Agent-local ${target} only if it should guide future work.`,
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: await readLearningMemoryClass({ origin: 'research_run', record: run }, source.options),
      scope: 'project',
      summary: previewHarnessText(run.note || run.title, 140),
      detail,
      tags: 'learned,research-run,memory',
    } : {
      target,
      name,
      description: previewHarnessText(description, 140),
      notes: detail,
      triggers: target === 'routine' ? 'research, report, workflow' : target === 'persona' ? 'research preference' : 'research, sources, report',
      tags: `learned,research-run,${target}`,
      enable: 'yes',
    },
    inspectRoute: `agent_harness mode:"research_run" runId:"${run.id}"`,
    modelRoute: 'agent_harness mode:"research_run"',
    createRoute: target === 'memory'
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create"'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior"',
  };
}

function extractMessageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (typeof message !== 'object' || message === null) return '';
  const content: unknown = 'content' in message ? message.content : undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null) return '';
      return 'text' in part && typeof part.text === 'string' ? part.text : '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function sessionDetail(session: Omit<SessionInfoLike, 'timestamp'>, loadedText: string): string {
  return [
    `Saved session: ${session.title || session.name}`,
    `Session id: ${session.name}`,
    session.model ? `Model: ${session.model}` : '',
    session.provider ? `Provider: ${session.provider}` : '',
    session.messageCount ? `Messages: ${session.messageCount}` : '',
    '',
    loadedText ? `Relevant transcript:\n${previewHarnessText(loadedText, 1200)}` : 'Transcript unavailable from the session manager; inspect the session before capturing durable context.',
  ].filter(Boolean).join('\n');
}

async function sessionCompletionCandidate(record: LearningCuratorSource['source']['sessions'][number], source: LearningCuratorSource): Promise<LearningCandidateDraft | null> {
  const { session, loaded } = record;
  if (!session.name) return null;
  const loadedText = [loaded?.meta.title ?? '', ...(loaded?.messages ?? []).map(extractMessageText)].filter(Boolean).join('\n');
  const target = await readLearningProposalTarget({ origin: 'session', record }, source.options);
  source.assertCurrent();
  if (!target) return null;
  const labelBase = session.title || session.name;
  const detail = sessionDetail(session, loadedText);
  const description = target === 'memory'
    ? `Durable memory learned from saved session: ${previewHarnessText(labelBase, 80)}`
    : target === 'routine'
      ? `Repeatable workflow learned from saved session: ${previewHarnessText(labelBase, 80)}`
      : target === 'persona'
        ? `Operating preference learned from saved session: ${previewHarnessText(labelBase, 80)}`
        : `Reusable skill learned from saved session: ${previewHarnessText(labelBase, 80)}`;
  return {
    id: `session-proposal:${target}:${session.name}`,
    label: `${labelBase} -> ${target}`,
    domain: 'session',
    recordId: session.name,
    status: 'proposal-ready',
    reason: `Saved session looks like ${proposalSubject(target)}.`,
    next: `Inspect the saved session transcript, then capture this as Agent-local ${target} only if it should guide future work.`,
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: await readLearningMemoryClass({ origin: 'session', record }, source.options),
      scope: 'project',
      summary: previewHarnessText(loadedText || labelBase, 140),
      detail,
      tags: 'learned,saved-session,memory',
    } : {
      target,
      name: previewHarnessText(labelBase, 80),
      description: previewHarnessText(description, 140),
      notes: detail,
      triggers: target === 'routine' ? 'session, workflow' : target === 'persona' ? 'session preference' : 'session, lesson',
      tags: `learned,saved-session,${target}`,
      enable: 'yes',
    },
    inspectRoute: `sessions action:"get" sessionId:"${session.name}"`,
    modelRoute: 'sessions action:"get"',
    createRoute: target === 'memory'
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create"'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior"',
  };
}

function notePromotionCandidate(record: LearningRecord): LearningCandidateDraft | null {
  const { item } = record;
  const original = record.record;
  if (!isReviewed(item) || !original || typeof original !== 'object' || !('sourceUrl' in original) || typeof original.sourceUrl !== 'string' || !original.sourceUrl) return null;
  return {
    id: `note-promote:${item.id}`,
    label: item.name,
    domain: 'note',
    recordId: item.id,
    status: 'ready-to-promote',
    reason: 'Reviewed note appears to have a source URL that may belong in isolated Agent Knowledge.',
    next: 'Promote only if the source is durable, useful later, and the user wants it in Agent Knowledge.',
    reviewState: item.reviewState,
    inspectRoute: localRegistryRoute('note', 'get', item.id),
    modelRoute: localRegistryModelRoute('note'),
    createRoute: 'agent_harness mode:"workspace_action" actionId:"notes-to-knowledge"',
  };
}

async function candidatesForItem(domain: LocalLearningCandidateDomain, record: LearningRecord, source: LearningCuratorSource): Promise<LearningCandidateDraft[]> {
  const { item } = record;
  const candidates: LearningCandidateDraft[] = [];
  const missing = missingRequirementCount(item);
  if (missing > 0 && (domain === 'skill' || domain === 'skill_bundle' || domain === 'routine')) {
    candidates.push(candidateBase(
      domain,
      item,
      'needs-setup',
      `${missing} setup requirement(s) are missing.`,
      'Resolve setup requirements before enabling, scheduling, or relying on this behavior.',
    ));
  }
  if (item.confidence !== undefined && item.confidence < 70) {
    candidates.push(candidateBase(
      domain,
      item,
      'low-confidence',
      `Confidence is ${item.confidence}%, below the durable-memory threshold.`,
      'Review, update confidence, or mark stale before using this memory as prompt context.',
    ));
  }
  if (!isReviewed(item)) {
    const enabledOrActive = item.enabled === true || item.active === true;
    candidates.push(candidateBase(
      domain,
      item,
      'needs-review',
      item.reviewState === 'stale'
        ? 'Record is stale and should not silently guide the assistant.'
        : enabledOrActive
          ? 'Record can influence the assistant but is not reviewed.'
          : 'Record is fresh and waiting for review.',
      'Inspect provenance and content, then review it, revise it, or mark it stale.',
    ));
  }
  if (domain === 'note') {
    const behaviorProposal = await noteBehaviorProposalCandidate(record, source);
    source.assertCurrent();
    if (behaviorProposal) candidates.push(behaviorProposal);
    const promotion = notePromotionCandidate(record);
    if (promotion) candidates.push(promotion);
  }
  return candidates;
}

export function candidateSearchText(candidate: LearningCandidate): string {
  return [
    candidate.id,
    candidate.label,
    candidate.domain,
    candidate.recordId ?? '',
    candidate.status,
    candidate.reason,
    candidate.next,
    candidate.reviewState ?? '',
    candidate.missingRequirements?.join('\n') ?? '',
    candidate.proposalTarget ?? '',
    Object.values(candidate.proposalFields ?? {}).join('\n'),
    candidate.consolidation ? JSON.stringify(candidate.consolidation) : '',
    candidate.inspectRoute,
    candidate.modelRoute,
  ].join('\n').toLowerCase();
}

const collections = new WeakMap<LearningCandidateCollection, { readonly context: LearningCuratorNativeContext; readonly options: CatalogRankingOptions; readonly assertFields: () => void; readonly assertCandidates: (current: unknown) => void; readonly assertPromptRecords: (current: unknown) => void }>();

/** Only a collection issued for this exact native caller can authorize its effects. */
export function assertLearningCandidateCollection(collection: LearningCandidateCollection, context: LearningCuratorNativeContext, options: CatalogRankingOptions): void {
  const issued = collections.get(collection);
  if (!issued || issued.context !== context || issued.options !== options) throw new ToolInputProjectionError('held');
  issued.assertFields(); issued.assertCandidates(collection.candidates); issued.assertPromptRecords(collection.promptRecords);
  collection.assertCurrent();
  issued.assertFields(); issued.assertCandidates(collection.candidates); issued.assertPromptRecords(collection.promptRecords);
}

export async function buildLearningCandidates(context: LearningCuratorNativeContext, options: CatalogRankingOptions = {}): Promise<LearningCandidateCollection> {
  const source = acquireLearningCuratorSource(context, options);
  const drafts: { readonly candidate: LearningCandidateDraft; readonly record: unknown }[] = [];
  const promptRecords: LearningCandidateCollection['promptRecords'][number][] = [];
  for (const [domain, records] of Object.entries(source.libraries)) {
    // Iterate the domain's closed set below rather than accepting text as a domain.
    if (domain !== 'memory' && domain !== 'note' && domain !== 'persona' && domain !== 'skill' && domain !== 'skill_bundle' && domain !== 'routine') continue;
    for (const record of records) {
      const local = await candidatesForItem(domain, record, source); source.assertCurrent();
      for (const candidate of local) drafts.push({ candidate, record });
      const eligible = domain === 'memory' ? (record.item.confidence ?? 100) >= 70
        : domain === 'persona' ? record.item.active === true
        : domain !== 'note' && record.item.enabled === true && missingRequirementCount(record.item) === 0;
      if (eligible) {
        const grade = await readLearningGrade({ proposedUse: 'priority of existing eligible prompt context', domain, capturedAt: source.source.capturedAt, ...record }, source.options);
        source.assertCurrent(); promptRecords.push({ domain, item: record.item, priority: grade.priority, scores: grade.scores });
      }
    }
    const consolidation = await consolidationCandidatesForDomain(domain, records, source.options, source.source); source.assertCurrent();
    for (const candidate of consolidation) drafts.push({ candidate, record: records });
  }
  for (const item of source.source.workItems) {
    const candidate = await workPlanCompletionCandidate(item, source); source.assertCurrent();
    if (candidate) drafts.push({ candidate, record: item });
  }
  for (const run of source.source.researchSnapshot?.completed ?? []) {
    const candidate = await researchRunCompletionCandidate(run, source); source.assertCurrent();
    if (candidate) drafts.push({ candidate, record: run });
  }
  for (const session of source.source.sessions) {
    const candidate = await sessionCompletionCandidate(session, source); source.assertCurrent();
    if (candidate) drafts.push({ candidate, record: session });
  }
  for (const candidate of vibeHealthCandidates(source)) drafts.push({ candidate, record: { health: source.source.vibe, files: source.source.vibeEvidence } });
  if (drafts.length === 0) drafts.push({ candidate: captureCandidate(), record: { source: source.source, noUrgentCandidates: true } });
  const promotedReferences = new Set(Object.values(source.libraries).flatMap(records => records.flatMap(record => recordedPromotionReferences(record.record))));
  const candidates: LearningCandidate[] = [];
  for (const { candidate, record } of drafts) {
    if (candidate.proposalTarget && promotedReferences.has(learningPromotionReference(candidate.id))) continue;
    const grade = await readLearningGrade({ capturedAt: source.source.capturedAt, proposedUse: candidate.status, candidate, record }, source.options); source.assertCurrent();
    candidates.push({ ...candidate, scores: grade.scores, priority: grade.priority,
      ...(candidate.proposalTarget === 'memory' && candidate.proposalFields ? { proposalFields: { ...candidate.proposalFields, confidence: String(grade.confidence) } } : {}),
    });
  }
  source.assertCurrent();
  const assertCandidateCurrent = (candidate: LearningCandidate) => {
    assertLearningCandidateCollection(collection, context, options);
    if (!collection.candidates.includes(candidate)) throw new ToolInputProjectionError('held');
    const domain = candidate.domain;
    if (domain === 'memory' || domain === 'note' || domain === 'persona' || domain === 'skill' || domain === 'skill_bundle' || domain === 'routine') {
      const ids = candidate.consolidation ? [candidate.consolidation.survivorId, ...candidate.consolidation.duplicateIds]
        : candidate.recordId ? [candidate.recordId] : [];
      source.assertOriginalRecords(domain, ids);
    }
    assertLearningCandidateCollection(collection, context, options);
  };
  const collection: LearningCandidateCollection = Object.freeze({ candidates: captureCatalogData(candidates.sort((left, right) => right.priority - left.priority || left.label.localeCompare(right.label))),
    promptRecords: captureCatalogData(promptRecords.sort((left, right) => right.priority - left.priority || left.item.name.localeCompare(right.item.name))),
    assertCurrent: source.assertCurrent, assertCandidateCurrent, prepareTransition: source.prepareTransition, options: source.options });
  collections.set(collection, { context, options,
    assertFields: captureCatalogMethods(collection, ['candidates', 'promptRecords', 'assertCurrent', 'assertCandidateCurrent', 'prepareTransition', 'options']),
    assertCandidates: captureCatalogSnapshotGuard(collection.candidates), assertPromptRecords: captureCatalogSnapshotGuard(collection.promptRecords) });
  return collection;
}
