/** Transport data only. A question reply never grants execution or continuation authority. */
import { number, strictObject, string, type z } from 'zod/v4';

export const NATIVE_QUESTION_MAX_REQUEST_BYTES = 32_768;
export const NATIVE_QUESTION_MAX_ANSWER_BYTES = 16_384;
export const NATIVE_QUESTION_MAX_QUESTION_BYTES = 16_384;

const id = string().min(1).max(200);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** Preserve exact text, including whitespace, while bounding its UTF-8 representation. */
const answer = string().min(1).max(NATIVE_QUESTION_MAX_ANSWER_BYTES).regex(/\S/, 'Must contain non-whitespace text')
  .refine(value => value.length <= NATIVE_QUESTION_MAX_ANSWER_BYTES
    && new TextEncoder().encode(value).byteLength <= NATIVE_QUESTION_MAX_ANSWER_BYTES, 'Answer exceeds byte limit');

/** An existing host-owned checkpoint identity; callers cannot supply its admission binding. */
export const nativeQuestionIdentitySchema = strictObject({
  projectId: id, workId: id, attemptId: id,
  expectedRevision: strictObject({ work: revision, criteria: revision, attempt: revision }),
  questionId: id, questionRevision: revision,
});

export const nativeQuestionReplySchema = strictObject({
  ...nativeQuestionIdentitySchema.shape, requestId: id, answer,
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= NATIVE_QUESTION_MAX_REQUEST_BYTES,
  'Question reply exceeds byte limit');

export type NativeQuestionIdentity = z.infer<typeof nativeQuestionIdentitySchema>;
export type NativeQuestionReply = z.infer<typeof nativeQuestionReplySchema>;
