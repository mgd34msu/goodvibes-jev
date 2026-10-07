import { sameNativeInboundSourceRef } from './native-inbound-source.js';
/** Shared host-private handoff. No wire metadata can construct its source or owner. */
import type { SharedSessionContinuationRequest, SharedSessionContinuationOutcome } from './session-intents.js';
import type { NativeInboundBrokerIdentity, NativeInboundResolvedSource, NativeInboundSourceRef, NativeInboundSourceResolver } from './native-inbound-source.js';

export type NativeInboundDisposition =
  | { readonly disposition: 'held' | 'unknown'; readonly reason: string }
  | { readonly disposition: 'transferred'; readonly requestId: string }
  | { readonly disposition: 'started'; readonly agentId: string };
export interface NativeInboundAcceptance {
  readonly ref: NativeInboundSourceRef;
  /** Receiver's durable acceptance of this exact request, never a sent-request acknowledgment. */
  readonly disposition: 'transferred' | 'started';
  readonly agentId?: string;
}
/** Trusted composition capability. Pairing and source provenance alone do not satisfy this. */
export interface NativeInboundProcessingOwner {
  /** Must fence current scoped owner instruction/delegation AND processing/retention permission. */
  withCurrent<T>(source: Pick<NativeInboundResolvedSource, 'ref' | 'origin'>,
    use: (assertCurrent: () => void, ownerRevision: string, lifetime: AbortSignal) => Promise<T>): Promise<T>;
}
export interface NativeInboundReceiver {
  /** Synthetic/owned receiver only; not the owner-text native capture API. */
  accept(source: NativeInboundResolvedSource, options: { readonly signal: AbortSignal; readonly assertCurrent: () => void }): Promise<NativeInboundAcceptance>;
  /** Read-only proof lookup. Missing/ambiguous proof cannot start or replay work. */
  inspect(ref: NativeInboundSourceRef): Promise<NativeInboundAcceptance | null>;
  cancel(ref: NativeInboundSourceRef): Promise<void>;
}
const identity = (target: NativeInboundBrokerIdentity) => JSON.stringify([target.sessionId, target.inputId]);
const held = (): NativeInboundDisposition => ({ disposition: 'held', reason: 'A current original source and scoped processing/retention authority are required; this broker input is retained.' });
const unknown = (): NativeInboundDisposition => ({ disposition: 'unknown', reason: 'The original request requires receiver recovery. It was not replayed or consumed.' });
interface Attempt { readonly ref: NativeInboundSourceRef; readonly controller: AbortController;
  state: NativeInboundDisposition; ownerRevision?: string; pending?: Promise<NativeInboundDisposition> | undefined; cancelled: boolean; }

