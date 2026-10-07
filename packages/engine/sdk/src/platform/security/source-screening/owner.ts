import { createSystemOnePort, type JudgmentRetryProgress } from '@goodvibes-jev/judgment';
import { types as nodeTypes } from 'node:util';
import { JudgmentInputError } from '../../gate/judgment-input.js';
import { captureScreeningSource, isMalformedScreeningProposal, proposeScreeningSpans, type ScreeningSource, type ScreeningSpan } from './proposal.js';
import { captureLoopbackEndpoint, createScreeningTransport } from './transport.js';
import { verifyScreeningSpans } from './verification.js';
import { captureResearchReference, createResearchReferenceReader, WITHHELD_RESEARCH_REFERENCE, type CapturedResearchReference } from './reference.js';
import { SOURCE_SCREENING_LIMITS as LIMITS, type ProtectedSource, type ProtectedSourceOwner, type ProtectedSourceOwnerOptions,
  type SourceScreeningReceipt, type SourceScreeningResult, type ProtectedResearchReference,
  type ResearchReferenceScreeningReceipt, type ResearchReferenceScreeningResult } from './types.js';

type Handle = ProtectedSource | ProtectedResearchReference;
type Receipt = SourceScreeningReceipt | ResearchReferenceScreeningReceipt;
type Result = { readonly status: 'settled'; readonly receipt: Receipt } | Extract<SourceScreeningResult, { status: 'held' }>;

interface OwnedSource {
  readonly source: ScreeningSource;
  readonly reference?: CapturedResearchReference;
  readonly lifetime: AbortController;
  released: boolean;
  pending?: Promise<Result>;
  result?: Result;
}
interface OwnedProjection { readonly source: OwnedSource; readonly parts: readonly string[]; }
const held = (reason: Extract<SourceScreeningResult, { status: 'held' }>['reason']): Extract<SourceScreeningResult, { status: 'held' }> => Object.freeze({ status: 'held', reason });
const invalid = (): never => { throw new Error('Protected source owner is unavailable or the handle is not current'); };
function reference(value: unknown): value is string { return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value); }
function project(source: ScreeningSource, spans: readonly ScreeningSpan[]): readonly string[] {
  return Object.freeze(source.parts.map((text, part) => {
    let result = '', position = 0;
    for (const span of spans.filter(span => span.part === part)) {
      result += text.slice(position, span.start) + '[redacted]'; position = span.end;
    }
    return result + text.slice(position);
  }));
}

/**
 * Explicit trusted-host composition only. Loopback is destination containment,
 * not evidence of service retention behavior or permission to read a source.
 * No settings/env discovery, hosted fallback, persistent source, or raw log.
 */
