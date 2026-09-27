/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * review-task-source.ts, review findings as a SECOND task source feeding the
 * ONE workstream engine (the fix-phase rework; never a sibling
 * scheduler).
 *
 * The reviewer's typed record, findings with file citations, the acceptance
 * checklist derived from the ORIGINAL task, and per-constraint satisfaction,
 * parses into typed tasks. A planner pass coalesces them by file-cluster/
 * subsystem and draws the INITIAL dependency graph: shared-file edges
 * (same-file tasks serialize, severity-first) and semantic-prerequisite edges
 * (verification tasks wait for the fixes that touch their files; an
 * injectable judgment hook can add more). The output is a
 * CreateWorkstreamInput for the one engine: worktree isolation, the
 * reviewed-and-merged release policy, and the elastic pool, sequential vs
 * concurrent is emergent from the edges, never a mode.
 */
import type { ReviewerReport } from '../agents/completion-report.js';
import { engineerPhases } from './controller-compat.js';
import type { WrfcCommitScope } from '../agents/wrfc-config.js';
import type { CreateWorkstreamInput } from './engine.js';
import { clusterOf, ELASTIC_PHASE_CAPACITY, planTaskGraph as planGraph } from './task-graph.js';
import type { WorkItemSpec } from './types.js';

/** Where a parsed task came from in the review record. */
export type ReviewTaskSource = 'finding' | 'checklist' | 'constraint';

/** One typed task parsed from the review. */
export interface ReviewTask {
  readonly id: string;
  readonly title: string;
  /** The full task text a fixer agent receives (original ask + the slice + citations). */
  readonly description: string;
  readonly source: ReviewTaskSource;
  readonly severity: 'critical' | 'major' | 'minor';
  /** File citations from the review record (drive shared-file edges + clusters). */
  readonly files: readonly string[];
}

/** Parse the reviewer's findings + acceptance checklist + constraint findings into typed tasks. */
export function parseReviewIntoTasks(input: {
  readonly review: ReviewerReport;
  readonly originalTask: string;
}): ReviewTask[] {
  const tasks: ReviewTask[] = [];
  let sequence = 0;
  const nextId = (): string => `rt-${++sequence}`;
  const preamble = `ORIGINAL REQUEST (the contract every fix must serve):\n${input.originalTask}\n\n`;

  for (const issue of input.review.issues ?? []) {
    if (issue.severity === 'suggestion') continue; // advisory, not contract work
    const files = issue.file ? [issue.file] : [];
    tasks.push({
      id: nextId(),
      title: issue.description.length > 90 ? `${issue.description.slice(0, 87)}...` : issue.description,
      description: `${preamble}FIX THIS REVIEW FINDING (${issue.severity}):\n${issue.description}\n`
        + (issue.file ? `Cited file: ${issue.file}${issue.line !== undefined ? `:${issue.line}` : ''}\n` : '')
        + 'Fix exactly this slice; do not take unrelated work.',
      source: 'finding',
      severity: issue.severity,
      files,
    });
  }

  for (const finding of input.review.constraintFindings ?? []) {
    if (finding.satisfied) continue;
    tasks.push({
      id: nextId(),
      title: `Satisfy constraint ${finding.constraintId}`,
      description: `${preamble}SATISFY THIS UNMET CONSTRAINT (${finding.constraintId}):\nEvidence it is unmet: ${finding.evidence}\n`
        + 'Make the deliverable genuinely satisfy the constraint; do not weaken the constraint.',
      source: 'constraint',
      severity: finding.severity ?? 'major',
      files: [],
    });
  }

  for (const item of input.review.acceptanceChecklist ?? []) {
    if (item.verified) continue;
    tasks.push({
      id: nextId(),
      title: `Make verifiable: ${item.item.length > 70 ? `${item.item.slice(0, 67)}...` : item.item}`,
      description: `${preamble}MAKE THIS ACCEPTANCE ITEM PASS (derived from the original task):\n${item.item}\n`
        + `Reviewer evidence it currently fails: ${item.evidence}\n`
        + 'Deliver the behavior the original task asked for, verifiably.',
      source: 'checklist',
      severity: 'major',
      files: [],
    });
  }

  return tasks;
}

/** An optional judgment hook adding semantic-prerequisite edges beyond the heuristics. */
export type SemanticEdgePlanner = (tasks: readonly ReviewTask[]) => ReadonlyArray<{ readonly from: string; readonly to: string }>;

export { clusterOf, ELASTIC_PHASE_CAPACITY };

/**
 * The review tasks placed in one graph (task-graph.ts): shared-file edges,
 * then semantic prerequisites: file-less verification tasks
 * (checklist/constraint) wait for every finding fix, and a custom
 * `semanticEdges` hook may add more on top.
 */
export function planTaskGraph(
  tasks: readonly ReviewTask[],
  semanticEdges?: SemanticEdgePlanner,
): { specs: WorkItemSpec[]; edgeCount: number } {
  const findingIds = tasks.filter((task) => task.source === 'finding').map((task) => task.id);
  return planGraph(
    tasks.map((task) => ({ id: task.id, title: task.title, task: task.description, severity: task.severity, files: task.files })),
    () => [
      ...tasks.filter((task) => task.source !== 'finding').flatMap((task) => findingIds.map((to) => ({ from: task.id, to }))),
      ...(semanticEdges?.(tasks) ?? []),
    ],
  );
}

/** Assemble the full CreateWorkstreamInput for one planned-fix cycle. */
export function planFixWorkstream(input: {
  readonly chainId: string;
  readonly originalTask: string;
  readonly review: ReviewerReport;
  readonly attempt: number;
  readonly commitScope: WrfcCommitScope;
  readonly semanticEdges?: SemanticEdgePlanner | undefined;
}): { workstream: CreateWorkstreamInput; tasks: ReviewTask[] } | null {
  const tasks = parseReviewIntoTasks({ review: input.review, originalTask: input.originalTask });
  if (tasks.length === 0) return null;
  const { specs } = planTaskGraph(tasks, input.semanticEdges);
  return {
    tasks,
    workstream: {
      title: `Planned fix (cycle ${input.attempt}): ${input.originalTask.slice(0, 60)}`,
      phases: engineerPhases(input.commitScope, ELASTIC_PHASE_CAPACITY),
      items: specs,
      isolation: 'worktree',
      releasePolicy: 'reviewed-and-merged',
      provenance: { decomposedBy: 'heuristic', strategy: 'review-findings' },
    },
  };
}