export function createNativeInboundHandoff(deps: {
  readonly sources?: NativeInboundSourceResolver;
  readonly owner?: NativeInboundProcessingOwner;
  readonly receiver?: NativeInboundReceiver;
  readonly lifetime: AbortSignal;
}) {
  const attempts = new Map<string, Attempt>();
  let closed = false;
  const stop = () => { closed = true; for (const attempt of attempts.values()) attempt.controller.abort(); };
  deps.lifetime.addEventListener('abort', stop, { once: true });
  const current = (attempt: Attempt) => {
    if (closed || deps.lifetime.aborted || attempt.controller.signal.aborted || attempt.cancelled) throw new Error('Inbound handoff is no longer current');
  };
  const fenceOwner = (attempt: Attempt, revision: string) => {
    if (!revision || (attempt.ownerRevision !== undefined && attempt.ownerRevision !== revision)) throw new Error('Inbound scoped owner changed');
    attempt.ownerRevision = revision;
  };
  const acceptance = (attempt: Attempt, result: NativeInboundAcceptance): NativeInboundDisposition => {
    current(attempt);
    if (!sameNativeInboundSourceRef(result.ref, attempt.ref)
      || (result.disposition !== 'transferred' && result.disposition !== 'started')) throw new Error('Inbound acceptance identity mismatch');
    if (result.disposition === 'started') {
      if (!result.agentId?.trim()) throw new Error('Missing owned runner identity');
      return { disposition: 'started', agentId: result.agentId };
    }
    return { disposition: 'transferred', requestId: attempt.ref.requestId };
  };
  return Object.freeze({
    async run(request: SharedSessionContinuationRequest): Promise<SharedSessionContinuationOutcome> {
      // Never read task/body or infer provenance from metadata, even for an owner-labelled sender.
      if (request.sessionId !== request.input.sessionId || request.input.intent !== 'submit') return held();
      const target = { sessionId: request.sessionId, inputId: request.input.id };
      if (closed || deps.lifetime.aborted || !deps.sources || !deps.owner || !deps.receiver) return held();
      const ref = deps.sources.reference(target);
      if (!ref) return held();
      const existing = attempts.get(identity(target));
      if (existing) {
        if (!sameNativeInboundSourceRef(existing.ref, ref)) return held();
        if (existing.pending) return existing.pending;
        // A failed wire ACK may poll again after owner/source revocation. Cached
        // acceptance is evidence, never permission to consume under a new owner.
        try {
          return await deps.sources.withSource(ref, source => deps.owner!.withCurrent({ ref: source.ref, origin: source.origin }, async (assertOwner, ownerRevision, ownerLifetime) => {
            current(existing); ownerLifetime.throwIfAborted(); assertOwner(); fenceOwner(existing, ownerRevision); return existing.state;
          }));
        } catch { return held(); } // never replay an uncertain accept
      }
      const attempt: Attempt = { ref, controller: new AbortController(), state: held(), cancelled: false };
      attempts.set(identity(target), attempt);
      let attempted = false;
      attempt.pending = deps.sources.withSource(ref, async (source, assertSource, sourceLifetime) => deps.owner!.withCurrent({ ref: source.ref, origin: source.origin }, async (assertOwner, ownerRevision, ownerLifetime) => {
        const assertCurrent = () => { current(attempt); ownerLifetime.throwIfAborted(); assertSource(); assertOwner(); fenceOwner(attempt, ownerRevision); };
        assertCurrent(); deps.sources!.assertQueued(ref);
        const signal = AbortSignal.any([attempt.controller.signal, sourceLifetime, ownerLifetime, deps.lifetime]);
        // Detach a caller promptly on expiry/cancel without claiming that an
        // uncooperative receiver drained. Its result remains unknown and pinned.
        const result = await new Promise<NativeInboundAcceptance>((resolve, reject) => {
          const abort = () => reject(new Error('Inbound source lifetime ended'));
          if (signal.aborted) { abort(); return; }
          signal.addEventListener('abort', abort, { once: true });
          void Promise.resolve().then(() => { assertCurrent(); deps.sources!.assertQueued(ref); attempted = true; attempt.state = unknown(); return deps.receiver!.accept(source, { signal, assertCurrent }); })
            .then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        });
        assertCurrent(); return acceptance(attempt, result);
      })).catch(() => attempted ? unknown() : held());
      try { attempt.state = await attempt.pending; return attempt.state; }
      finally { attempt.pending = undefined; if (!attempted && attempts.get(identity(target)) === attempt) attempts.delete(identity(target)); }
    },
    async status(target: NativeInboundBrokerIdentity): Promise<NativeInboundDisposition> {
      const attempt = attempts.get(identity(target));
      if (!attempt || !deps.sources || !deps.owner || !deps.receiver || closed || attempt.cancelled) return held();
      if (attempt.pending) return unknown();
      // Inspection can establish acceptance, but does not itself ACK the broker or invoke accept.
      try {
        attempt.state = await deps.sources.withSource(attempt.ref, source => deps.owner!.withCurrent({ ref: source.ref, origin: source.origin }, async (assertOwner, ownerRevision, ownerLifetime) => {
          current(attempt); ownerLifetime.throwIfAborted(); assertOwner(); fenceOwner(attempt, ownerRevision);
          const found = await deps.receiver!.inspect(attempt.ref);
          current(attempt); ownerLifetime.throwIfAborted(); assertOwner(); fenceOwner(attempt, ownerRevision); return found ? acceptance(attempt, found) : unknown();
        }));
        return attempt.state;
      } catch { return held(); }
    },
    async cancel(target: NativeInboundBrokerIdentity): Promise<NativeInboundDisposition> {
      const attempt = attempts.get(identity(target));
      if (!attempt || !deps.receiver) return held();
      attempt.cancelled = true; attempt.controller.abort(); attempt.state = unknown();
      try { await deps.receiver.cancel(attempt.ref); } catch { return unknown(); }
      // A cancellation request is not proof of completed handling, hence never transferred.
      return held();
    },
    close() { stop(); deps.lifetime.removeEventListener('abort', stop); },
  });
}
