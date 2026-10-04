/** Separate v1 settlement format. Never widen the exact native execution v1 parser. */
import { createHash } from 'node:crypto';
import { canonicalJson, type EntryType } from '@goodvibes-jev/judgment';
import { literal, number, strictObject, string, type z } from 'zod/v4';
import { evidenceTargetSchema, ledgerEvidenceSchema } from './types.js';

export const nativeSettlementDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value as EntryType)).digest('hex');
export const nativeWorkAttestationSchema = ledgerEvidenceSchema.pick({ outcome: true, reason: true, references: true, source: true, criteriaResults: true });
export type NativeWorkAttestation = z.infer<typeof nativeWorkAttestationSchema>;
const digest = string().regex(/^[0-9a-f]{64}$/);
const id = string().min(1).max(200);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeWorkSettlementSchema = strictObject({
  version: literal(1), projectId: id, keyHash: digest, receiptDigest: digest, payloadRevision: digest,
  target: evidenceTargetSchema, contractId: id, contractDigest: digest, publicationDigest: digest,
  reportRequestId: id, evidenceRequestId: id, reportSequence: revision, evidenceSequence: revision,
  evidenceId: id, targetAfterReport: evidenceTargetSchema,
  attestation: nativeWorkAttestationSchema,
});
export type NativeWorkSettlementReceipt = z.infer<typeof nativeWorkSettlementSchema>;
export interface NativeWorkSettlementPublication {
  readonly report: string;
  readonly attestation: NativeWorkAttestation;
  readonly receiptDigest: string;
  readonly contractDigest: string;
  /** Principal of the currently held paired owner, not arbitrary caller input. */
  readonly actorId: string;
}
