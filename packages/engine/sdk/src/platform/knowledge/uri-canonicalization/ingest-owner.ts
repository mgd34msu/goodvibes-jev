import { types as nodeTypes } from 'node:util';
import type { KnowledgeIngestContext, KnowledgeIngestOwnership } from '../ingest-context.js';
import { knowledgeIngestGuard } from '../ingest-preparation.js';
import { supportHash } from '../semantic/verification/projection.js';
import { createKnowledgeUriCanonicalizer, KnowledgeUriCanonicalizationHeldError as Held, type KnowledgeUriCanonicalizer } from './reader.js';

/** Retain the actual consumed host slots without invoking a replacement getter. */
function retainSlots(subject: object, keys: readonly string[]) {
  const inspect = () => {
    const chain: object[] = []; let owner: object | null = subject;
    while (owner !== null) {
      if (nodeTypes.isProxy(owner) || chain.length >= 64) throw new Held('stale');
      chain.push(owner); owner = Object.getPrototypeOf(owner);
    }
    return { chain, slots: keys.map((key) => {
      for (const owner of chain) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (descriptor) {
          if (!('value' in descriptor)) throw new Held('stale');
          return { owner, descriptor };
        }
      }
      return undefined;
    }) };
  };
  const original = inspect();
  return () => {
    const current = inspect();
    if (current.chain.length !== original.chain.length || original.chain.some((owner, index) => current.chain[index] !== owner)) throw new Held('stale');
    original.slots.forEach((prior, index) => {
      const next = current.slots[index];
      if ((prior === undefined) !== (next === undefined) || prior?.owner !== next?.owner || prior?.descriptor.value !== next?.descriptor.value
        || prior?.descriptor.writable !== next?.descriptor.writable || prior?.descriptor.enumerable !== next?.descriptor.enumerable
        || prior?.descriptor.configurable !== next?.descriptor.configurable) throw new Held('stale');
    });
  };
}
/** A native ingest operation; a structural reader cannot authorize its handoff. */
export interface KnowledgeIngestUriCanonicalizer extends KnowledgeUriCanonicalizer {
  readonly signal: AbortSignal;
  readonly reserveSource: (sourceId: string, canonicalUri?: string) => void;
  readonly attachArtifact: (artifactId: string) => void;
}
type OperationState =
  | { readonly phase: 'reading' | 'retired' }
  | { readonly phase: 'reserved'; readonly sourceId: string }
  | { readonly phase: 'attached' | 'preparing'; readonly sourceId: string; readonly artifactId: string }
  | { readonly phase: 'prepared' | 'publishing'; readonly sourceId: string; readonly artifactId: string; readonly token: object };
interface IngestUriOperation {
  readonly context: KnowledgeIngestContext;
  readonly store: KnowledgeIngestContext['store'];
  readonly artifacts: KnowledgeIngestContext['artifactStore'];
  assertCurrent: () => void;
  readonly retire: () => void;
  state: OperationState;
}
const operations = new WeakMap<object, IngestUriOperation>();

/** Authenticate the exact object before reading or invoking any supplied method. */
function retainedOperation(context: KnowledgeIngestContext, uris: KnowledgeIngestUriCanonicalizer,
  sourceId: string, artifactId: string, token?: object): IngestUriOperation {
  const operation = operations.get(uris);
  if (!operation || operation.context !== context) throw new Held('stale');
  const state = operation.state;
  if ((state.phase !== 'attached' && state.phase !== 'preparing' && state.phase !== 'prepared' && state.phase !== 'publishing')
    || state.sourceId !== sourceId || state.artifactId !== artifactId
    || (token !== undefined && (!('token' in state) || state.token !== token))) throw new Held('stale');
  // The retained native check validates host descriptors before their values are read.
  operation.assertCurrent(); return operation;
}
export function assertKnowledgeIngestUriOperation(context: KnowledgeIngestContext,
  uris: KnowledgeIngestUriCanonicalizer, sourceId: string, artifactId: string, token?: object): void {
  retainedOperation(context, uris, sourceId, artifactId, token);
}
export function beginKnowledgeUriPreparation(context: KnowledgeIngestContext,
  uris: KnowledgeIngestUriCanonicalizer, sourceId: string, artifactId: string): void {
  const operation = retainedOperation(context, uris, sourceId, artifactId), state = operation.state;
  if (state.phase !== 'attached') throw new Held('stale');
  operation.state = { ...state, phase: 'preparing' };
}
export function completeKnowledgeUriPreparation(context: KnowledgeIngestContext,
  uris: KnowledgeIngestUriCanonicalizer, sourceId: string, artifactId: string, token: object): void {
  const operation = retainedOperation(context, uris, sourceId, artifactId), state = operation.state;
  if (state.phase !== 'preparing') throw new Held('stale');
  operation.state = { ...state, phase: 'prepared', token };
}
export function cancelKnowledgeUriPreparation(uris: KnowledgeIngestUriCanonicalizer): void {
  const operation = operations.get(uris);
  // A failed ordinary parse can still use the existing guarded diagnostic path.
  if (operation?.state.phase === 'preparing') operation.state = { ...operation.state, phase: 'attached' };
}
export function consumeKnowledgeUriPreparation(context: KnowledgeIngestContext,
  uris: KnowledgeIngestUriCanonicalizer, sourceId: string, artifactId: string, token: object): void {
  const operation = retainedOperation(context, uris, sourceId, artifactId, token), state = operation.state;
  if (state.phase !== 'prepared') throw new Held('stale');
  operation.state = { ...state, phase: 'publishing' };
}
export function retireKnowledgeIngestUriOperation(uris: KnowledgeIngestUriCanonicalizer): void {
  operations.get(uris)?.retire();
}

