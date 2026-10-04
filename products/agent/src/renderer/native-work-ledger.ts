import { nativeWorkExecutionLines } from '../runtime/native-work-execution.ts';
import type { NativeWorkLedgerState } from '../runtime/native-work-ledger.ts';

/** Plain terminal text only; ledger content never becomes an action or terminal escape. */
const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
export function nativeWorkLedgerLines(state: NativeWorkLedgerState): string[] {
  const lines = ['Native work ledger · explicit execution controls'];
  if (state.status !== 'ready') return [...lines, `${state.status}: ${safe(state.reason)}`];
  lines.push(`Project ${safe(state.snapshot.projectId)} · snapshot ${state.snapshot.cursor} · history ${state.cursor}`);
  if (!state.snapshot.works.length) lines.push('No native work recorded for this project.');
  for (const view of state.snapshot.works) {
    const { work, attempt, verification } = view;
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
  lines.push(...nativeWorkExecutionLines(state.execution).map(safe));
  lines.push('Controls: /work start|status|cancel|resume <work-id>. Status/cancel retain the observed attempt; resume is explicit. Closing only detaches local requests.');
  lines.push('Durable history (read only; no execution authority)');
  for (const event of state.history) {
    if (event.type === 'import_legacy') {
      lines.push(`#${event.sequence} import_legacy · ${event.works.length} work records · ${event.manifest ? `${event.manifest.sources.length} preserved sources` : 'protected source provenance'}`,
        `  Actor ${safe(event.actorId)} · request ${safe(event.requestId)}`);
      for (const work of event.works) lines.push(`  Work ${safe(work.id)} r${work.revision} · ${safe(work.title)} · reported ${work.reportedState} · imported unverified`);
      if (!event.manifest) { lines.push('  Protected legacy provenance requires read:knowledge authorization.'); continue; }
      lines.push(`  Legacy preparation ${safe(event.manifest.digest)} · historical approval is not execution authority`);
      for (const entity of event.manifest.entities) {
        lines.push(`  Legacy ${entity.kind} ${safe(entity.id)} · ${entity.fragments.length} source fragments`);
        for (const fragment of entity.fragments) lines.push(`    Source ${safe(fragment.sourceId)} ${safe(fragment.pointer)}`);
      }
      for (const source of event.manifest.sources) lines.push(`  Preserved source ${safe(String(source.source.id))} · generation ${safe(source.generation)} · ${safe(JSON.stringify(source.source))}`);
      for (const link of event.manifest.links) lines.push(`  Link ${safe(link.from)} · ${safe(link.relation)} · ${safe(link.to)}`);
      continue;
    }
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
