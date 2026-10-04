import type { ContentPart } from '../providers/interface.js';
import { readNativeConversationTurnPermit, type NativeConversationTurnPermit, type NativeConversationTurnSource } from '../workflow/work-ledger/native-intake-client.js';

export type NativeConversationTurnStatus = 'unclaimed' | 'queued' | 'running' | 'settled' | 'retryable' | 'recovery_required';
export class NativeConversationTurnAdmissionError extends Error {
  constructor(readonly code: 'identity_mismatch' | 'recovery_required') {
    super(`Native conversation turn: ${code}`); this.name = 'NativeConversationTurnAdmissionError';
  }
}
export interface NativeConversationTurnAdmission {
  readonly permit: NativeConversationTurnPermit;
  readonly source: NativeConversationTurnSource;
  status: Exclude<NativeConversationTurnStatus, 'unclaimed'>;
}
// Intentionally retained for the process lifetime, including settled attempts.
// Durable restart ambiguity is owned by the product dispatch claim, not this map.
const inputs = new Map<string, NativeConversationTurnAdmission>();
const keyOf = (source: NativeConversationTurnSource) => JSON.stringify([source.projectId, source.sourceRef.inputId]);
const identityOf = (source: NativeConversationTurnSource) => JSON.stringify([source.projectId, source.requestId, source.sourceRef, source.route, source.text]);

export function validateNativeConversationTurn(permit: NativeConversationTurnPermit, text: string, content?: readonly ContentPart[], projectId?: string): NativeConversationTurnSource {
  const source = readNativeConversationTurnPermit(permit);
  if (source.text !== text || (projectId !== undefined && source.projectId !== projectId)
    || (content !== undefined && (content.length !== 1 || content[0]?.type !== 'text' || content[0].text !== text))) {
    throw new NativeConversationTurnAdmissionError('identity_mismatch');
  }
  return source;
}

/** Validates before queueing; the same logical source cannot run twice. */
export function admitNativeConversationTurn(permit: NativeConversationTurnPermit, text: string, content?: readonly ContentPart[], projectId?: string): NativeConversationTurnAdmission | null {
  const source = validateNativeConversationTurn(permit, text, content, projectId);
  const key = keyOf(source), prior = inputs.get(key);
  if (prior) {
    if (identityOf(prior.source) !== identityOf(source)) throw new NativeConversationTurnAdmissionError('identity_mismatch');
    if (prior.status === 'recovery_required') throw new NativeConversationTurnAdmissionError('recovery_required');
    if (prior.status !== 'retryable') return null;
    // Failover must preserve the original opaque binding, not reconstruct it.
    if (prior.permit !== permit) throw new NativeConversationTurnAdmissionError('recovery_required');
  }
  const admission: NativeConversationTurnAdmission = { permit, source, status: 'queued' };
  inputs.set(key, admission);
  return admission;
}

export function readNativeConversationTurnStatus(permit: NativeConversationTurnPermit): NativeConversationTurnStatus {
  const source = readNativeConversationTurnPermit(permit);
  const prior = inputs.get(keyOf(source));
  if (prior && identityOf(prior.source) !== identityOf(source)) throw new NativeConversationTurnAdmissionError('identity_mismatch');
  return prior?.status ?? 'unclaimed';
}

export function startNativeConversationTurn(admission: NativeConversationTurnAdmission): void {
  if (inputs.get(keyOf(admission.source)) !== admission || admission.status !== 'queued') throw new NativeConversationTurnAdmissionError('recovery_required');
  admission.status = 'running';
}
export function failNativeConversationTurn(admission: NativeConversationTurnAdmission, safelyRetryable: boolean): void {
  if (inputs.get(keyOf(admission.source)) === admission) admission.status = safelyRetryable ? 'retryable' : 'recovery_required';
}
export function settleNativeConversationTurn(admission: NativeConversationTurnAdmission): void {
  if (inputs.get(keyOf(admission.source)) === admission && (admission.status === 'running' || admission.status === 'queued')) admission.status = 'settled';
}
