import { enum as enumSchema, strictObject, string } from 'zod/v4';
import { workLedgerCommandSchema, workLedgerStateSchema, type LedgerWork, type LedgerAttempt, type WorkEvidenceTarget, type WorkLedgerEvent, type WorkLedgerState } from './types.js';
import { validateExecutionState } from './execution-state.js';

export const workLedgerIdentitySchema = strictObject({
  actorId: string().min(1).max(200),
  projectId: string().min(1).max(200),
  role: enumSchema(['coordinator', 'worker', 'verifier']),
});

/** Fail closed on malformed or inconsistent host data; never reset it to empty. */
export function readWorkLedgerState(input: unknown, projectId: string): WorkLedgerState {
  const state = workLedgerStateSchema.parse(input);
  if (state.projectId !== projectId) throw new Error('Work ledger project mismatch');
  const unique = (ids: string[]) => new Set(ids).size === ids.length;
  if (!unique(state.works.map(w => w.id)) || !unique(state.attempts.map(a => a.id))
    || !unique(state.evidence.map(e => e.id))
    || !unique(state.receipts.map(r => JSON.stringify([r.actorId, r.requestId])))
    || state.history.length !== state.revision || state.receipts.length !== state.revision
    || state.history.some((event, index) => event.sequence !== index + 1)) {
    throw new Error('Inconsistent work ledger identities or history');
  }
  for (const work of state.works) {
    const attempt = state.attempts.find(a => a.id === work.currentAttemptId);
    if (work.revision > state.revision || work.criteriaRevision > work.revision
      || (work.currentAttemptId !== null && (!attempt || attempt.workId !== work.id))
      || (work.reportedState === 'cancelled' && attempt?.state !== 'cancelled' && attempt !== undefined)
      || state.attempts.some(a => a.workId === work.id && a.state === 'active' && a.id !== work.currentAttemptId)) {
      throw new Error('Inconsistent work ledger current attempt');
    }
  }
  for (const attempt of state.attempts) {
    const predecessor = state.attempts.find(a => a.id === attempt.predecessorId);
    if (!state.works.some(w => w.id === attempt.workId)
      || (attempt.predecessorId !== null && (!predecessor || predecessor.workId !== attempt.workId || predecessor.id === attempt.id))) {
      throw new Error('Inconsistent work ledger ownership chain');
    }
  }
  // Replay the immutable record images to detect rollback, orphan records and
  // receipts detached from the history they claim to acknowledge.
  const works = new Map<string, LedgerWork>();
  const attempts = new Map<string, LedgerAttempt>();
  const evidence = new Map<string, WorkLedgerEvent['evidence']>();
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  for (const [index, event] of state.history.entries()) {
    const prior = works.get(event.workId);
    const receipt = state.receipts[index];
    if (!receipt || receipt.actorId !== event.actorId || receipt.requestId !== event.requestId
      || !equal(receipt.event, event) || event.work.id !== event.workId
      || event.attemptId !== event.work.currentAttemptId
      || (event.type === 'create') !== !prior
      || event.work.revision !== (prior?.revision ?? 0) + (event.type === 'record_evidence' ? 0 : 1)
      || event.work.criteriaRevision !== (prior?.criteriaRevision ?? 0) + (event.type === 'create' || event.type === 'revise' ? 1 : 0)
      || (prior && (event.work.createdAt !== prior.createdAt || event.at < prior.updatedAt))
      || (event.type === 'record_evidence' && !equal(event.work, prior))) {
      throw new Error('Inconsistent work ledger event or receipt');
    }
    const signature = strictObject({ role: workLedgerIdentitySchema.shape.role, command: workLedgerCommandSchema }).parse(JSON.parse(receipt.signature));
    const command = signature.command;
    if (JSON.stringify(signature) !== receipt.signature || command.requestId !== event.requestId
      || command.type !== event.type || command.expectedRevision !== index
      || (command.type !== 'create' && (command.type === 'record_evidence' ? command.target.workId : command.workId) !== event.workId)) {
      throw new Error('Inconsistent work ledger receipt command');
    }
    for (const attempt of event.attempts) {
      const previous = attempts.get(attempt.id);
      const predecessor = attempt.predecessorId === null ? null : attempts.get(attempt.predecessorId);
      if (attempt.workId !== event.workId || attempt.revision !== (previous?.revision ?? 0) + 1
        || (previous && (attempt.ownerId !== previous.ownerId || attempt.predecessorId !== previous.predecessorId || attempt.createdAt !== previous.createdAt))
        || (attempt.predecessorId !== null && (!predecessor || predecessor.workId !== attempt.workId))
        || (attempt.createdAt > attempt.updatedAt) || attempt.updatedAt !== event.at) {
        throw new Error('Inconsistent work ledger attempt history');
      }
      attempts.set(attempt.id, attempt);
    }
    works.set(event.workId, event.work);
    if ((event.type === 'record_evidence') !== (event.evidence !== null)) throw new Error('Inconsistent evidence event');
    if (event.evidence) {
      const item = event.evidence;
      if (evidence.has(item.id) || item.actorId !== event.actorId || item.at !== event.at
        || !workEvidenceTargetMatches(item.target, event.work, attempts.get(event.attemptId ?? '') ?? null)
        || event.work.reportedState !== 'complete' || signature.role !== 'verifier'
        || (item.outcome === 'verified' && (item.source !== 'host_check'
          || item.criteriaResults.length !== event.work.criteria.length
          || new Set(item.criteriaResults.map(result => result.criterionIndex)).size !== event.work.criteria.length
          || item.criteriaResults.some(result => result.criterionIndex >= event.work.criteria.length || result.status !== 'satisfied'
            || result.references.length === 0 || result.references.some(ref => !item.references.some(reference => reference.ref === ref && reference.digest)))))) {
        throw new Error('Inconsistent work ledger evidence history');
      }
      evidence.set(item.id, item);
    }
  }
  if (!equal([...works.values()], state.works) || !equal([...attempts.values()], state.attempts)
    || !equal([...evidence.values()], state.evidence)) throw new Error('Work ledger state differs from committed history');
  validateExecutionState(state, projectId);
  return state;
}

export function workEvidenceTargetMatches(target: WorkEvidenceTarget, work: LedgerWork, attempt: LedgerAttempt | null): boolean {
  return target.workId === work.id && target.workRevision === work.revision
    && target.criteriaRevision === work.criteriaRevision && target.attemptId === attempt?.id
    && target.attemptRevision === attempt.revision;
}