export function createProtectedSourceOwner(options: ProtectedSourceOwnerOptions): ProtectedSourceOwner {
  const { authority } = options;
  const ownerId = authority.ownerId, authorityRevision = authority.revision;
  const parentSignal = authority.signal, assertAuthority = authority.assertCurrent;
  if (!reference(ownerId) || !reference(authorityRevision) || authority.retention !== 'ephemeral-no-log'
    || typeof assertAuthority !== 'function' || !(parentSignal instanceof AbortSignal)) return invalid();
  const proposal = Object.freeze({ endpoint: captureLoopbackEndpoint(options.proposal.endpoint), model: options.proposal.model });
  const judgment = Object.freeze({ endpoint: captureLoopbackEndpoint(options.judgment.endpoint), model: options.judgment.model });
  if (!reference(proposal.model) || judgment.model !== 'jev-1.13.0') return invalid();
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || (options.onRetry !== undefined && typeof options.onRetry !== 'function')) return invalid();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([parentSignal, lifetime.signal]);
  const sources = new Map<Handle, OwnedSource>();
  const projections = new Map<Receipt, OwnedProjection>();
  const referenceReader = createResearchReferenceReader();
  // Refusal-only fingerprints survive mapper-handle release, without raw text.
  const unsettled = new Set<string>();
  const screening = new Set<string>();
  const work = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const active = () => {
    if (signal.aborted) return invalid();
    let result: unknown;
    try { result = assertAuthority(); } catch { return invalid(); }
    if (result !== undefined) {
      // Refuse async authority without exposing an unhandled rejection or
      // inspecting hostile thenable/error properties.
      if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      return invalid();
    }
    if (signal.aborted) return invalid();
  };
  active();
  const retry = options.onRetry;
  const onRetry = retry ? (progress: JudgmentRetryProgress) => {
    active();
    // Canonical retry owns any returned observer promise and rechecks authority
    // before the next attempt. Do not discard rejected asynchronous observers.
    return retry(Object.freeze({ ...progress }));
  } : undefined;
  const own = <T>(pending: Promise<T>): Promise<T> => {
    work.add(pending); void pending.then(() => work.delete(pending), () => work.delete(pending)); return pending;
  };
  const current = (source: OwnedSource) => { active(); if (source.released || source.lifetime.signal.aborted) return invalid(); };
  const run = async (source: OwnedSource): Promise<Result> => {
    const requestSignal = AbortSignal.any([signal, source.lifetime.signal]);
    const assertCurrent = () => current(source);
    let transport: ReturnType<typeof createScreeningTransport> | undefined;
    try {
      current(source);
      transport = createScreeningTransport({ endpoints: [`${proposal.endpoint}/v1/chat/completions`, `${judgment.endpoint}/v1/systemone`],
        signal: requestSignal, assertCurrent, timeoutMs });
      const ownedTransport = transport;
      const assertRoute = () => { current(source); ownedTransport.assertUsable(); };
      const port = createSystemOnePort({ endpoint: { kind: 'local', baseURL: judgment.endpoint, apiKey: 'source-screening-local' },
        model: judgment.model, timeoutMs, retry: {}, fetch: ownedTransport.fetch });
      let parts: readonly string[];
      if (source.reference) {
        const result = await referenceReader.read(source.reference, { port, signal: requestSignal, assertCurrent: assertRoute, onRetry });
        if (result.status === 'held') {
          if (result.reason === 'unsettled') unsettled.add(source.source.revision);
          return result.reason === 'unsettled' ? source.result = held(result.reason) : held(result.reason);
        }
        parts = Object.freeze([result.value]);
      } else {
        const spans = await proposeScreeningSpans(source.source, { ...proposal, fetch: transport.fetch, signal: requestSignal, assertCurrent });
        const settled = await verifyScreeningSpans(source.source, spans, { port, signal: requestSignal, assertCurrent: assertRoute, onRetry });
        if (!settled) { unsettled.add(source.source.revision); return source.result = held('unsettled'); }
        parts = project(source.source, spans);
      }
      current(source);
      const receipt = Object.freeze({}) as Receipt;
      projections.set(receipt, { source, parts });
      return source.result = Object.freeze({ status: 'settled', receipt });
    } catch (error) {
      if (requestSignal.aborted) return held('cancelled');
      try { current(source); } catch { return held('stale'); }
      if (isMalformedScreeningProposal(error)) return held('malformed');
      let protectedInput = false;
      try { protectedInput = error instanceof JudgmentInputError; } catch { /* Do not inspect hostile rejections. */ }
      return held(protectedInput ? 'protected-input' : 'route-unavailable');
    } finally { await transport?.close(); }
  };
  const screen = (source: OwnedSource): Promise<Result> => {
    try { current(source); } catch { return Promise.resolve(held(signal.aborted ? 'cancelled' : 'stale')); }
    if (source.pending) return source.pending;
    if (unsettled.has(source.source.revision)) return Promise.resolve(held('unsettled'));
    if (source.result) return Promise.resolve(source.result);
    if (screening.has(source.source.revision)) return Promise.resolve(held('busy'));
    // Reserve future refusal slots before admitting any asynchronous work.
    if (unsettled.size + screening.size >= LIMITS.unsettledRevisions) return Promise.resolve(held('capacity'));
    screening.add(source.source.revision);
    const pending = own(Promise.resolve().then(() => run(source)));
    source.pending = pending;
    const finished = () => { screening.delete(source.source.revision); if (source.pending === pending) delete source.pending; };
    void pending.then(finished, finished);
    return pending;
  };
  return {
    capture(parts) {
      active(); const source = captureScreeningSource(parts); active();
      if (sources.size >= LIMITS.sources) return invalid();
      const handle = Object.freeze({}) as ProtectedSource;
      sources.set(handle, { source, lifetime: new AbortController(), released: false }); return handle;
    },
    captureResearchReference(value) {
      active();
      // Capture the complete actual original before parsing, bounds or hashing.
      const captured = captureScreeningSource([value]);
      const reference = captureResearchReference(captured.parts[0]!);
      active();
      if (sources.size >= LIMITS.sources) return invalid();
      // Equal text in display-preview mode cannot borrow reference authority.
      const source = Object.freeze({ ...captured, revision: `reference:${captured.revision}` });
      const handle = Object.freeze({}) as ProtectedResearchReference;
      sources.set(handle, { source, reference, lifetime: new AbortController(), released: false }); return handle;
    },
    screen(handle) {
      const source = sources.get(handle);
      if (!source || source.reference) return Promise.resolve(held('stale'));
      return screen(source) as Promise<SourceScreeningResult>;
    },
    screenResearchReference(handle) {
      const source = sources.get(handle);
      if (!source?.reference) return Promise.resolve(held('stale'));
      return screen(source) as Promise<ResearchReferenceScreeningResult>;
    },
    project(receipt) {
      const entry = projections.get(receipt);
      if (!entry || entry.source.reference || unsettled.has(entry.source.source.revision)) return invalid();
      current(entry.source); return entry.parts;
    },
    projectResearchReference(receipt) {
      const entry = projections.get(receipt);
      if (!entry?.source.reference || unsettled.has(entry.source.source.revision)) return invalid();
      current(entry.source);
      return entry.parts[0] === WITHHELD_RESEARCH_REFERENCE ? Object.freeze({ status: 'omitted' })
        : Object.freeze({ status: 'preserved', url: entry.parts[0]! });
    },
    release(handle) {
      const source = sources.get(handle); if (!source) return Promise.resolve();
      source.released = true; source.lifetime.abort();
      return own(Promise.resolve(source.pending).then(() => {
        sources.delete(handle);
        for (const [receipt, entry] of projections) if (entry.source === source) projections.delete(receipt);
      }));
    },
    close() {
      if (closing) return closing;
      const finish = Promise.withResolvers<void>(); closing = finish.promise;
      lifetime.abort();
      void Promise.allSettled([...work]).then(() => { sources.clear(); projections.clear(); unsettled.clear(); screening.clear(); referenceReader.clear(); finish.resolve(); });
      return closing;
    },
  };
}
