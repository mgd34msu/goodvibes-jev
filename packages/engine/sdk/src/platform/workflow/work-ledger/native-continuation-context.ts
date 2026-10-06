/** Browser-safe immutable conversation evidence. A snapshot is never execution authority. */
import { array, enum as enumSchema, strictObject, string, type z } from 'zod/v4';

export const NATIVE_CONVERSATION_CONTINUATION_MAX_MESSAGES = 128;
export const NATIVE_CONVERSATION_CONTINUATION_MAX_BYTES = 131_072;
const id = string().min(1).max(200);
export const nativeConversationContinuationRefSchema = strictObject({ sessionId: id, revision: string().regex(/^[a-f0-9]{64}$/) });
export const nativeConversationContinuationMessageSchema = strictObject({ role: enumSchema(['user', 'assistant', 'system', 'tool']), content: string().max(NATIVE_CONVERSATION_CONTINUATION_MAX_BYTES) });
export const nativeConversationContinuationSchema = nativeConversationContinuationRefSchema.extend({
  messages: array(nativeConversationContinuationMessageSchema).max(NATIVE_CONVERSATION_CONTINUATION_MAX_MESSAGES).readonly(),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= NATIVE_CONVERSATION_CONTINUATION_MAX_BYTES, 'Continuation snapshot exceeds byte limit');
export type NativeConversationContinuation = Readonly<Omit<z.infer<typeof nativeConversationContinuationSchema>, 'messages'> & {
  readonly messages: readonly Readonly<z.infer<typeof nativeConversationContinuationMessageSchema>>[];
}>;

/** Inspect descriptors before any schema access; never evaluate supplied accessors. */
function data(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string') return;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Invalid native continuation context');
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) throw new Error('Invalid native continuation context');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string') || (isArray && (keys.length !== value.length + 1 || Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(value, i))))) throw new Error('Invalid native continuation context');
  seen.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new Error('Invalid native continuation context');
    if (!(isArray && key === 'length')) data(descriptor.value, seen);
  }
  seen.delete(value);
}

/** Strictly captures all available messages; exceeding bounds is refused, never truncated. */
export function captureNativeConversationContinuation(value: unknown): NativeConversationContinuation {
  data(value);
  const parsed = nativeConversationContinuationSchema.parse(value);
  return Object.freeze({ sessionId: parsed.sessionId, revision: parsed.revision,
    messages: Object.freeze(parsed.messages.map(message => Object.freeze({ ...message }))) });
}

/** The host hashes these exact bytes with SHA-256. No clock or mutable runtime metadata. */
export function canonicalNativeConversationContinuation(sessionId: string, messages: NativeConversationContinuation['messages']): string {
  return JSON.stringify({ sessionId, messages: messages.map(message => ({ role: message.role, content: message.content })) });
}
