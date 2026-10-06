/** Durable original-input ownership before native work exists. Never starts execution. */
import { nativeSelectedDiffSelector, type NativeSelectedDiffSelector } from './native-diff-context.js';
import { captureNativeConversationContinuation, nativeConversationContinuationSchema, type NativeConversationContinuation } from './native-continuation-context.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson, type DecisionLog, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import type { AutonomousDecision } from '../../gate/autonomous-decision.js';
import type { NativeExecutionScopeOwner, NativePairedExecutionAuthority, NativePairedExecutionSnapshot } from './native-execution.js';
import { createWorkLedger, readWorkLedgerState } from './service.js';
import type { WorkLedgerSubmission } from './types.js';
import { readNativeIntakeRoute, decideNativeIntake, validateNativeRequirementProposal } from './native-intake-decisions.js';
import type { NativeRequirementProposer } from './native-intake-proposer.js';
import { nativeIntakeContinuationCatalog, nativeIntakeDecisionSite, recoverNativeIntakeDecision } from './native-intake-recovery.js';
export { createNativeRequirementProposer } from './native-intake-proposer.js';
export type { NativeRequirementProposer, NativeRequirementProposalRequest } from './native-intake-proposer.js';
import { NATIVE_CONVERSATION_MAX_PROPOSALS, NATIVE_CONVERSATION_MAX_DECISIONS, nativeConversationSourceId, nativeConversationSourceRevision,
  nativeConversationProposalRevision, parseNativeConversationCapture, type NativeConversationCapture, type NativeConversationKey,
  nativeConversationDecisionBinding, type NativeConversationStorage } from './native-intake-types.js';
import { nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeLookupRequestSchema,
  nativeConversationIntakeTransitionRequestSchema, nativeConversationIntakeResultSchema, nativeConversationIntakeWorkReceiptSchema,
  type NativeConversationIntakeCaptureRequest, type NativeConversationIntakeLookupRequest, type NativeConversationIntakeTransitionRequest,
  type NativeConversationIntakeResult, type NativeConversationIntakeLookupResult, type NativeConversationIntakeWorkReceipt } from './native-intake-wire.js';

export class NativeConversationIntakeError extends Error {
  constructor(readonly code: 'invalid' | 'unsupported-authority' | 'forbidden' | 'stale' | 'conflict' | 'request-conflict' | 'not-found' | 'recovery-required' | 'indeterminate' | 'unavailable' | 'closed') {
    super(`Native conversation intake: ${code}`); this.name = 'NativeConversationIntakeError';
  }
}
export interface NativeConversationContinuationOwner {
  capture(sessionId: string, principalId: string, selectedDiff?: NativeSelectedDiffSelector): Promise<NativeConversationContinuation>;
  /** Synchronous publication fence: same owner/workspace and exact captured transcript prefix. */
  assertCurrent(context: NativeConversationContinuation, principalId: string): void;
}
export interface NativeConversationIntakeOptions {
  readonly signal?: AbortSignal;
  readonly isAuthorized?: () => boolean;
}
export interface NativeConversationIntakeHost {
  readonly projectId: string;
  capture(input: NativeConversationIntakeCaptureRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  get(input: NativeConversationIntakeLookupRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeLookupResult>;
  admit(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  resume(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  cancel(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options?: NativeConversationIntakeOptions): Promise<NativeConversationIntakeResult>;
  close(): Promise<void>;
}
const scopes = ['read:work-ledger', 'write:work-ledger'] as const;
function paired(authority: NativePairedExecutionAuthority): NativePairedExecutionSnapshot {
  const value = authority.current();
  if (!value || value.kind !== 'pairing-token' || value.principalId !== value.authorityId || value.authorityRevision !== value.tokenId
    || !scopes.every(scope => value.scopes.includes('*') || value.scopes.includes(scope))) throw new NativeConversationIntakeError('unsupported-authority');
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes].sort()) });
}
const contextReadScope = (selectedDiff: NativeSelectedDiffSelector | undefined) => selectedDiff ? selectedDiff.kind === 'session' ? 'read:sessions' : 'read:checkpoints' : undefined;
const terminal = (record: NativeConversationCapture) => ['associated', 'turn', 'cancelled'].includes(record.state);

