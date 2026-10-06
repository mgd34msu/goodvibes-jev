/** Host-owned conversation input and durable intake progress, never execution authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { array, enum as enumSchema, literal, number, strictObject, string } from 'zod/v4';
import { captureJevDecisionContext, validateJevDecision, type JevDecision, type JevDecisionContext, type JevDecisionBinding } from '@goodvibes-jev/judgment/decisions';
import { captureNativeConversationContinuation, canonicalNativeConversationContinuation, nativeConversationContinuationSchema, type NativeConversationContinuation } from './native-continuation-context.js';
import type { WorkLedgerStorage, WorkLedgerSubmission } from './types.js';

export const NATIVE_CONVERSATION_MAX_PROPOSALS = 3;
export const NATIVE_CONVERSATION_MAX_DECISIONS = 32;
export const NATIVE_CONVERSATION_MAX_RECORD_BYTES = 1_048_576;
export interface NativeConversationKey { readonly principalId: string; readonly inputId: string; }
export interface NativeConversationUnsupportedSource { readonly kind: 'image' | 'file' | 'context'; readonly label: string; }
export interface NativeConversationSpan { readonly partId: 'input'; readonly start: number; readonly end: number; }
export interface NativeConversationProposal { readonly sourceRevision: string; readonly spans: readonly NativeConversationSpan[]; }
export interface NativeConversationOwner {
  readonly authorityId: string; readonly authorityRevision: string; readonly authorityScopes: readonly string[];
  readonly scopeId: string; readonly scopeRevision: string; readonly projectRoot: string;
}
export interface NativeConversationDecision { readonly decision: JevDecision; readonly context: JevDecisionContext; }
export interface NativeConversationAssociation { readonly workId: string; readonly attemptId: string; readonly ledgerRevision: number; }
export interface NativeConversationCapture extends NativeConversationKey {
  readonly version: 1; readonly projectId: string; readonly requestId: string;
  readonly text: string; readonly continuation?: NativeConversationContinuation | undefined; readonly unsupportedSources: readonly NativeConversationUnsupportedSource[];
  readonly sourceId: string; readonly sourceRevision: string; readonly sessionId: string; readonly owner: NativeConversationOwner;
  readonly generation: number; readonly state: 'captured' | 'processing' | 'turn' | 'blocked' | 'refused' | 'associated' | 'cancelled';
  readonly stage: 'routing' | 'extracting' | 'checking' | 'deciding' | 'waiting' | null;
  readonly route: 'converse' | 'answer' | 'contract' | null;
  readonly reason: 'unsupported-source' | 'missing-context' | 'semantic' | 'exhausted' | null;
  readonly proposalsSpent: number; readonly proposal: NativeConversationProposal | null;
  readonly decisions: readonly NativeConversationDecision[]; readonly association: NativeConversationAssociation | null;
}
export interface NativeConversationMutation<T> { readonly next: NativeConversationCapture | null; readonly value: T; }
export interface NativeConversationPublicationStorage extends WorkLedgerStorage { close(): Promise<void>; }
export interface NativeConversationStorage {
  current(key: NativeConversationKey): NativeConversationCapture | null;
  transaction<T>(key: NativeConversationKey, decide: (current: NativeConversationCapture | null) => NativeConversationMutation<T>): Promise<T>;
  /** The ordinary ledger reducer and source association share one SQLite publication. */
  publicationStorage(key: NativeConversationKey, assertCurrent: (capture: NativeConversationCapture) => void,
    finish: (capture: NativeConversationCapture, event: WorkLedgerSubmission) => NativeConversationCapture): NativeConversationPublicationStorage;
  close(): Promise<void>;
}
export class NativeConversationStorageError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'cancelled' | 'not-found' | 'closed' | 'unavailable') {
    super(`Native conversation storage: ${code}`); this.name = 'NativeConversationStorageError';
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function nativeConversationSourceId(projectId: string, principalId: string, inputId: string): string { return hash({ projectId, principalId, inputId }); }
export function nativeConversationSourceRevision(value: Pick<NativeConversationCapture, 'inputId' | 'text' | 'unsupportedSources' | 'continuation'>): string {
  return hash({ version: 1, inputId: value.inputId, text: value.text, ...(value.continuation ? { continuation: value.continuation } : {}), unsupportedSources: value.unsupportedSources.map(source => ({ kind: source.kind, label: source.label })) });
}
export function nativeConversationProposalRevision(proposal: NativeConversationProposal): string {
  return hash({ sourceRevision: proposal.sourceRevision, spans: proposal.spans.map(span => ({ partId: span.partId, start: span.start, end: span.end })) });
}
export function nativeConversationDecisionBinding(capture: NativeConversationCapture, operation: 'routing' | 'publish-work' | 'ordinary-turn'): JevDecisionBinding {
  return {
    sourceId: capture.sourceId, inputRevision: capture.sourceRevision,
    actionId: hash({ sourceId: capture.sourceId, action: 'native-conversation-admission' }),
    actionRevision: hash({ operation, generation: capture.generation, proposalsSpent: capture.proposalsSpent, proposal: capture.proposal ? nativeConversationProposalRevision(capture.proposal) : null }),
    authorityId: hash({ pairedPrincipal: capture.owner.authorityId }), authorityRevision: hash({ pairedIncarnation: capture.owner.authorityRevision }),
    scopeId: hash({ workspaceScope: capture.owner.scopeId }), scopeRevision: hash({ workspaceGeneration: capture.owner.scopeRevision }),
  };
}
const id = string().min(1).max(200);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeConversationSpanSchema = strictObject({ partId: literal('input'), start: revision, end: revision });
const proposalSchema = strictObject({ sourceRevision: id, spans: array(nativeConversationSpanSchema).min(1).max(100) });
/** Strict data capture rejects getters, symbols, proxies, sparse arrays and exotic prototypes. */
function plain(value: unknown, active = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || nodeTypes.isProxy(value) || active.has(value)) throw new NativeConversationStorageError('invalid');
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) throw new NativeConversationStorageError('invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string') || (isArray && (keys.length !== value.length + 1 || Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(value, i))))) throw new NativeConversationStorageError('invalid');
  active.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new NativeConversationStorageError('invalid');
    plain(descriptor.value, active);
  }
  active.delete(value);
}
function splitsSurrogate(text: string, offset: number): boolean {
  const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}
