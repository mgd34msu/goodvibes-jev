import type { CommandContext } from '../input/command-registry.ts';
import { AgentResearchRunRegistry, type AgentResearchRunRecord } from '../agent/research-run-registry.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import type { WorkPlanItem } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { previewHarnessText } from './agent-harness-text.ts';
import { agentHarnessVibeHealth } from './agent-harness-vibe-health.ts';
import type { LearningCandidate, LearningProposalTarget, SessionInfoLike, SessionManagerLike, VibeCandidateKind, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
import { candidateBase, clampScore, isReviewed, itemFreshness, itemSourceQuality, itemUsefulness, localRegistryModelRoute, localRegistryRoute, missingRequirementCount, routeValue } from './agent-harness-learning-curator-common.ts';
import { consolidationCandidatesForDomain } from './agent-harness-learning-curator-consolidation.ts';
function captureCandidate(): LearningCandidate {
  return {
    id: 'capture:reviewed-lesson',
    label: 'Capture reviewed lesson',
    domain: 'capture',
    recordId: null,
    status: 'ready',
    priority: 30,
    reason: 'No urgent local-learning review candidates are present.',
    next: 'After a repeated workflow, useful preference, or durable lesson appears, capture it as a local memory, skill, routine, or persona for review.',
    scores: { usefulness: 55, freshness: 85, sourceQuality: 60, risk: 10 },
    inspectRoute: 'agent_harness mode:"workspace_action" actionId:"learned-behavior"',
    modelRoute: 'agent_harness mode:"workspace_actions" query:"learned behavior"',
    createRoute: 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior" confirm:true explicitUserRequest:"..."',
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
): LearningCandidate {
  const isBlocked = kind === 'blocked';
  return {
    id: `vibe:${kind}:${stableVibeIdSuffix(path)}`,
    label: `${isBlocked ? 'Blocked' : 'Truncated'} ${scope} VIBE.md`,
    domain: 'vibe',
    recordId: path,
    status: isBlocked ? 'needs-setup' : 'needs-review',
    priority: isBlocked ? 88 : 72,
    reason,
    next: isBlocked
      ? 'Inspect /vibe status, edit or remove blocked content, then rerun status before relying on personality instructions.'
      : 'Inspect /vibe status and shorten the file if omitted personality instructions matter for this user.',
    scores: {
      usefulness: 75,
      freshness: isBlocked ? 45 : 58,
      sourceQuality: scope === 'project' ? 76 : 70,
      risk: isBlocked ? 86 : 58,
    },
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
    createRoute: 'vibe action:"init" scope:"project" confirm:true explicitUserRequest:"Create or refresh the project VIBE.md starter."',
  };
}

function vibeHealthCandidates(context: CommandContext): readonly LearningCandidate[] {
  const health = agentHarnessVibeHealth(context);
  return [
    ...health.blockedFiles.map((file) => vibeCandidate('blocked', file.path, file.scope, file.reason)),
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

function noteProposalTarget(item: AgentWorkspaceLocalLibraryItem): LearningProposalTarget | null {
  const tags = item.tags.map((tag) => tag.toLowerCase());
  const text = [item.name, item.description, ...tags].join('\n').toLowerCase();
  if (tags.some((tag) => ['memory', 'fact', 'decision', 'constraint', 'risk', 'pattern', 'incident', 'architecture', 'ownership'].includes(tag))) return 'memory';
  if (tags.some((tag) => ['routine', 'workflow', 'runbook', 'process'].includes(tag))) return 'routine';
  if (tags.some((tag) => ['persona', 'style', 'preference', 'tone'].includes(tag))) return 'persona';
  if (tags.some((tag) => ['skill', 'procedure', 'lesson', 'learned', 'howto'].includes(tag))) return 'skill';
  if (/\b(memory|remember|fact|decision|constraint|risk|incident|pattern|architecture|ownership)\b/.test(text)) return 'memory';
  if (/\b(repeat|routine|workflow|every time|checklist|runbook)\b/.test(text)) return 'routine';
  if (/\b(style|tone|preference|respond|answer)\b/.test(text)) return 'persona';
  if (/\b(lesson|procedure|steps|how to|when asked)\b/.test(text)) return 'skill';
  return null;
}

function proposalSubject(target: LearningProposalTarget): string {
  return target === 'memory' ? 'durable memory' : `reusable ${target} behavior`;
}

function noteBehaviorProposalCandidate(item: AgentWorkspaceLocalLibraryItem): LearningCandidate | null {
  if (!isReviewed(item)) return null;
  const target = noteProposalTarget(item);
  if (!target) return null;
  const actionId = target === 'memory'
    ? 'notes-to-memory'
    : target === 'skill'
    ? 'notes-to-skill'
    : target === 'routine'
      ? 'notes-to-routine'
      : 'notes-to-persona';
  const label = `${item.name} -> ${target}`;
  return {
    id: `note-proposal:${target}:${item.id}`,
    label,
    domain: 'note',
    recordId: item.id,
    status: 'proposal-ready',
    priority: target === 'routine' ? 64 : target === 'memory' ? 62 : 60,
    reason: `Reviewed note looks like ${proposalSubject(target)}.`,
    next: `Preview the selected-note ${target} promotion, then save it only if the user wants this durable context.`,
    scores: {
      usefulness: clampScore(itemUsefulness(item) + 8),
      freshness: itemFreshness(item),
      sourceQuality: itemSourceQuality(item),
      risk: 24,
    },
    reviewState: item.reviewState,
    proposalTarget: target,
    inspectRoute: localRegistryRoute('note', 'get', item.id),
    modelRoute: `agent_harness mode:"workspace_action" actionId:"${actionId}"`,
    createRoute: `agent_harness mode:"run_workspace_action" actionId:"${actionId}" recordId:"${item.id}" confirm:true explicitUserRequest:"..."`,
  };
}

function workPlanProposalTarget(item: WorkPlanItem): LearningProposalTarget | null {
  const text = [item.title, item.notes ?? '', item.source ?? '', item.owner ?? ''].join('\n').toLowerCase();
  if (/\b(memory|remember|fact|decision|constraint|risk|incident|pattern|architecture|ownership)\b/.test(text)) return 'memory';
  if (/\b(style|tone|preference|respond|answer|voice|persona)\b/.test(text)) return 'persona';
  if (/\b(repeat|routine|workflow|every time|checklist|runbook|process|before release|after release)\b/.test(text)) return 'routine';
  if (/\b(lesson|procedure|steps|how to|when asked|debug|fix|review|test|release|deploy|triage)\b/.test(text)) return 'skill';
  return null;
}

function inferMemoryClass(text: string): string {
  const normalized = text.toLowerCase();
  if (/\bdecision|decided|choose|selected\b/.test(normalized)) return 'decision';
  if (/\bconstraint|must|never|always|required\b/.test(normalized)) return 'constraint';
  if (/\brisk|hazard|regression\b/.test(normalized)) return 'risk';
  if (/\bincident|outage|failure\b/.test(normalized)) return 'incident';
  if (/\bpattern|repeat|recurring\b/.test(normalized)) return 'pattern';
  if (/\barchitecture|design|system\b/.test(normalized)) return 'architecture';
  if (/\bowner|ownership|responsible\b/.test(normalized)) return 'ownership';
  if (/\brunbook|checklist\b/.test(normalized)) return 'runbook';
  return 'fact';
}

function completedWorkFreshness(item: WorkPlanItem): number {
  if (!item.completedAt) return 70;
  const ageDays = Math.max(0, (Date.now() - item.completedAt) / (24 * 60 * 60 * 1000));
  return clampScore(96 - Math.min(45, ageDays * 3));
}

function completedIsoFreshness(iso: string | undefined): number {
  if (!iso) return 70;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 70;
  const ageDays = Math.max(0, (Date.now() - parsed) / (24 * 60 * 60 * 1000));
  return clampScore(96 - Math.min(45, ageDays * 3));
}

function completedTimestampFreshness(timestamp: number | undefined): number {
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= 0) return 70;
  const ageDays = Math.max(0, (Date.now() - timestamp) / (24 * 60 * 60 * 1000));
  return clampScore(96 - Math.min(45, ageDays * 3));
}

function completedWorkDetail(item: WorkPlanItem, notes: string): string {
  return [
    `Completed work: ${item.title}`,
    item.owner ? `Owner: ${item.owner}` : '',
    item.source ? `Source: ${item.source}` : '',
    '',
    notes,
  ].filter(Boolean).join('\n');
}

function workPlanCompletionCandidate(item: WorkPlanItem): LearningCandidate | null {
  if (item.status !== 'done') return null;
  const target = workPlanProposalTarget(item);
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
    priority: target === 'routine' ? 62 : target === 'memory' ? 60 : 58,
    reason: `Completed work item looks like ${proposalSubject(target)}.`,
    next: `Review the completed work notes, then capture this as Agent-local ${target} only if the user wants it reused.`,
    scores: {
      usefulness: clampScore(62 + Math.min(18, notes.length / 12)),
      freshness: completedWorkFreshness(item),
      sourceQuality: item.source ? 72 : 64,
      risk: 28,
    },
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: inferMemoryClass(`${item.title}\n${notes}`),
      scope: 'project',
      summary: previewHarnessText(item.title, 140),
      detail,
      tags: 'learned,completed-work,memory',
      confidence: '80',
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
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create" confirm:true explicitUserRequest:"..."'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior" confirm:true explicitUserRequest:"..."',
  };
}

function researchRunProposalTarget(run: AgentResearchRunRecord): LearningProposalTarget | null {
  const text = [
    run.title,
    run.question,
    run.goal,
    run.note ?? '',
    run.reportArtifactId ?? '',
    ...run.plan,
    ...run.nextSteps,
    ...run.sourceIds,
    ...run.checkpoints.map((checkpoint) => checkpoint.note),
  ].join('\n').toLowerCase();
  if (/\b(memory|remember|fact|decision|constraint|risk|incident|pattern|architecture|ownership)\b/.test(text)) return 'memory';
  if (/\b(style|tone|preference|respond|answer|voice|persona)\b/.test(text)) return 'persona';
  if (/\b(repeat|routine|workflow|every time|checklist|runbook|process|before report|after report)\b/.test(text)) return 'routine';
  if (/\b(lesson|procedure|steps|how to|when asked|research|source|citation|report|credibility|synthesize)\b/.test(text)) return 'skill';
  return null;
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

function researchRunCompletionCandidate(run: AgentResearchRunRecord): LearningCandidate | null {
  if (run.status !== 'completed') return null;
  const target = researchRunProposalTarget(run);
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
    priority: target === 'memory' ? 57 : 55,
    reason: `Completed research run looks like ${proposalSubject(target)}.`,
    next: `Review the run ledger and report artifact, then capture this as Agent-local ${target} only if it should guide future work.`,
    scores: {
      usefulness: clampScore(60 + Math.min(16, run.sourceIds.length * 3) + Math.min(10, run.checkpoints.length * 2)),
      freshness: completedIsoFreshness(run.completedAt),
      sourceQuality: run.reportArtifactId ? 78 : run.sourceIds.length > 0 ? 70 : 62,
      risk: target === 'memory' ? 32 : 30,
    },
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: inferMemoryClass(`${run.title}\n${run.note ?? ''}\n${run.goal}`),
      scope: 'project',
      summary: previewHarnessText(run.note || run.title, 140),
      detail,
      tags: 'learned,research-run,memory',
      confidence: run.reportArtifactId ? '82' : '76',
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
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create" confirm:true explicitUserRequest:"..."'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior" confirm:true explicitUserRequest:"..."',
  };
}

function extractMessageText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (typeof message !== 'object' || message === null) return '';
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part !== 'object' || part === null) return '';
      const partRecord = part as Record<string, unknown>;
      return typeof partRecord.text === 'string' ? partRecord.text : '';
    }).filter(Boolean).join('\n');
  }
  return '';
}