export function createNativeConversationIntakeHost(deps: {
  readonly projectId: string; readonly projectRoot: string; readonly sessionId: string;
  readonly continuation?: NativeConversationContinuationOwner;
  readonly storage: NativeConversationStorage; readonly scopes: NativeExecutionScopeOwner;
  readonly port: JudgmentPort; readonly decisionLog: Pick<DecisionLog, 'get' | 'query'>; readonly proposer: NativeRequirementProposer;
}): NativeConversationIntakeHost {
  const root = realpathSync(deps.projectRoot);
  const lifetime = new AbortController(); const pending = new Set<Promise<unknown>>();
  const captures = new Map<string, Promise<NativeConversationCapture>>();
  const deliveries = new Map<string, { controller: AbortController; promise: Promise<NativeConversationIntakeResult>; generation?: number }>();
  let closed = false; let closing: Promise<void> | undefined;
  const assertOpen = () => { if (closed) throw new NativeConversationIntakeError('closed'); };
  const keyOf = (inputId: string, authority: NativePairedExecutionAuthority): NativeConversationKey => ({ principalId: paired(authority).principalId, inputId });
  const keyId = (key: NativeConversationKey) => JSON.stringify({ principalId: key.principalId, inputId: key.inputId });
  function track<T>(operation: () => Promise<T>): Promise<T> {
    assertOpen(); const promise = Promise.resolve().then(operation); pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  function owner(authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions) {
    assertOpen();
    if (options.isAuthorized && options.isAuthorized() !== true) throw new NativeConversationIntakeError('forbidden');
    const identity = paired(authority); const scope = deps.scopes.currentScope(root);
    if (scope.root !== root || realpathSync(deps.projectRoot) !== root) throw new NativeConversationIntakeError('stale');
    return { identity, scope, facts: { authorityId: identity.authorityId, authorityRevision: identity.authorityRevision,
      authorityScopes: [...identity.scopes], scopeId: scope.scopeId, scopeRevision: scope.scopeRevision, projectRoot: root } };
  }
  function inspect(record: NativeConversationCapture, authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions): void {
    const current = owner(authority, options);
    if (record.projectId !== deps.projectId || record.principalId !== current.identity.principalId || record.sessionId !== deps.sessionId
      || !isDeepStrictEqual(record.owner, current.facts)) throw new NativeConversationIntakeError('stale');
    if (record.continuation) {
      if (!current.identity.scopes.includes('*') && (!current.identity.scopes.includes('write:sessions')
        || (contextReadScope(record.continuation.selectedDiff) !== undefined && !current.identity.scopes.includes(contextReadScope(record.continuation.selectedDiff)!)))) throw new NativeConversationIntakeError('forbidden');
    }
  }
  function assertContinuation(record: NativeConversationCapture): void {
    if (!record.continuation) return;
    if (!deps.continuation) throw new NativeConversationIntakeError('unavailable');
    deps.continuation.assertCurrent(record.continuation, record.principalId);
  }
  function load(key: NativeConversationKey, authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions, revision?: string): NativeConversationCapture {
    const record = deps.storage.current(key);
    if (!record) throw new NativeConversationIntakeError('not-found');
    inspect(record, authority, options);
    if (revision !== undefined && revision !== record.sourceRevision) throw new NativeConversationIntakeError('stale');
    return record;
  }
  async function withOwners<T>(record: NativeConversationCapture, authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions,
    operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    inspect(record, authority, options); const current = owner(authority, options);
    return authority.withCurrent(current.identity, assertAuthority => deps.scopes.withCurrentScope(current.scope, assertScope => {
      const assertCurrent = () => { assertAuthority(); assertScope(); inspect(record, authority, options); };
      assertCurrent(); return operation(assertCurrent);
    }));
  }
  async function receipt(record: NativeConversationCapture): Promise<NativeConversationIntakeWorkReceipt> {
    if (!record.association) throw new NativeConversationIntakeError('unavailable');
    const storage = deps.storage.publicationStorage(record, () => { throw new NativeConversationIntakeError('invalid'); }, () => { throw new NativeConversationIntakeError('invalid'); });
    try {
      const ledger = await storage.read();
      const state = readWorkLedgerState(ledger, deps.projectId);
      const event = state.receipts.find(item => item.actorId === record.principalId && item.requestId === record.requestId)?.event;
      if (!event || event.type !== 'submit_native' || event.work.source?.version !== 2 || !event.attemptId
        || event.workId !== record.association.workId || event.attemptId !== record.association.attemptId || event.sequence !== record.association.ledgerRevision) throw new NativeConversationIntakeError('unavailable');
      return projectReceipt(event as WorkLedgerSubmission);
    } finally { await storage.close(); }
  }
  function projectReceipt(event: WorkLedgerSubmission): NativeConversationIntakeWorkReceipt {
    const source = event.work.source;
    if (source.version !== 2) throw new NativeConversationIntakeError('unavailable');
    const attempt = event.attempts.find(item => item.id === event.attemptId);
    if (!attempt) throw new NativeConversationIntakeError('unavailable');
    return nativeConversationIntakeWorkReceiptSchema.parse({ projectId: deps.projectId, requestId: event.requestId,
      inputId: source.inputId, ledgerRevision: event.sequence, workId: event.workId, attemptId: event.attemptId,
      expectedRevision: { work: event.work.revision, criteria: event.work.criteriaRevision, attempt: attempt.revision },
      source: { version: 2, sourceId: source.sourceId, sourceRevision: source.sourceRevision, sessionId: source.sessionId,
        ...(source.continuation ? { continuation: source.continuation } : {}),
        offsetEncoding: source.extraction.offsetEncoding, proposalRevision: source.extraction.proposalRevision, spans: source.extraction.spans,
        admissionDecisionId: source.extraction.admissionDecisionId, judgmentDecisionIds: source.extraction.judgmentDecisionIds },
      goal: event.work.goal, criteria: event.work.criteria });
  }
  async function projection(record: NativeConversationCapture): Promise<NativeConversationIntakeResult> {
    const common = { projectId: record.projectId, requestId: record.requestId,
      sourceRef: { version: 1 as const, inputId: record.inputId, sourceId: record.sourceId, sourceRevision: record.sourceRevision, sessionId: record.sessionId,
        ...(record.continuation ? { continuation: { sessionId: record.continuation.sessionId, revision: record.continuation.revision, ...(record.continuation.selectedDiff ? { selectedDiff: nativeSelectedDiffSelector(record.continuation.selectedDiff) } : {}) } } : {}) } };
    switch (record.state) {
      case 'captured': return { kind: 'captured', ...common };
      case 'processing': return { kind: 'processing', ...common, stage: record.stage ?? 'routing', recovery: deliveries.get(keyId(record))?.generation === record.generation ? 'pending' : 'required' };
      case 'turn': if (record.route === 'converse' || record.route === 'answer') return { kind: 'turn', ...common, route: record.route, text: record.text, ...(record.continuation ? { continuation: nativeConversationContinuationSchema.parse(record.continuation) } : {}) }; break;
      case 'blocked': return { kind: 'blocked', ...common, reason: record.reason === 'unsupported-source' ? 'unsupported-source' : 'missing-context', recovery: 'required' };
      case 'refused': return { kind: 'refused', ...common, reason: record.reason === 'exhausted' ? 'exhausted' : 'semantic' };
      case 'cancelled': return { kind: 'cancelled', ...common };
      case 'associated': return { kind: 'work', ...common, receipt: await receipt(record) };
    }
    throw new NativeConversationIntakeError('unavailable');
  }
  function assertRecorded(autonomous: AutonomousDecision): void {
    for (const id of autonomous.decision.judgmentDecisionIds) {
      const entry = deps.decisionLog.get(id);
      if (!entry || entry.status !== 'answered' || !entry.notes.some(note => note.kind === 'readings' && note.readings !== null
        && typeof note.readings === 'object' && !Array.isArray(note.readings)
        && canonicalJson(note.readings['autonomousDecision']) === canonicalJson(autonomous.decision as unknown as EntryType))) throw new NativeConversationIntakeError('unavailable');
    }
  }
  async function run(key: NativeConversationKey, revision: string, authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions,
    controller: AbortController, resuming: boolean): Promise<NativeConversationIntakeResult> {
    let record = load(key, authority, options, revision);
    if (terminal(record) || record.state === 'blocked' || record.state === 'refused' || (!resuming && record.state !== 'captured')) return projection(record);
    assertContinuation(record);
    const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    signal.throwIfAborted();
    record = await withOwners(record, authority, options, assertOwners => deps.storage.transaction(key, original => {
      assertOwners(); signal.throwIfAborted(); assertContinuation(record);
      if (!original || original.generation !== record.generation || terminal(original)) throw new NativeConversationIntakeError('conflict');
      let current = original;
      if (resuming && current.state === 'processing' && current.stage === 'deciding') {
        // Reconcile and claim the next generation in the SAME owner transaction.
        // A previous async reader cannot publish between these two boundaries.
        const recovery = recoverNativeIntakeDecision(current, deps.decisionLog);
        if (recovery.kind === 'partial') throw new NativeConversationIntakeError('recovery-required');
        if (recovery.kind === 'recorded') {
          const { decision } = recovery.entry;
          const decisions = current.decisions.some(entry => entry.decision.decisionId === decision.decisionId)
            ? current.decisions : [...current.decisions, recovery.entry];
          const catalog = nativeIntakeContinuationCatalog(current);
          let change: Partial<NativeConversationCapture>;
          if (decision.outcome === 'reject') change = { state: current.unsupportedSources.length ? 'blocked' : 'refused', stage: null,
            reason: current.unsupportedSources.length ? 'unsupported-source' : current.proposalsSpent >= NATIVE_CONVERSATION_MAX_PROPOSALS ? 'exhausted' : 'semantic' };
          else if (decision.outcome === 'revise' && isDeepStrictEqual(decision.next, catalog.resolve.ref)) change = { state: 'blocked', stage: null,
            reason: current.unsupportedSources.length ? 'unsupported-source' : 'missing-context' };
          else if (decision.outcome === 'revise' && catalog.continuations.includes(catalog.repair) && isDeepStrictEqual(decision.next, catalog.repair.ref)) change = { stage: 'extracting', proposal: null };
          else if (decision.outcome === 'act') change = { stage: 'checking' }; // Resume freshly evaluates; never replay act.
          else throw new NativeConversationIntakeError('recovery-required');
          current = parseNativeConversationCapture({ ...current, ...change, decisions });
        }
      }
      if (current.state === 'blocked' || current.state === 'refused') return { next: isDeepStrictEqual(current, original) ? null : current, value: current };
      const next = parseNativeConversationCapture({ ...current, generation: current.generation + 1, state: 'processing', stage: 'routing', reason: null });
      return { next, value: next };
    }));
    if (record.state !== 'processing') return projection(record);
    const generation = record.generation; const delivery = deliveries.get(keyId(key)); if (delivery) delivery.generation = generation;
    const assertCurrent = () => {
      signal.throwIfAborted(); const current = load(key, authority, options, revision); assertContinuation(current);
      if (current.generation !== generation || current.state !== 'processing') throw new NativeConversationIntakeError('stale');
    };
    const watch = setInterval(() => { try { assertCurrent(); } catch (error) { controller.abort(error); } }, 50); watch.unref?.();
    async function update(change: Partial<NativeConversationCapture>) {
      record = await withOwners(record, authority, options, assertOwners => deps.storage.transaction(key, current => {
        assertOwners(); assertCurrent();
        if (!current || current.generation !== generation) throw new NativeConversationIntakeError('stale');
        const next = parseNativeConversationCapture({ ...current, ...change }); return { next, value: next };
      }));
    }
    try {
      const routeEvidence = await readNativeIntakeRoute({ text: record.text, sourceRevision: record.sourceRevision, ...(record.continuation ? { continuation: record.continuation } : {}), sourceIssues: record.unsupportedSources,
        port: deps.port, decisionLog: deps.decisionLog, binding: nativeConversationDecisionBinding(record, 'routing'), assertCurrent, signal });
      assertCurrent(); await update({ route: routeEvidence.route });
      let previous: unknown = null;
      for (;;) {
        assertCurrent();
        if (record.decisions.length >= NATIVE_CONVERSATION_MAX_DECISIONS) { await update({ state: 'refused', stage: null, reason: 'exhausted' }); return projection(record); }
        let requirements: ReturnType<typeof validateNativeRequirementProposal> | undefined;
        if (routeEvidence.settled && routeEvidence.route === 'contract' && record.unsupportedSources.length === 0) {
          if (record.proposal) requirements = validateNativeRequirementProposal(record.text, record.sourceRevision, record.proposal);
          else if (record.proposalsSpent < NATIVE_CONVERSATION_MAX_PROPOSALS) {
            await update({ stage: 'extracting', proposalsSpent: record.proposalsSpent + 1 });
            let proposed: unknown;
            try { proposed = await deps.proposer.propose({ text: record.text, sourceRevision: record.sourceRevision,
              attempt: record.proposalsSpent, previous, ...(record.continuation ? { continuation: record.continuation } : {}), signal, assertCurrent }); }
            catch (error) { assertCurrent(); throw error; }
            assertCurrent();
            try { requirements = validateNativeRequirementProposal(record.text, record.sourceRevision, proposed); }
            catch { /* Invalid proposals remain evidence of a failed attempt, never new roots. */ }
            if (requirements?.proposal.spans.length) await update({ proposal: requirements.proposal });
          }
        }
        // This durable stage precedes the final reading and owns its recovery lookup.
        await update({ stage: 'deciding' });
        const { repair, resolve, continuations } = nativeIntakeContinuationCatalog(record);
        const result = await decideNativeIntake({ text: record.text, sourceRevision: record.sourceRevision, ...(record.continuation ? { continuation: record.continuation } : {}), routeEvidence,
          ...(requirements ? { requirements } : {}), port: deps.port, decisionLog: deps.decisionLog,
          binding: nativeConversationDecisionBinding(record, routeEvidence.route === 'contract' ? 'publish-work' : 'ordinary-turn'), continuations, conditions: [],
          decisionSite: nativeIntakeDecisionSite(record), allowAct: record.unsupportedSources.length === 0, sourceIssues: record.unsupportedSources, assertCurrent, signal });
        assertCurrent(); result.autonomous.assertCurrent(); assertRecorded(result.autonomous);
        const decision = result.autonomous.decision;
        const decisions = [...record.decisions, { decision, context: result.autonomous.context }];
        if (decision.outcome === 'revise' && decision.next.id === repair.ref.id && decision.next.revision === repair.ref.revision
          && continuations.includes(repair)) {
          previous = { spans: record.proposal?.spans ?? null, problems: result.problems };
          await update({ stage: 'extracting', decisions, proposal: null }); continue;
        }
        if (decision.outcome === 'revise' && decision.next.id === resolve.ref.id && decision.next.revision === resolve.ref.revision) {
          // This registered resolver has exactly one supported source: the captured text.
          // It cannot replace an absent attachment/context with generated prose.
          await update({ state: 'blocked', stage: null, decisions, reason: record.unsupportedSources.length ? 'unsupported-source' : 'missing-context' });
          return projection(record);
        }
        if (decision.outcome !== 'act') {
          await update({ state: record.unsupportedSources.length ? 'blocked' : 'refused', stage: null, decisions,
            reason: record.unsupportedSources.length ? 'unsupported-source' : record.proposalsSpent >= NATIVE_CONVERSATION_MAX_PROPOSALS ? 'exhausted' : 'semantic' });
          return projection(record);
        }
        if (record.unsupportedSources.length) throw new NativeConversationIntakeError('unavailable');
        if (routeEvidence.route !== 'contract') {
          await withOwners(record, authority, options, assertOwners => deps.storage.transaction(key, current => {
            assertOwners(); assertCurrent(); result.autonomous.recordClaim(); assertRecorded(result.autonomous);
            if (!current || current.generation !== generation) throw new NativeConversationIntakeError('stale');
            const next = parseNativeConversationCapture({ ...current, state: 'turn', stage: null, decisions }); record = next; return { next, value: undefined };
          }));
          return projection(record);
        }
        if (!requirements?.criteria.length || !record.proposal) throw new NativeConversationIntakeError('unavailable');
        await update({ stage: 'deciding', decisions });
        await publish(record, result.autonomous, requirements.criteria, authority, options, signal, assertCurrent);
        return projection(load(key, authority, options, revision));
      }
    } finally { clearInterval(watch); }
  }
  async function publish(record: NativeConversationCapture, decision: AutonomousDecision, criteria: readonly string[], authority: NativePairedExecutionAuthority,
    options: NativeConversationIntakeOptions, signal: AbortSignal, assertCurrent: () => void): Promise<void> {
    if (!record.proposal || decision.decision.outcome !== 'act') throw new NativeConversationIntakeError('invalid');
    const source = { version: 2 as const, sourceId: record.sourceId, sourceRevision: record.sourceRevision, inputId: record.inputId, sessionId: record.sessionId,
      ...(record.continuation ? { continuation: nativeConversationContinuationSchema.parse(record.continuation) } : {}),
      extraction: { version: 1 as const, offsetEncoding: 'utf16' as const, spans: [...record.proposal.spans], proposalRevision: nativeConversationProposalRevision(record.proposal),
        admissionDecisionId: decision.decision.decisionId, judgmentDecisionIds: [...decision.decision.judgmentDecisionIds] } };
    const storage = deps.storage.publicationStorage(record, current => {
      assertCurrent(); decision.assertCurrent(); assertRecorded(decision);
      if (current.generation !== record.generation || !isDeepStrictEqual(current.proposal, record.proposal)) throw new NativeConversationIntakeError('stale');
    }, (current, event) => {
      decision.recordClaim(); assertCurrent(); assertRecorded(decision);
      return parseNativeConversationCapture({ ...current, state: 'associated', stage: null,
        association: { workId: event.workId, attemptId: event.attemptId, ledgerRevision: event.sequence } });
    });
    const ledger = createWorkLedger({ projectId: deps.projectId, storage, clock: { now: Date.now, newId: kind => `${kind}-${randomUUID()}` } });
    const actor = ledger.authority.issueActor({ actorId: record.principalId, projectId: deps.projectId, role: 'coordinator' });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        assertCurrent(); const snapshot = await ledger.service.readSnapshot(actor); assertCurrent();
        const result = await withOwners(record, authority, options, assertOwners => ledger.service.execute({ type: 'submit_native', requestId: record.requestId,
          expectedRevision: snapshot.revision, title: record.text.trim(), goal: record.text, criteria: [...criteria], source }, actor,
        { signal, isAuthorized: () => { assertOwners(); assertCurrent(); return true; } }));
        if (result.kind === 'accepted') return;
        if (result.kind === 'indeterminate') throw new NativeConversationIntakeError('indeterminate');
        if (result.code !== 'conflict') throw new NativeConversationIntakeError(result.code === 'request_conflict' ? 'request-conflict' : 'unavailable');
      }
      throw new NativeConversationIntakeError('conflict');
    } finally { ledger.authority.revokeActor(actor); await ledger.service.close(); await storage.close(); }
  }
  async function deliver(input: NativeConversationIntakeTransitionRequest, authority: NativePairedExecutionAuthority, options: NativeConversationIntakeOptions, resuming: boolean): Promise<NativeConversationIntakeResult> {
    const parsed = nativeConversationIntakeTransitionRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
    const key = keyOf(parsed.data.inputId, authority); const existing = deliveries.get(keyId(key));
    load(key, authority, options, parsed.data.sourceRevision);
    if (existing) return existing.promise.then(value => { owner(authority, options); return value; });
    const controller = new AbortController();
    const promise = track(() => run(key, parsed.data.sourceRevision, authority, options, controller, resuming)).then(async result => {
      inspect(load(key, authority, options), authority, options); return nativeConversationIntakeResultSchema.parse(result);
    });
    const delivery = { controller, promise }; deliveries.set(keyId(key), delivery);
    void promise.then(() => { if (deliveries.get(keyId(key)) === delivery) deliveries.delete(keyId(key)); }, () => { if (deliveries.get(keyId(key)) === delivery) deliveries.delete(keyId(key)); });
    return promise;
  }
  return {
    projectId: deps.projectId,
    capture(input, authority, options = {}) {
      const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
      return track(async () => {
        options.signal?.throwIfAborted(); const current = owner(authority, options); const { continuation: selection, ...original } = parsed.data;
        if (selection && !current.identity.scopes.includes('*') && (!current.identity.scopes.includes('write:sessions')
          || (contextReadScope(selection.selectedDiff) !== undefined && !current.identity.scopes.includes(contextReadScope(selection.selectedDiff)!)))) throw new NativeConversationIntakeError('forbidden');
        const key = { principalId: current.identity.principalId, inputId: original.inputId };
        const matches = (existing: NativeConversationCapture) => existing.requestId === original.requestId && existing.text === original.text
          && isDeepStrictEqual(existing.unsupportedSources, original.unsupportedSources) && existing.continuation?.sessionId === selection?.sessionId
          && isDeepStrictEqual(existing.continuation?.selectedDiff ? nativeSelectedDiffSelector(existing.continuation.selectedDiff) : undefined, selection?.selectedDiff);
        // Replayed capture retains its original checkpoint even when later turns appended.
        const prior = deps.storage.current(key);
        if (prior) { inspect(prior, authority, options); if (!matches(prior)) throw new NativeConversationIntakeError('request-conflict'); return projection(prior); }
        const captureKey = keyId(key);
        const pending = captures.get(captureKey);
        if (pending) {
          const existing = await pending;
          inspect(existing, authority, options);
          if (!matches(existing)) throw new NativeConversationIntakeError('request-conflict');
          return projection(existing);
        }
        const capture = (async () => {
          if (selection && !deps.continuation) throw new NativeConversationIntakeError('unavailable');
          const continuation = selection ? captureNativeConversationContinuation(await deps.continuation!.capture(selection.sessionId, current.identity.principalId, selection.selectedDiff)) : undefined;
          if (continuation && (continuation.sessionId !== selection?.sessionId || !isDeepStrictEqual(continuation.selectedDiff ? nativeSelectedDiffSelector(continuation.selectedDiff) : undefined, selection?.selectedDiff))) throw new NativeConversationIntakeError('stale');
          options.signal?.throwIfAborted();
          const source = { ...original, ...(continuation ? { continuation } : {}) };
          const record = parseNativeConversationCapture({ version: 1, projectId: deps.projectId, principalId: current.identity.principalId,
            ...source, sourceId: nativeConversationSourceId(deps.projectId, current.identity.principalId, source.inputId), sourceRevision: nativeConversationSourceRevision(source),
            sessionId: deps.sessionId, owner: current.facts, generation: 1, state: 'captured', stage: null, route: null, reason: null,
            proposalsSpent: 0, proposal: null, decisions: [], association: null });
          const stored = await withOwners(record, authority, options, assertCurrent => deps.storage.transaction(record, existing => {
            assertCurrent(); options.signal?.throwIfAborted();
            if (existing) {
              inspect(existing, authority, options);
              if (!matches(existing)) throw new NativeConversationIntakeError('request-conflict');
              return { next: null, value: existing };
            }
            assertContinuation(record); return { next: record, value: record };
          }));
          return stored;
        })();
        captures.set(captureKey, capture);
        let stored: NativeConversationCapture;
        try { stored = await capture; } finally { if (captures.get(captureKey) === capture) captures.delete(captureKey); }
        inspect(stored, authority, options); return projection(stored);
      });
    },
    get(input, authority, options = {}) {
      const parsed = nativeConversationIntakeLookupRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
      return track(async () => { options.signal?.throwIfAborted(); owner(authority, options);
        const record = deps.storage.current(keyOf(parsed.data.inputId, authority)); if (!record) return { kind: 'not-found' };
        inspect(record, authority, options); const result = await projection(record); inspect(record, authority, options); return result;
      });
    },
    admit(input, authority, options = {}) { return deliver(input, authority, options, false); },
    resume(input, authority, options = {}) { return deliver(input, authority, options, true); },
    cancel(input, authority, options = {}) {
      const parsed = nativeConversationIntakeTransitionRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(new NativeConversationIntakeError('invalid'));
      return track(async () => {
        const key = keyOf(parsed.data.inputId, authority); const record = load(key, authority, options, parsed.data.sourceRevision);
        const delivery = deliveries.get(keyId(key)); let validated = false;
        try {
          const result = await withOwners(record, authority, options, assertCurrent => deps.storage.transaction(key, current => {
            assertCurrent(); if (!current) throw new NativeConversationIntakeError('not-found'); inspect(current, authority, options); validated = true;
            if (terminal(current)) return { next: null, value: current };
            const next = parseNativeConversationCapture({ ...current, generation: current.generation + 1, state: 'cancelled', stage: null });
            return { next, value: next };
          }));
          if (result.state === 'cancelled') { delivery?.controller.abort(); if (delivery) await Promise.allSettled([delivery.promise]); }
          inspect(result, authority, options); return projection(result);
        } catch (error) {
          // After ambiguous durable publication, prevent local old-generation continuation too.
          if (validated) { delivery?.controller.abort(); if (delivery) await Promise.allSettled([delivery.promise]); }
          throw error;
        }
      });
    },
    close() {
      if (closing) return closing; closed = true; lifetime.abort();
      for (const delivery of deliveries.values()) delivery.controller.abort();
      closing = Promise.allSettled([...pending]).then(() => {}); return closing;
    },
  };
}