export function createKnowledgeIngestUriCanonicalizer(context: KnowledgeIngestContext, ownership: KnowledgeIngestOwnership = {},
  assertSourceCurrent?: () => void, callerSignal: AbortSignal | undefined = ownership.signal): KnowledgeIngestUriCanonicalizer {
  const hostSlots = retainSlots(context, ['store', 'artifactStore']), callerSlots = retainSlots(ownership, ['signal', 'assertCurrent', 'onCommitted', 'deferSemanticEnrichment']);
  const store = context.store, artifacts = context.artifactStore, callerCurrent = ownership.assertCurrent;
  const storeSlots = retainSlots(store, ['init', 'getSource', 'getExtractionBySourceId', 'getSourceByCanonicalUri', 'applyPreparedIngest', 'upsertSource', 'upsertExtraction', 'upsertEdge', 'prepareNodeWrites', 'upsertPreparedNode']),
    artifactSlots = retainSlots(artifacts, ['getRecord', 'readContent', 'create']);
  const controller = new AbortController(), signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  let assertObjectCurrent = () => {}, assertReservationCurrent = () => {}, assertArtifactCurrent = () => {};
  const settledUris = new Set<string>();
  const operation: IngestUriOperation = { context, store, artifacts, state: { phase: 'reading' }, assertCurrent: () => assertCurrent(), retire() {
    operation.state = { phase: 'retired' }; controller.abort();
  } };
  const assertCurrent = () => {
    if (operation.state.phase === 'retired') throw new Held('stale');
    hostSlots(); callerSlots(); storeSlots(); artifactSlots(); assertObjectCurrent(); signal.throwIfAborted();
    const result: unknown = callerCurrent?.();
    if (result !== undefined) { try { void Promise.resolve(result).catch(() => {}); } catch {} throw new Held('stale'); }
    const sourceResult: unknown = assertSourceCurrent?.();
    if (sourceResult !== undefined) { try { void Promise.resolve(sourceResult).catch(() => {}); } catch {} throw new Held('stale'); }
    assertReservationCurrent(); assertArtifactCurrent();
    hostSlots(); callerSlots(); storeSlots(); artifactSlots(); assertObjectCurrent(); signal.throwIfAborted();
  };
  const reader = createKnowledgeUriCanonicalizer({ signal, assertCurrent });
  const uris: KnowledgeIngestUriCanonicalizer = Object.freeze({ signal, assertCurrent: reader.assertCurrent,
    async canonicalize(input: string) {
      const result = await reader.canonicalize(input);
      reader.assertCurrent(); if (result !== null) settledUris.add(result); return result;
    },
    async canonicalizeAll(inputs: readonly string[]) {
      const results = await reader.canonicalizeAll(inputs);
      reader.assertCurrent(); for (const result of results) if (result !== null) settledUris.add(result); return results;
    },
    reserveSource(sourceId: string, canonicalUri?: string) {
      reader.assertCurrent();
      if (operation.state.phase !== 'reading' || typeof sourceId !== 'string' || sourceId.length === 0
        || (canonicalUri !== undefined && !settledUris.has(canonicalUri))) throw new Held('stale');
      assertReservationCurrent = knowledgeIngestGuard(context, sourceId, canonicalUri, signal);
      assertReservationCurrent(); operation.state = { phase: 'reserved', sourceId };
    },
    attachArtifact(artifactId: string) {
      reader.assertCurrent();
      const state = operation.state;
      if (state.phase !== 'reserved' || typeof artifactId !== 'string' || artifactId.length === 0) throw new Held('stale');
      const record = artifacts.getRecord(artifactId);
      if (!record || record.id !== artifactId) throw new Held('stale');
      const retained = supportHash(record);
      assertArtifactCurrent = () => { if (supportHash(artifacts.getRecord(artifactId)) !== retained) throw new Held('stale'); };
      assertArtifactCurrent(); operation.state = { phase: 'attached', sourceId: state.sourceId, artifactId };
    },
  });
  assertObjectCurrent = retainSlots(uris, ['signal', 'assertCurrent', 'canonicalize', 'canonicalizeAll', 'reserveSource', 'attachArtifact']);
  // Preserve the native reading's port installation and input lifetime at every handoff.
  operation.assertCurrent = reader.assertCurrent;
  operations.set(uris, operation);
  return uris;
}
