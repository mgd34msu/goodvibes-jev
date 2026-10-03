import type { NativeWorkLedgerState } from '../runtime/native-work-ledger.ts';

/** Plain terminal text only; ledger content never becomes an action or terminal escape. */
const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
export function nativeWorkLedgerLines(state: NativeWorkLedgerState): string[] {
  const lines = ['Native work ledger · read only'];
  if (state.status !== 'ready') return [...lines, `${state.status}: ${safe(state.reason)}`];
  lines.push(`Project ${safe(state.snapshot.projectId)} · snapshot ${state.snapshot.cursor} · history ${state.cursor}`);
  if (!state.snapshot.works.length) lines.push('No native work recorded for this project.');
  for (const view of state.snapshot.works) {
    const { work, attempt, verification } = view;
    if (view.execution) {
      const execution = view.execution;
      lines.push(`Execution: ${execution.status === 'pending' ? 'waiting for Jev' : execution.status} · ${safe(execution.reason)}`, `Runner: ${safe(execution.contractId ?? 'not bound')}`);
    }
    lines.push(`Work ${safe(work.id)} · revision ${work.revision} · ${safe(work.title)}`,
      `Intent: ${safe(work.goal)}`,
      `Reported: ${work.reportedState} · Verification: ${verification.state}`,
      `Verification reason: ${safe(verification.reason)}`,
      `Criteria revision ${work.criteriaRevision}`);
    work.criteria.forEach((criterion, index) => lines.push(`  ${index + 1}. ${safe(criterion)}`));
    lines.push(attempt ? `Attempt ${safe(attempt.id)} · revision ${attempt.revision} · owner ${safe(attempt.ownerId)} · ${attempt.state}` : 'Attempt: none');
    if (attempt?.predecessorId) lines.push(`Previous attempt: ${safe(attempt.predecessorId)}`);
    if (attempt?.report) lines.push(`Report: ${safe(attempt.report)}`);
    if (attempt?.blocker) lines.push(`Blocker: ${safe(attempt.blocker)}`);
    for (const attention of view.attention) lines.push(`Attention (${attention.kind}): ${safe(attention.reason)}`);
    const evidence = verification.evidence;
    if (!evidence) lines.push('Evidence: none');
    else {
      lines.push(`Evidence ${safe(evidence.id)} · ${evidence.outcome} · ${evidence.source} · actor ${safe(evidence.actorId)}`,
        `Target ${safe(evidence.target.workId)} r${evidence.target.workRevision} · criteria r${evidence.target.criteriaRevision} · attempt ${safe(evidence.target.attemptId)} r${evidence.target.attemptRevision}`);
      for (const ref of evidence.references) lines.push(`  ${ref.kind}: ${safe(ref.ref)}${ref.digest ? ` · digest ${safe(ref.digest)}` : ''}`);
      for (const result of evidence.criteriaResults) lines.push(`  Criterion ${result.criterionIndex + 1}: ${result.status} · ${result.references.map(safe).join(', ')}`);
    }
  }
  lines.push('Durable history (read only; no execution authority)');
  for (const event of state.history) {
    lines.push(`#${event.sequence} ${event.type} · work ${safe(event.workId)} r${event.work.revision} · criteria r${event.work.criteriaRevision} · attempt ${safe(event.attemptId ?? 'none')}`);
    lines.push(`  Actor ${safe(event.actorId)} · request ${safe(event.requestId)} · reported ${event.work.reportedState}`,
      `  Intent: ${safe(event.work.goal)}`);
    event.work.criteria.forEach((criterion, index) => lines.push(`  Criterion ${index + 1}: ${safe(criterion)}`));
    for (const attempt of event.attempts) {
      lines.push(`  Attempt ${safe(attempt.id)} r${attempt.revision} · ${attempt.state} · owner ${safe(attempt.ownerId)} · previous ${safe(attempt.predecessorId ?? 'none')}`);
      if (attempt.report) lines.push(`  Report: ${safe(attempt.report)}`);
      if (attempt.blocker) lines.push(`  Blocker: ${safe(attempt.blocker)}`);
    }
    if (event.reason) lines.push(`  ${safe(event.reason)}`);
    if (event.evidence) for (const ref of event.evidence.references) lines.push(`  ${ref.kind}: ${safe(ref.ref)}`);
  }
  return lines;
}
