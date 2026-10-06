/** Identity-only native hosted delivery. Serialized records never carry a turn permit. */
import { boolean, enum as enumSchema, literal, strictObject, string, union, type z } from 'zod/v4';
const id = string().min(1).max(200);
export const nativeHostedTurnRequestSchema = strictObject({ projectId: id, inputId: id, sourceRevision: id });
export const nativeHostedTurnSnapshotSchema = strictObject({
  projectId: id, requestId: id, inputId: id, sourceRevision: id,
  state: enumSchema(['preparing', 'queued', 'running', 'cancelling', 'completed', 'cancelled', 'recovery-required']),
  sessionId: id.nullable(), brokerInputId: id.nullable(), correlationId: id.nullable(),
}).refine(value => [value.sessionId, value.brokerInputId, value.correlationId].every(item => item === null)
  ? !['queued', 'running', 'cancelling', 'completed'].includes(value.state)
  : [value.sessionId, value.brokerInputId, value.correlationId].every(item => item !== null), 'Incomplete broker identity');
export const nativeHostedTurnLookupSchema = union([nativeHostedTurnSnapshotSchema, strictObject({ kind: literal('not-found') })]);
export type NativeHostedTurnRequest = z.infer<typeof nativeHostedTurnRequestSchema>;
export type NativeHostedTurnSnapshot = z.infer<typeof nativeHostedTurnSnapshotSchema>;
export type NativeHostedTurnLookup = z.infer<typeof nativeHostedTurnLookupSchema>;

/** Discovery cannot be fabricated from a hosted title, origin surface or browser receipt. */
export const nativeHostedSessionRequestSchema = strictObject({ sessionId: id });
export const nativeHostedSessionLookupSchema = union([
  strictObject({ kind: literal('legacy') }),
  strictObject({ kind: literal('native'), projectId: id, sessionId: id, busy: boolean() }),
]);
export type NativeHostedSessionLookup = z.infer<typeof nativeHostedSessionLookupSchema>;