function sessionLoadedText(manager: SessionManagerLike, session: SessionInfoLike): string {
  if (typeof manager.load !== 'function') return '';
  try {
    const loaded = manager.load(session.name);
    const metaTitle = loaded.meta?.title ?? '';
    const messageText = (loaded.messages ?? []).map(extractMessageText).filter(Boolean).slice(-8).join('\n');
    return [metaTitle, messageText].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

function sessionProposalTarget(text: string): LearningProposalTarget | null {
  const normalized = text.toLowerCase();
  if (/\b(memory|remember|fact|decision|constraint|risk|incident|pattern|architecture|ownership)\b/.test(normalized)) return 'memory';
  if (/\b(style|tone|preference|respond|answer|voice|persona)\b/.test(normalized)) return 'persona';
  if (/\b(repeat|routine|workflow|every time|checklist|runbook|process)\b/.test(normalized)) return 'routine';
  if (/\b(lesson|procedure|steps|how to|when asked|debug|fix|review|test|release|deploy|triage|research|source|citation|report)\b/.test(normalized)) return 'skill';
  return null;
}

function sessionDetail(session: SessionInfoLike, loadedText: string): string {
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

function sessionCompletionCandidate(manager: SessionManagerLike, session: SessionInfoLike): LearningCandidate | null {
  if (!session.name) return null;
  const loadedText = sessionLoadedText(manager, session);
  const text = [session.title ?? '', session.name, loadedText].join('\n');
  const target = sessionProposalTarget(text);
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
    priority: target === 'memory' ? 54 : 52,
    reason: `Saved session looks like ${proposalSubject(target)}.`,
    next: `Inspect the saved session transcript, then capture this as Agent-local ${target} only if it should guide future work.`,
    scores: {
      usefulness: clampScore(52 + Math.min(18, (session.messageCount ?? 0) / 2) + (loadedText ? 8 : 0)),
      freshness: completedTimestampFreshness(session.timestamp),
      sourceQuality: loadedText ? 68 : 58,
      risk: loadedText ? 34 : 42,
    },
    proposalTarget: target,
    proposalFields: target === 'memory' ? {
      cls: inferMemoryClass(text),
      scope: 'project',
      summary: previewHarnessText(loadedText || labelBase, 140),
      detail,
      tags: 'learned,saved-session,memory',
      confidence: loadedText ? '76' : '68',
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
      ? 'agent_harness mode:"run_workspace_action" actionId:"memory-create" confirm:true explicitUserRequest:"..."'
      : 'agent_harness mode:"run_workspace_action" actionId:"learned-behavior" confirm:true explicitUserRequest:"..."',
  };
}

function notePromotionCandidate(item: AgentWorkspaceLocalLibraryItem): LearningCandidate | null {
  if (!isReviewed(item) || !item.description.includes('Origin URL')) return null;
  return {
    id: `note-promote:${item.id}`,
    label: item.name,
    domain: 'note',
    recordId: item.id,
    status: 'ready-to-promote',
    priority: 52,
    reason: 'Reviewed note appears to have a source URL that may belong in isolated Agent Knowledge.',
    next: 'Promote only if the source is durable, useful later, and the user wants it in Agent Knowledge.',
    scores: {
      usefulness: itemUsefulness(item),
      freshness: itemFreshness(item),
      sourceQuality: clampScore(itemSourceQuality(item) + 8),
      risk: 18,
    },
    reviewState: item.reviewState,
    inspectRoute: localRegistryRoute('note', 'get', item.id),
    modelRoute: localRegistryModelRoute('note'),
    createRoute: 'agent_harness mode:"workspace_action" actionId:"notes-to-knowledge"',
  };
}

function candidatesForItem(domain: LocalLearningCandidateDomain, item: AgentWorkspaceLocalLibraryItem): LearningCandidate[] {
  const candidates: LearningCandidate[] = [];
  const missing = missingRequirementCount(item);
  if (missing > 0 && (domain === 'skill' || domain === 'skill_bundle' || domain === 'routine')) {
    candidates.push(candidateBase(
      domain,
      item,
      'needs-setup',
      item.enabled ? 88 : 68,
      `${missing} setup requirement(s) are missing.`,
      'Resolve setup requirements before enabling, scheduling, or relying on this behavior.',
    ));
  }
  if (item.confidence !== undefined && item.confidence < 70) {
    candidates.push(candidateBase(
      domain,
      item,
      'low-confidence',
      78 - Math.floor(item.confidence / 5),
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
      item.reviewState === 'stale' ? 92 : enabledOrActive ? 88 : 74,
      item.reviewState === 'stale'
        ? 'Record is stale and should not silently guide the assistant.'
        : enabledOrActive
          ? 'Record can influence the assistant but is not reviewed.'
          : 'Record is fresh and waiting for review.',
      'Inspect provenance and content, then review it, revise it, or mark it stale.',
    ));
  }
  if (domain === 'note') {
    const behaviorProposal = noteBehaviorProposalCandidate(item);
    if (behaviorProposal) candidates.push(behaviorProposal);
    const promotion = notePromotionCandidate(item);
    if (promotion) candidates.push(promotion);
  }
  return candidates;
}

function workPlanCompletionCandidates(context: CommandContext): readonly LearningCandidate[] {
  try {
    return (context.workspace?.workPlanStore?.listItems?.() ?? [])
      .flatMap((item) => {
        const candidate = workPlanCompletionCandidate(item);
        return candidate ? [candidate] : [];
      });
  } catch {
    return [];
  }
}

function researchRunCompletionCandidates(context: CommandContext): readonly LearningCandidate[] {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return [];
  try {
    return AgentResearchRunRegistry.fromShellPaths(shellPaths)
      .snapshot()
      .completed
      .flatMap((run) => {
        const candidate = researchRunCompletionCandidate(run);
        return candidate ? [candidate] : [];
      });
  } catch {
    return [];
  }
}

function sessionCompletionCandidates(context: CommandContext): readonly LearningCandidate[] {
  const manager = context.session?.sessionManager as SessionManagerLike | undefined;
  if (typeof manager?.list !== 'function') return [];
  try {
    return manager.list()
      .filter((session) => session.name !== context.session?.runtime?.sessionId)
      .flatMap((session) => {
        const candidate = sessionCompletionCandidate(manager, session);
        return candidate ? [candidate] : [];
      });
  } catch {
    return [];
  }
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

export function buildLearningCandidates(context: CommandContext): readonly LearningCandidate[] {
  const snapshot = buildAgentWorkspaceRuntimeSnapshot(context);
  const candidates = [
    ...snapshot.localMemories.flatMap((item) => candidatesForItem('memory', item)),
    ...snapshot.localNotes.flatMap((item) => candidatesForItem('note', item)),
    ...snapshot.localPersonas.flatMap((item) => candidatesForItem('persona', item)),
    ...snapshot.localSkills.flatMap((item) => candidatesForItem('skill', item)),
    ...snapshot.localSkillBundles.flatMap((item) => candidatesForItem('skill_bundle', item)),
    ...snapshot.localRoutines.flatMap((item) => candidatesForItem('routine', item)),
    ...consolidationCandidatesForDomain('memory', snapshot.localMemories),
    ...consolidationCandidatesForDomain('persona', snapshot.localPersonas),
    ...consolidationCandidatesForDomain('skill', snapshot.localSkills),
    ...consolidationCandidatesForDomain('routine', snapshot.localRoutines),
    ...workPlanCompletionCandidates(context),
    ...researchRunCompletionCandidates(context),
    ...sessionCompletionCandidates(context),
    ...vibeHealthCandidates(context),
  ];
  if (candidates.length === 0) candidates.push(captureCandidate());
  return candidates.sort((left, right) => right.priority - left.priority || left.label.localeCompare(right.label));
}