/** Offsets address UTF-16 code units in the single immutable input part. */
export function validateNativeConversationProposal(value: unknown, text: string, sourceRevision: string): NativeConversationProposal {
  try {
    plain(value); const proposal = proposalSchema.parse(value);
    if (proposal.sourceRevision !== sourceRevision) throw new Error();
    let previousEnd = 0;
    for (const span of proposal.spans) {
      if (span.start < previousEnd || span.end <= span.start || span.end > text.length
        || splitsSurrogate(text, span.start) || splitsSurrogate(text, span.end) || !text.slice(span.start, span.end).trim()) throw new Error();
      previousEnd = span.end;
    }
    return proposal;
  } catch { throw new NativeConversationStorageError('invalid'); }
}
const captureSchema = strictObject({
  version: literal(1), projectId: id, principalId: id, inputId: id, requestId: id,
  text: string().min(1).max(20_000).refine(value => value.trim().length > 0),
  continuation: nativeConversationContinuationSchema.optional(),
  unsupportedSources: array(strictObject({ kind: enumSchema(['image', 'file', 'context']), label: string().min(1).max(200) })).max(100),
  sourceId: id, sourceRevision: id, sessionId: id,
  owner: strictObject({ authorityId: id, authorityRevision: id, authorityScopes: array(id).max(100), scopeId: id, scopeRevision: id, projectRoot: string().min(1).max(4096) }),
  generation: revision.min(1), state: enumSchema(['captured', 'processing', 'turn', 'blocked', 'refused', 'associated', 'cancelled']),
  stage: enumSchema(['routing', 'extracting', 'checking', 'deciding', 'waiting']).nullable(),
  route: enumSchema(['converse', 'answer', 'contract']).nullable(), reason: enumSchema(['unsupported-source', 'missing-context', 'semantic', 'exhausted']).nullable(),
  proposalsSpent: revision.max(NATIVE_CONVERSATION_MAX_PROPOSALS), proposal: proposalSchema.nullable(),
  association: strictObject({ workId: id, attemptId: id, ledgerRevision: revision.min(1) }).nullable(),
});
export function parseNativeConversationCapture(value: unknown): NativeConversationCapture {
  try {
    plain(value);
    const { decisions, ...rest } = value as NativeConversationCapture;
    const parsed = captureSchema.parse(rest);
    if (!Array.isArray(decisions) || decisions.length > NATIVE_CONVERSATION_MAX_DECISIONS
      || new Set(parsed.owner.authorityScopes).size !== parsed.owner.authorityScopes.length
      || parsed.sourceId !== nativeConversationSourceId(parsed.projectId, parsed.principalId, parsed.inputId)
      || parsed.sourceRevision !== nativeConversationSourceRevision(parsed)) throw new Error();
    if (parsed.continuation && parsed.continuation.revision !== createHash('sha256').update(canonicalNativeConversationContinuation(parsed.continuation.sessionId, parsed.continuation.messages)).digest('hex')) throw new Error();
    const retained = decisions.map(entry => {
      if (Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'decision') || !Object.hasOwn(entry, 'context')) throw new Error();
      const context = captureJevDecisionContext(entry.context); const decision = validateJevDecision(entry.decision, context);
      const expected = nativeConversationDecisionBinding({ ...parsed, decisions: [] }, 'routing');
      if (Object.keys(expected).some(key => key !== 'actionRevision' && decision.binding[key as keyof JevDecisionBinding] !== expected[key as keyof JevDecisionBinding])) throw new Error();
      return { decision, context };
    });
    if (new Set(retained.map(entry => entry.decision.decisionId)).size !== retained.length) throw new Error();
    if ((parsed.state === 'processing') !== (parsed.stage !== null)) throw new Error();
    if (parsed.proposal) validateNativeConversationProposal(parsed.proposal, parsed.text, parsed.sourceRevision);
    if (parsed.proposal && parsed.proposalsSpent < 1) throw new Error();
    if ((parsed.state === 'associated') !== (parsed.association !== null)) throw new Error();
    const result = { ...parsed, ...(parsed.continuation ? { continuation: captureNativeConversationContinuation(parsed.continuation) } : {}), decisions: retained };
    if (parsed.state === 'turn') {
      const final = retained.at(-1)?.decision;
      if (!['converse', 'answer'].includes(parsed.route ?? '') || parsed.unsupportedSources.length || final?.outcome !== 'act'
        || !isDeepStrictEqual(final.binding, nativeConversationDecisionBinding(result, 'ordinary-turn'))) throw new Error();
    }
    if (!isDeepStrictEqual(result, value) || new TextEncoder().encode(JSON.stringify(result)).byteLength > NATIVE_CONVERSATION_MAX_RECORD_BYTES) throw new Error();
    return result;
  } catch { throw new NativeConversationStorageError('invalid'); }
}
