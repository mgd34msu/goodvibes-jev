/** Host-private original-source prerequisite. No wire parser, raw store, or owner grant. */
import { createHash, randomUUID } from 'node:crypto';
import type { SharedSessionInputRecord } from './session-intents.js';

export interface NativeInboundBrokerIdentity { readonly sessionId: string; readonly inputId: string; }
export interface NativeInboundSourceRef extends NativeInboundBrokerIdentity {
  readonly sourceId: string; readonly sourceRevision: string; readonly requestId: string;
}
export interface NativeInboundOrigin {
  readonly kind: 'external-original';
  readonly accountId: string; readonly accountRevision: string;
  readonly routeId: string; readonly routeRevision: string;
}
export interface NativeInboundOriginal {
  readonly text: string;
  readonly unsupportedSources: readonly { readonly kind: string; readonly label: string }[];
}
/** Only this construction's producer can acquire and bind this nonserialized handle. */
export interface NativeInboundSourceHandle { readonly opaque: unique symbol; }
export interface NativeInboundResolvedSource {
  readonly ref: NativeInboundSourceRef; readonly origin: NativeInboundOrigin;
  readonly original: NativeInboundOriginal;
}
export interface NativeInboundSourceResolver {
  assertQueued(ref: NativeInboundSourceRef): void;
  reference(target: NativeInboundBrokerIdentity): NativeInboundSourceRef | null;
  withSource<T>(ref: NativeInboundSourceRef, use: (source: NativeInboundResolvedSource, assertCurrent: () => void, signal: AbortSignal) => Promise<T>): Promise<T>;
}
export class NativeInboundSourceError extends Error {
  constructor() { super('Original inbound source is unavailable or no longer current.'); }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sameNativeInboundSourceRef = (a: NativeInboundSourceRef, b: NativeInboundSourceRef): boolean =>
  Object.keys(a).length === 5 && Object.keys(b).length === 5 && a.sessionId === b.sessionId && a.inputId === b.inputId
  && a.sourceId === b.sourceId && a.sourceRevision === b.sourceRevision && a.requestId === b.requestId;
const key = (target: NativeInboundBrokerIdentity) => JSON.stringify([target.sessionId, target.inputId]);
// State and delivery timestamps change. The bound producer facts must not.
const brokerIdentity = (row: SharedSessionInputRecord) => hash([row.id, row.sessionId, row.intent, row.body,
  row.createdAt, row.routeId, row.surfaceKind, row.surfaceId, row.externalId, row.threadId, row.userId]);
interface Entry { readonly sourceId: string; readonly sourceRevision: string; original: NativeInboundOriginal | undefined; readonly lifetime: AbortSignal; readonly retired: AbortController; cleanup?: () => void;
  ref?: NativeInboundSourceRef; broker?: string; }

/**
 * Split the producer capability from its read-only resolver. The composition must
 * own readOriginal, broker lookup and the source's pre-existing lifetime. No
 * metadata/paired caller can construct this capability. Origin is provenance,
 * never processing, retention, or execution permission.
 */
export function createNativeInboundSourceOwner(deps: {
  readonly origin: NativeInboundOrigin;
  readonly lifetime: AbortSignal;
  /** Recheck source-read and existing retention permission, account and route incarnations. */
  readonly assertCurrent: () => void;
  readonly readBrokerInput: (target: NativeInboundBrokerIdentity) => SharedSessionInputRecord | null;
}) {
  const origin = Object.freeze({ kind: deps.origin.kind, accountId: deps.origin.accountId, accountRevision: deps.origin.accountRevision,
    routeId: deps.origin.routeId, routeRevision: deps.origin.routeRevision });
  if (origin.kind !== 'external-original' || ![origin.accountId, origin.accountRevision, origin.routeId, origin.routeRevision].every(value => typeof value === 'string' && value.length > 0)) throw new NativeInboundSourceError();
  const handles = new WeakMap<NativeInboundSourceHandle, Entry>();
  const bound = new Map<string, Entry>();
  const entries = new Set<Entry>();
  const usedInputs = new Set<string>();
  let closed = false;
  const clear = () => { closed = true; for (const entry of entries) { entry.original = undefined; entry.retired.abort(); entry.cleanup?.(); } entries.clear(); bound.clear(); };
  deps.lifetime.addEventListener('abort', clear, { once: true });
  const assertLifetime = () => {
    if (closed || deps.lifetime.aborted) throw new NativeInboundSourceError();
    try { deps.assertCurrent(); } catch { clear(); throw new NativeInboundSourceError(); }
  };
  const retire = (entry: Entry) => {
    entry.original = undefined; entry.retired.abort(); entry.cleanup?.(); entries.delete(entry);
    if (entry.ref && bound.get(key(entry.ref)) === entry) bound.delete(key(entry.ref));
  };
  const check = (entry: Entry, ref: NativeInboundSourceRef) => {
    assertLifetime();
    if (!entry.ref || !sameNativeInboundSourceRef(entry.ref, ref)) throw new NativeInboundSourceError();
    const row = deps.readBrokerInput(ref);
    if (entry.lifetime.aborted || !entry.original || !row || row.id !== ref.inputId
      || row.sessionId !== ref.sessionId || brokerIdentity(row) !== entry.broker || row.state === 'cancelled'
      || row.state === 'rejected' || row.state === 'failed') { retire(entry); throw new NativeInboundSourceError(); }
  };
  const resolver: NativeInboundSourceResolver = Object.freeze({
    assertQueued(ref: NativeInboundSourceRef) {
      const entry = bound.get(key(ref)); if (!entry) throw new NativeInboundSourceError();
      check(entry, ref); if (deps.readBrokerInput(ref)?.state !== 'queued') throw new NativeInboundSourceError();
    },
    reference(target: NativeInboundBrokerIdentity) {
      try { assertLifetime(); const entry = bound.get(key(target)); if (!entry?.ref) return null; check(entry, entry.ref); return entry.ref; }
      catch { return null; }
    },
    async withSource<T>(ref: NativeInboundSourceRef, use: (source: NativeInboundResolvedSource, assertCurrent: () => void, signal: AbortSignal) => Promise<T>): Promise<T> {
      const entry = bound.get(key(ref));
      if (!entry) throw new NativeInboundSourceError();
      const assertCurrent = () => check(entry, ref);
      assertCurrent();
      const result = await use(Object.freeze({ ref: entry.ref!, origin, original: entry.original! }), assertCurrent, AbortSignal.any([entry.lifetime, entry.retired.signal, deps.lifetime]));
      assertCurrent(); return result;
    },
  });
  return Object.freeze({
    resolver,
    producer: Object.freeze({
      release(handle: NativeInboundSourceHandle) { const entry = handles.get(handle); if (entry) retire(entry); },
      capture(readOriginal: () => NativeInboundOriginal, lifetime: AbortSignal): NativeInboundSourceHandle {
        assertLifetime(); if (lifetime.aborted) throw new NativeInboundSourceError(); // Do not even acquire original content without source permission.
        const value = readOriginal(); assertLifetime(); if (lifetime.aborted) throw new NativeInboundSourceError();
        // Keep the existing ordinary-source text ceiling; this prerequisite is not a capacity expansion.
        if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 20_000
          || !Array.isArray(value.unsupportedSources) || value.unsupportedSources.length > 100
          || value.unsupportedSources.some(item => !item || typeof item.kind !== 'string' || typeof item.label !== 'string')) throw new NativeInboundSourceError();
        const original = Object.freeze({ text: value.text, unsupportedSources: Object.freeze(value.unsupportedSources.map(item => Object.freeze({ kind: item.kind, label: item.label }))) });
        const sourceId = randomUUID();
        const entry: Entry = { sourceId, sourceRevision: hash({ origin, original }), original, lifetime, retired: new AbortController() };
        const expired = () => retire(entry);
        lifetime.addEventListener('abort', expired, { once: true });
        entry.cleanup = () => lifetime.removeEventListener('abort', expired);
        const handle = Object.freeze({}) as NativeInboundSourceHandle; handles.set(handle, entry); entries.add(entry); return handle;
      },
      bind(handle: NativeInboundSourceHandle, target: NativeInboundBrokerIdentity): NativeInboundSourceRef {
        assertLifetime(); const entry = handles.get(handle);
        if (!entry || !entry.original || entry.lifetime.aborted) throw new NativeInboundSourceError();
        const row = deps.readBrokerInput(target);
        if (!row || row.id !== target.inputId || row.sessionId !== target.sessionId || row.intent !== 'submit'
          || row.state !== 'queued') throw new NativeInboundSourceError();
        if (entry.ref) { check(entry, entry.ref); if (key(entry.ref) !== key(target)) throw new NativeInboundSourceError(); return entry.ref; }
        if (usedInputs.has(key(target))) throw new NativeInboundSourceError();
        entry.broker = brokerIdentity(row);
        entry.ref = Object.freeze({ sessionId: row.sessionId, inputId: row.id, sourceId: entry.sourceId,
          sourceRevision: entry.sourceRevision, requestId: `inbound-${hash([entry.sourceId, row.sessionId, row.id])}` });
        usedInputs.add(key(target)); bound.set(key(target), entry); return entry.ref;
      },
    }),
    close() { clear(); deps.lifetime.removeEventListener('abort', clear); },
  });
}
