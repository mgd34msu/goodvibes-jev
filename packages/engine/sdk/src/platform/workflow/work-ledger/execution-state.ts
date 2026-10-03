import { createHash } from 'node:crypto';
import { canonicalJson, type JsonValue } from '@goodvibes-jev/judgment';
import { parseJevDecision } from '@goodvibes-jev/judgment/decisions';
import type { WorkExecution } from './execution-types.js';
import type { WorkLedgerState } from './types.js';

export function executionDigest(input: Pick<WorkExecution, 'id' | 'actorId' | 'projectId' | 'target' | 'goal' | 'criteria' | 'sessionId' | 'projectRoot'>): string {
  const { id, actorId, projectId, target, goal, criteria, sessionId, projectRoot } = input;
  return createHash('sha256').update(canonicalJson({ id, actorId, projectId, target, goal, criteria, sessionId, projectRoot })).digest('hex');
}

/** Deterministic revision/currentness checks, not a semantic permission decision. */
export function executionIsCurrent(state: WorkLedgerState, execution: WorkExecution): boolean {
  const work = state.works.find(item => item.id === execution.target.workId);
  const attempt = state.attempts.find(item => item.id === execution.target.attemptId);
  return work !== undefined && attempt !== undefined && work.reportedState !== 'cancelled'
    && work.currentAttemptId === attempt.id && attempt.state === 'active'
    && work.revision === execution.target.workRevision && work.criteriaRevision === execution.target.criteriaRevision
    && attempt.revision === execution.target.attemptRevision && attempt.ownerId === execution.actorId
    && work.goal === execution.goal && JSON.stringify(work.criteria) === JSON.stringify(execution.criteria);
}

/** Fail closed on forged, detached or duplicate durable dispatch identities. */
export function validateExecutionState(state: WorkLedgerState, projectId: string): void {
  if (new Set(state.executions.map(item => item.id)).size !== state.executions.length
    || new Set(state.executions.flatMap(item => item.contractId === null ? [] : [item.contractId])).size !== state.executions.filter(item => item.contractId !== null).length
    || new Set(state.executions.map(item => item.target.attemptId)).size !== state.executions.length) throw new Error('Duplicate native execution binding');
  for (const entry of state.executions) {
    const admissions = entry.admissions.map(parseJevDecision);
    if (new Set(admissions.map(item => item.decisionId)).size !== admissions.length) throw new Error('Duplicate native admission receipt');
    if (admissions.some(item => item.binding.sourceId !== entry.target.workId || item.binding.inputRevision !== entry.inputDigest
      || item.binding.actionId !== entry.id || item.binding.actionRevision !== entry.inputDigest
      || item.binding.authorityId !== entry.actorId || item.binding.scopeId !== entry.projectId)) throw new Error('Native admission receipt binding mismatch');
    const currentDecision = admissions.at(-1);
    if ((entry.status === 'dispatching' || entry.status === 'running' || entry.status === 'settled') && currentDecision?.outcome !== 'act') throw new Error('Native dispatch lacks a bound act decision');
    if (entry.status === 'deferred' && currentDecision?.outcome !== 'defer') throw new Error('Native deferral lacks its condition');
    if (entry.status === 'revising' && currentDecision?.outcome !== 'revise') throw new Error('Native revision lacks its continuation');
    if (entry.status === 'rejected' && currentDecision?.outcome !== 'reject') throw new Error('Native rejection lacks a decision');
    if (entry.contractId !== null) {
      if (!entry.runnerReceipt || typeof entry.runnerReceipt !== 'object' || Array.isArray(entry.runnerReceipt)
        || entry.runnerReceipt['contractId'] !== entry.contractId
        || entry.runnerReceiptDigest !== createHash('sha256').update(canonicalJson(entry.runnerReceipt)).digest('hex')) throw new Error('Native runner receipt is invalid');
    } else if (entry.runnerReceipt !== undefined || entry.runnerReceiptDigest !== undefined) throw new Error('Unbound native execution has a runner receipt');
    const admittedWork = state.history.find(event => event.workId === entry.target.workId && event.work.revision === entry.target.workRevision)?.work;
    const admittedAttempt = state.history.flatMap(event => event.attempts).find(attempt => attempt.id === entry.target.attemptId && attempt.revision === entry.target.attemptRevision);
    if (entry.projectId !== projectId || entry.inputDigest !== executionDigest(entry)
      || !admittedWork || !admittedAttempt || admittedWork.currentAttemptId !== admittedAttempt.id
      || admittedWork.criteriaRevision !== entry.target.criteriaRevision || admittedWork.goal !== entry.goal
      || JSON.stringify(admittedWork.criteria) !== JSON.stringify(entry.criteria) || admittedAttempt.ownerId !== entry.actorId
      || admittedAttempt.state !== 'active' || admittedAttempt.workId !== admittedWork.id) throw new Error('Invalid native execution binding');
    const evidence = state.evidence.find(item => item.id === entry.evidenceId);
    if (entry.status === 'settled' && (!evidence || !entry.publication
      || evidence.target.workId !== entry.target.workId || evidence.target.attemptId !== entry.target.attemptId
      || evidence.target.criteriaRevision !== entry.target.criteriaRevision
      || evidence.target.workRevision !== entry.target.workRevision + 1 || evidence.target.attemptRevision !== entry.target.attemptRevision + 1
      || evidence.actorId !== entry.actorId)) throw new Error('Native settlement is detached from evidence');
    if (entry.status === 'settled' && evidence && entry.publication) {
      const { outcome, reason, references, source, criteriaResults } = evidence;
      if (canonicalJson(entry.publication.attestation) !== canonicalJson({ outcome, reason, references, source, criteriaResults } as unknown as JsonValue)) throw new Error('Native publication differs from persisted evidence');
      const report = state.history.find(event => event.actorId === entry.actorId && event.requestId === `native:${entry.contractId}:report`);
      const finding = state.history.find(event => event.evidence?.id === evidence.id);
      if (!report || !finding || report.sequence !== entry.publication.expectedRevision + 1 || finding.sequence !== report.sequence + 1
        || report.attempts.find(attempt => attempt.id === entry.target.attemptId)?.report !== entry.publication.report) throw new Error('Native publication is detached from atomic receipts');
    }
    if ((entry.status === 'dispatching' || entry.status === 'running') && entry.decisionIds.length === 0) throw new Error('Native dispatch lacks admission provenance');
    if (entry.status !== 'settled' && entry.evidenceId !== null) throw new Error('Unsettled execution carries published evidence');
  }
}
