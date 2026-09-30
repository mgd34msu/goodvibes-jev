import type { PermissionPromptDecision } from '../permissions/prompt.js';

/** Recorded provenance; never inferred from a legacy boolean or free text. */
export const SHARED_APPROVAL_DISPOSITIONS = [
  'approved', 'denied', 'amended', 'cancelled', 'expired', 'remembered',
] as const;
export type SharedApprovalDisposition = typeof SHARED_APPROVAL_DISPOSITIONS[number];
export type ExplicitApprovalDisposition = Extract<SharedApprovalDisposition, 'approved' | 'denied' | 'amended'>;

/** The persisted record is richer than the unchanged ordinary prompt result. */
export interface SharedApprovalDecision extends PermissionPromptDecision {
  readonly disposition?: SharedApprovalDisposition | undefined;
}

/** Refuse malformed or contradictory resolution input before changing a record. */
export function assertExplicitApprovalDisposition(
  approved: unknown,
  disposition: unknown,
): asserts disposition is ExplicitApprovalDisposition | undefined {
  if (typeof approved !== 'boolean'
    || (disposition !== undefined && (approved
      ? disposition !== 'approved'
      : disposition !== 'denied' && disposition !== 'amended'))) {
    throw Object.assign(new Error('Approval disposition must match the explicit approval decision.'), {
      code: 'INVALID_ARGUMENT', status: 400,
    });
  }
}

/** Validate a stored marker against the actual terminal status and verdict. */
export function approvalDispositionMatches(
  approved: boolean,
  disposition: unknown,
  status: string,
): boolean {
  if (disposition === undefined) return true; // legacy snapshots remain readable
  if (status === 'approved') return approved && (disposition === 'approved' || disposition === 'remembered');
  if (approved) return false;
  if (status === 'denied') return disposition === 'denied' || disposition === 'amended' || disposition === 'remembered';
  if (status === 'cancelled') return disposition === 'cancelled';
  if (status === 'expired') return disposition === 'expired';
  return false;
}

/** Keep the exact legacy awaited shape: provenance is read from the record. */
export function ordinaryApprovalDecision(record: SharedApprovalDecision): PermissionPromptDecision {
  const { disposition: _disposition, ...decision } = record;
  return decision;
}
