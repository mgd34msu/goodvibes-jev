/** Host-owned question records. Acceptance records evidence only and cannot resume a runner. */
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { enum as enumSchema, literal, strictObject, string } from 'zod/v4';
import {
  NATIVE_QUESTION_MAX_QUESTION_BYTES,
  nativeQuestionIdentitySchema,
  nativeQuestionReplySchema,
  type NativeQuestionIdentity,
  type NativeQuestionReply,
} from './native-question-wire.js';

export type { NativeQuestionIdentity, NativeQuestionReply } from './native-question-wire.js';

/** Exact persisted runner admission and live-owner binding, supplied exclusively by the host. */
export interface NativeQuestionAdmission {
  readonly contractId: string;
  readonly ownerAgentId: string;
  readonly payloadRevision: string;
  readonly authorityId: string;
  readonly authorityRevision: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
}

export interface NativeQuestionRecord {
  readonly version: 1;
  readonly identity: NativeQuestionIdentity;
  readonly admission: NativeQuestionAdmission;
  readonly question: string;
  readonly checkpointId: string;
  /** Answered records are terminal in this format; cancellation never discards a receipt. */
  readonly state: 'open' | 'answered' | 'cancelled' | 'superseded';
  readonly answer: null | {
    readonly requestId: string;
    readonly answer: string;
    /** SHA-256 of the canonical complete reply, including identity and request ID. */
    readonly digest: string;
  };
}

export class NativeQuestionError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'stale' | 'not-found' | 'unsupported-authority' | 'unavailable' | 'closed') {
    super(`Native question: ${code}`);
    this.name = 'NativeQuestionError';
  }
}

const IDENTITY_FIELDS = ['projectId', 'workId', 'attemptId', 'expectedRevision', 'questionId', 'questionRevision'] as const;
const ADMISSION_FIELDS = ['contractId', 'ownerAgentId', 'payloadRevision', 'authorityId', 'authorityRevision', 'scopeId', 'scopeRevision'] as const;
const id = string().min(1).max(200);
const digest = string().regex(/^[0-9a-f]{64}$/);
const admissionSchema = strictObject({
  contractId: id, ownerAgentId: id, payloadRevision: digest,
  authorityId: digest, authorityRevision: digest, scopeId: digest, scopeRevision: digest,
});
const recordSchema = strictObject({
  version: literal(1), identity: nativeQuestionIdentitySchema, admission: admissionSchema,
  question: string().min(1).max(NATIVE_QUESTION_MAX_QUESTION_BYTES).regex(/\S/, 'Must contain non-whitespace text')
    .refine(value => value.length <= NATIVE_QUESTION_MAX_QUESTION_BYTES
      && new TextEncoder().encode(value).byteLength <= NATIVE_QUESTION_MAX_QUESTION_BYTES, 'Question exceeds byte limit'),
  checkpointId: id, state: enumSchema(['open', 'answered', 'cancelled', 'superseded']),
  answer: strictObject({ requestId: id, answer: nativeQuestionReplySchema.shape.answer, digest }).nullable(),
});

/** Reject executable or lossy object shapes before reading a single supplied property. */
function dataRecord(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new NativeQuestionError('invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== fields.length || fields.some(field => {
    const descriptor = descriptors[field];
    return !descriptor || !('value' in descriptor) || !descriptor.enumerable;
  })) throw new NativeQuestionError('invalid');
}

function identityData(value: unknown): void {
  dataRecord(value, IDENTITY_FIELDS);
  dataRecord(value['expectedRevision'], ['work', 'criteria', 'attempt']);
}

function freezeIdentity(value: NativeQuestionIdentity): NativeQuestionIdentity {
  Object.freeze(value.expectedRevision);
  return Object.freeze(value);
}

export function parseNativeQuestionIdentity(value: unknown): NativeQuestionIdentity {
  try {
    identityData(value);
    return freezeIdentity(nativeQuestionIdentitySchema.parse(value));
  } catch { throw new NativeQuestionError('invalid'); }
}

export function parseNativeQuestionReply(value: unknown): NativeQuestionReply {
  try {
    dataRecord(value, [...IDENTITY_FIELDS, 'requestId', 'answer']);
    dataRecord(value['expectedRevision'], ['work', 'criteria', 'attempt']);
    const parsed = nativeQuestionReplySchema.parse(value);
    Object.freeze(parsed.expectedRevision);
    return Object.freeze(parsed);
  } catch { throw new NativeQuestionError('invalid'); }
}

/** Schema field order is canonical and deliberately independent of the caller's property order. */
function replyDigest(reply: NativeQuestionReply): string {
  return createHash('sha256').update(JSON.stringify(reply)).digest('hex');
}

/** Validate persisted bytes as data; a valid record still conveys no live authority. */
export function parseNativeQuestionRecord(value: unknown): NativeQuestionRecord {
  try {
    dataRecord(value, ['version', 'identity', 'admission', 'question', 'checkpointId', 'state', 'answer']);
    identityData(value['identity']);
    dataRecord(value['admission'], ADMISSION_FIELDS);
    if (value['answer'] !== null) dataRecord(value['answer'], ['requestId', 'answer', 'digest']);
    const parsed = recordSchema.parse(value);
    if ((parsed.state === 'answered') !== (parsed.answer !== null)) throw new NativeQuestionError('invalid');
    if (parsed.answer !== null) {
      const reply = parseNativeQuestionReply({ ...parsed.identity, requestId: parsed.answer.requestId, answer: parsed.answer.answer });
      if (parsed.answer.digest !== replyDigest(reply)) throw new NativeQuestionError('invalid');
      Object.freeze(parsed.answer);
    }
    freezeIdentity(parsed.identity);
    Object.freeze(parsed.admission);
    return Object.freeze(parsed);
  } catch { throw new NativeQuestionError('invalid'); }
}

function sameIdentity(left: NativeQuestionIdentity, right: NativeQuestionIdentity): boolean {
  return left.projectId === right.projectId && left.workId === right.workId && left.attemptId === right.attemptId
    && left.questionId === right.questionId && left.questionRevision === right.questionRevision
    && left.expectedRevision.work === right.expectedRevision.work
    && left.expectedRevision.criteria === right.expectedRevision.criteria
    && left.expectedRevision.attempt === right.expectedRevision.attempt;
}

/**
 * Pure open-to-answered reduction. The storage owner enforces cross-question request-ID
 * uniqueness and rechecks current source and persisted admission bindings in its transaction.
 * A live producer/checkpoint-consumption handshake is not implemented here.
 * An exact replay preserves the original receipt and requests no persistence mutation.
 */
export function acceptNativeQuestionReply(record: NativeQuestionRecord, reply: NativeQuestionReply): {
  readonly next: NativeQuestionRecord | null;
  readonly value: NativeQuestionRecord;
} {
  const current = parseNativeQuestionRecord(record);
  const request = parseNativeQuestionReply(reply);
  if (!sameIdentity(current.identity, request)) throw new NativeQuestionError('stale');
  if (current.state === 'answered') {
    if (current.answer?.requestId !== request.requestId || current.answer.answer !== request.answer) throw new NativeQuestionError('conflict');
    return { next: null, value: current };
  }
  if (current.state !== 'open') throw new NativeQuestionError('stale');
  const next = parseNativeQuestionRecord({
    ...current, state: 'answered',
    answer: { requestId: request.requestId, answer: request.answer, digest: replyDigest(request) },
  });
  return { next, value: next };
}
