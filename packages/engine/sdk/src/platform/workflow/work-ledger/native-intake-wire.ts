/** Browser-safe conversation data. Capture and admission never grant execution authority. */
import { array, enum as enumSchema, literal, number, strictObject, string, union, type z } from 'zod/v4';

export const NATIVE_CONVERSATION_INTAKE_MAX_REQUEST_BYTES = 262_144;
export const NATIVE_CONVERSATION_INTAKE_MAX_RESPONSE_BYTES = 278_528;
const id = string().min(1).max(200);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Count UTF-16 units and preserve the exact submitted string.
const text = string().min(1).max(20_000).regex(/\S/, 'Must contain non-whitespace text');
const bounded = (value: unknown, limit: number): boolean => {
  try { const json = JSON.stringify(value); return typeof json === 'string' && new TextEncoder().encode(json).byteLength <= limit; }
  catch { return false; }
};
export const nativeConversationIntakeUnsupportedSourceSchema = strictObject({ kind: enumSchema(['image', 'file', 'context']), label: id });
export const nativeConversationIntakeCaptureRequestSchema = strictObject({
  requestId: id, inputId: id, text, unsupportedSources: array(nativeConversationIntakeUnsupportedSourceSchema).max(100),
}).refine(value => bounded(value, NATIVE_CONVERSATION_INTAKE_MAX_REQUEST_BYTES), 'Capture exceeds byte limit');
export const nativeConversationIntakeLookupRequestSchema = strictObject({ inputId: id });
export const nativeConversationIntakeTransitionRequestSchema = strictObject({ inputId: id, sourceRevision: id });
export const nativeConversationIntakeSourceRefSchema = strictObject({ version: literal(1), inputId: id, sourceId: id, sourceRevision: id, sessionId: id });
const spanSchema = strictObject({ partId: literal('input'), start: revision, end: revision });
/** Immutable admission-event projection, not an execution receipt or client-supplied proof. */
export const nativeConversationIntakeWorkReceiptSchema = strictObject({
  projectId: id, requestId: id, inputId: id, ledgerRevision: revision, workId: id, attemptId: id,
  expectedRevision: strictObject({ work: revision, criteria: revision, attempt: revision }),
  source: strictObject({ version: literal(2), sourceId: id, sourceRevision: id, sessionId: id,
    offsetEncoding: literal('utf16'), proposalRevision: id, spans: array(spanSchema).min(1).max(100),
    admissionDecisionId: id, judgmentDecisionIds: array(id).min(1).max(128) }),
  goal: text, criteria: array(text).min(1).max(100),
}).refine(value => {
  const boundary = (offset: number): boolean => offset <= value.goal.length && !(offset > 0 && offset < value.goal.length
    && /[\uD800-\uDBFF]/.test(value.goal[offset - 1]!) && /[\uDC00-\uDFFF]/.test(value.goal[offset]!));
  return value.source.spans.length === value.criteria.length && value.source.spans.every((span, index) =>
    span.start >= (value.source.spans[index - 1]?.end ?? 0) && span.start < span.end && boundary(span.start) && boundary(span.end) && value.goal.slice(span.start, span.end) === value.criteria[index]);
}, 'Criteria must preserve exact source spans and UTF-16 boundaries')
  .refine(value => bounded(value, NATIVE_CONVERSATION_INTAKE_MAX_RESPONSE_BYTES), 'Receipt exceeds byte limit');
const common = { projectId: id, requestId: id, sourceRef: nativeConversationIntakeSourceRefSchema };
export const nativeConversationIntakeResultSchema = union([
  strictObject({ kind: literal('captured'), ...common }),
  strictObject({ kind: literal('processing'), ...common, stage: enumSchema(['routing', 'extracting', 'checking', 'deciding', 'waiting']), recovery: enumSchema(['pending', 'required']) }),
  strictObject({ kind: literal('turn'), ...common, route: enumSchema(['converse', 'answer']), text }),
  strictObject({ kind: literal('blocked'), ...common, reason: enumSchema(['unsupported-source', 'missing-context']), recovery: literal('required') }),
  strictObject({ kind: literal('refused'), ...common, reason: enumSchema(['semantic', 'exhausted']) }),
  strictObject({ kind: literal('cancelled'), ...common }),
  strictObject({ kind: literal('work'), ...common, receipt: nativeConversationIntakeWorkReceiptSchema }),
]).refine(value => value.kind !== 'work' || (value.receipt.projectId === value.projectId && value.receipt.requestId === value.requestId
  && value.receipt.inputId === value.sourceRef.inputId && value.receipt.source.sourceId === value.sourceRef.sourceId
  && value.receipt.source.sourceRevision === value.sourceRef.sourceRevision && value.receipt.source.sessionId === value.sourceRef.sessionId), 'Receipt source identity mismatch')
  .refine(value => bounded(value, NATIVE_CONVERSATION_INTAKE_MAX_RESPONSE_BYTES), 'Intake result exceeds byte limit');
export const nativeConversationIntakeLookupResultSchema = union([
  nativeConversationIntakeResultSchema, strictObject({ kind: literal('not-found') }),
]).refine(value => bounded(value, NATIVE_CONVERSATION_INTAKE_MAX_RESPONSE_BYTES), 'Intake lookup exceeds byte limit');

export type NativeConversationIntakeUnsupportedSource = z.infer<typeof nativeConversationIntakeUnsupportedSourceSchema>;
export type NativeConversationIntakeCaptureRequest = z.infer<typeof nativeConversationIntakeCaptureRequestSchema>;
export type NativeConversationIntakeLookupRequest = z.infer<typeof nativeConversationIntakeLookupRequestSchema>;
export type NativeConversationIntakeTransitionRequest = z.infer<typeof nativeConversationIntakeTransitionRequestSchema>;
export type NativeConversationIntakeSourceRef = z.infer<typeof nativeConversationIntakeSourceRefSchema>;
export type NativeConversationIntakeWorkReceipt = z.infer<typeof nativeConversationIntakeWorkReceiptSchema>;
export type NativeConversationIntakeResult = z.infer<typeof nativeConversationIntakeResultSchema>;
export type NativeConversationIntakeLookupResult = z.infer<typeof nativeConversationIntakeLookupResultSchema>;
