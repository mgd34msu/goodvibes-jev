import type { CommandContext } from '../command-registry.ts';
import { formatAgentRecordReviewState } from '../../agent/record-labels.ts';
import { formatConsolidationProposalForReview } from '../../agent/memory-consolidation-proposals.ts';
import { VALID_REVIEW_STATES, VALID_SCOPES, isValidReviewState, isValidScope } from './recall-shared.ts';
import { getMemoryApi } from './recall-query.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

export function handleRecallQueue(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const limit = Math.max(1, parseInt(args[0] ?? '10', 10) || 10);
  const queue = memory.reviewQueue(limit);
  const proposals = context.clients?.memoryConsolidation?.listPendingProposals() ?? [];
  if (!queue.length && !proposals.length) {
    context.print('[memory] Review queue is empty.');
    return;
  }
  if (queue.length) {
    context.print(`[memory] Review queue (${queue.length}):`);
    for (const record of queue) {
      const reason = record.staleReason ? `, ${record.staleReason}` : '';
      context.print(`  ${record.id} [${record.scope}/${record.cls}] ${formatAgentRecordReviewState(record.reviewState)} ${record.confidence}%  ${record.summary}${reason}`);
    }
  } else {
    context.print('[memory] Review queue is empty.');
  }
  // Consolidation judgment proposals (contradictions, cross-scope
  // duplicates, stale-delete candidates), the referenced records are already
  // in the queue above; this is WHY they were flagged, and how to act on
  // them through the same /memory review command.
  if (proposals.length) {
    context.print(`[memory] Pending consolidation proposals (${proposals.length}):`);
    for (const proposal of proposals) {
      context.print(formatConsolidationProposalForReview(proposal));
    }
  }
}

export function handleRecallReview(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }

  const [id, stateRaw, ...rest] = args;
  if (!id || !stateRaw || !isValidReviewState(stateRaw)) {
    context.print(`[memory] Usage: /memory review <id> <${VALID_REVIEW_STATES.join('|')}> [--confidence <0-100>] [--by <name>] [--reason <text>]`);
    return;
  }

  const confidenceIdx = rest.indexOf('--confidence');
  const byIdx = rest.indexOf('--by');
  const reasonIdx = rest.indexOf('--reason');
  const confidence = confidenceIdx !== -1 ? parseInt(rest[confidenceIdx + 1] ?? '', 10) : undefined;
  const reviewedBy = byIdx !== -1 ? rest[byIdx + 1] : 'operator';
  const staleReason = reasonIdx !== -1 ? rest.slice(reasonIdx + 1).join(' ') : undefined;

  const record = memory.review(id, {
    state: stateRaw,
    confidence: Number.isFinite(confidence) ? confidence : undefined,
    reviewedBy,
    staleReason,
  });

  if (!record) {
    context.print(`[memory] Record not found: ${id}`);
    return;
  }
  context.print(`[memory] Reviewed ${record.id}: ${record.reviewState} ${record.confidence}%`);
}

export function handleRecallExplain(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const scopeIdx = args.indexOf('--scope');
  const scopeValues = scopeIdx !== -1 ? args.slice(scopeIdx + 1).filter((token) => !token.startsWith('--')) : [];
  const taskTokens = args.filter((token, index) => {
    if (token === '--scope') return false;
    if (scopeIdx !== -1 && index > scopeIdx) return false;
    return true;
  });
  const task = taskTokens.join(' ').trim();
  if (!task) {
    context.print('[memory] Usage: /memory explain <task description...> [--scope <write-scope> ...]');
    return;
  }
  const explanation = memory.explain(task, scopeValues);
  if (explanation.injections.length === 0) {
    context.print('[memory] No reviewed project knowledge was selected for that task.');
    return;
  }
  context.print(explanation.prompt ?? '[memory] No explainable project knowledge was selected.');
}

export function handleRecallPromote(args: string[], context: CommandContext): void {
  const memory = getMemoryApi(context);
  if (!memory) {
    return;
  }
  const parsed = stripYesFlag(args);
  const id = parsed.rest[0];
  const scope = parsed.rest[1];
  if (!id || !scope || !isValidScope(scope)) {
    context.print(`[memory] Usage: /memory promote <id> <${VALID_SCOPES.join('|')}> --yes`);
    return;
  }
  if (!parsed.yes) {
    requireYesFlag(context, `promote durable memory record ${id} to ${scope} scope`, '/memory promote <id> <scope> --yes');
    return;
  }
  const record = memory.update(id, { scope });
  if (!record) {
    context.print(`[memory] Record not found: ${id}`);
    return;
  }
  context.print(`[memory] Promoted ${record.id} to ${record.scope} scope.`);
}
