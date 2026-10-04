/** Transport data only. Source text does not confer execution or verification authority. */
import { array, boolean, literal, number, strictObject, string, union, type z } from 'zod/v4';

export const NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES = 262_144;
export const NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES = 278_528;

const id = string().min(1).max(200);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Validate non-whitespace without trimming, normalization, deduplication, or reordering.
const text = string().min(1).max(20_000).regex(/\S/, 'Must contain non-whitespace text');
const criteria = array(text).min(1).max(100);
const bounded = (value: unknown, limit: number): boolean => {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= limit;
  } catch { return false; }
};

/** The authenticated host owns project, actor, source, session, work, and attempt selection. */
export const nativeWorkSubmissionRequestSchema = strictObject({
  requestId: id, inputId: id, expectedRevision: revision, goal: text, criteria,
}).refine(value => bounded(value, NATIVE_WORK_SUBMISSION_MAX_REQUEST_BYTES), 'Submission exceeds byte limit');

export const nativeWorkSubmissionLookupRequestSchema = strictObject({ requestId: id });

/** Immutable submit-event projection. This is not an engine execution receipt. */
export const nativeWorkSubmissionReceiptSchema = strictObject({
  projectId: id, requestId: id, inputId: id, ledgerRevision: revision, workId: id, attemptId: id,
  expectedRevision: strictObject({ work: revision, criteria: revision, attempt: revision }),
  source: strictObject({ version: literal(1), sourceId: id, sourceRevision: id, sessionId: id }),
  goal: text, criteria,
}).refine(value => bounded(value, NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES), 'Receipt exceeds byte limit');

export const nativeWorkSubmissionResultSchema = strictObject({
  kind: literal('submitted'), replayed: boolean(), receipt: nativeWorkSubmissionReceiptSchema,
}).refine(value => bounded(value, NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES), 'Submission result exceeds byte limit');

export const nativeWorkSubmissionLookupResultSchema = union([
  strictObject({ kind: literal('found'), receipt: nativeWorkSubmissionReceiptSchema }),
  strictObject({ kind: literal('not-found') }),
]).refine(value => bounded(value, NATIVE_WORK_SUBMISSION_MAX_RESPONSE_BYTES), 'Lookup result exceeds byte limit');

export type NativeWorkSubmissionRequest = z.infer<typeof nativeWorkSubmissionRequestSchema>;
export type NativeWorkSubmissionLookupRequest = z.infer<typeof nativeWorkSubmissionLookupRequestSchema>;
export type NativeWorkSubmissionReceipt = z.infer<typeof nativeWorkSubmissionReceiptSchema>;
export type NativeWorkSubmissionResult = z.infer<typeof nativeWorkSubmissionResultSchema>;
export type NativeWorkSubmissionLookupResult = z.infer<typeof nativeWorkSubmissionLookupResultSchema>;
