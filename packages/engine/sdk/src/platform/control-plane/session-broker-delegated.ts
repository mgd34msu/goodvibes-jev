/** Host-process capabilities only. No wire registration and no serialized grant. */
import { sameNativeInboundSourceRef, type NativeInboundSourceRef } from './native-inbound-source.js';
import { SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY, isDelegatedSessionInput, type SharedSessionInputRecord } from './session-intents.js';
import type { SharedSessionSubmission, SubmitSharedSessionMessageInput } from './session-types.js';

export interface DelegatedSessionInputBinding {
  readonly ref: NativeInboundSourceRef;
  readonly assertCurrent: () => void;
}
export interface DelegatedSessionTransferReceipt {
  readonly ref: NativeInboundSourceRef;
  readonly disposition: 'transferred';
  readonly requestId: string;
}
export interface DelegatedSessionSubmission {
  readonly submission: SharedSessionSubmission;
  /** The host calls this only after verifying the receiver's exact-source proof. */
  readonly complete: (receipt: DelegatedSessionTransferReceipt) => Promise<SharedSessionInputRecord>;
}

function assertSynchronousCurrent(binding: DelegatedSessionInputBinding): void {
  const result: unknown = binding.assertCurrent();
  if (result !== null && (typeof result === 'object' || typeof result === 'function')
    && 'then' in result && typeof result.then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new Error('Delegated input currentness assertion must be synchronous');
  }
}

export async function submitDelegatedSessionMessage(
  deps: {
    readonly submit: (input: SubmitSharedSessionMessageInput, onQueued: (input: SharedSessionInputRecord) => void) => Promise<SharedSessionSubmission>;
    readonly read: (sessionId: string, inputId: string) => SharedSessionInputRecord | null;
    readonly complete: (sessionId: string, inputId: string) => Promise<SharedSessionInputRecord>;
  },
  input: SubmitSharedSessionMessageInput,
  onQueued: (input: SharedSessionInputRecord) => DelegatedSessionInputBinding,
): Promise<DelegatedSessionSubmission> {
  if (typeof onQueued !== 'function') throw new Error('Delegated input requires a synchronous host binder');
  let binding: DelegatedSessionInputBinding | undefined;
  let canonical: SharedSessionInputRecord | undefined;
  // The caller supplies a safe placeholder, never original source text. Capture
  // caller data before the first await so later mutation cannot change the row.
  const captured = structuredClone(input);
  const submission = await deps.submit({ ...captured,
    metadata: { ...captured.metadata, [SHARED_SESSION_DELEGATED_INPUT_METADATA_KEY]: true },
  }, row => {
    const value = onQueued(row);
    // A JavaScript caller can violate the synchronous type. Observe rejection
    // without waiting for it, and reject before publication or dispatch.
    if (value instanceof Promise) void value.catch(() => {});
    if (!value || typeof value.assertCurrent !== 'function' || !value.ref
      || value.ref.sessionId !== row.sessionId || value.ref.inputId !== row.id
      || ![value.ref.sourceId, value.ref.sourceRevision, value.ref.requestId].every(part => typeof part === 'string' && part.trim())
      || !sameNativeInboundSourceRef(value.ref, value.ref)) throw new Error('Invalid delegated input binding');
    assertSynchronousCurrent(value);
    binding = Object.freeze({ ref: Object.freeze({ ...value.ref }), assertCurrent: value.assertCurrent });
    canonical = structuredClone(row);
  });
  if (!binding || !canonical) throw new Error('Delegated input was not bound');
  const trusted = binding;
  const original = canonical;
  assertSynchronousCurrent(trusted);
  let completion: Promise<SharedSessionInputRecord> | undefined;
  return Object.freeze({ submission: structuredClone(submission), complete: async (receipt: DelegatedSessionTransferReceipt) => {
    if (!receipt || receipt.disposition !== 'transferred' || !receipt.ref
      || !sameNativeInboundSourceRef(receipt.ref, trusted.ref)
      || receipt.requestId !== trusted.ref.requestId) throw new Error('Delegated input transfer does not match its bound source');
    assertSynchronousCurrent(trusted);
    if (!completion) {
      const current = deps.read(original.sessionId, original.id);
      if (!current || !isDelegatedSessionInput(current) || current.state !== 'queued'
        || JSON.stringify(current) !== JSON.stringify(original)) throw new Error('Delegated input is no longer queued and current');
      completion = deps.complete(original.sessionId, original.id);
    }
    return structuredClone(await completion);
  } });
}
