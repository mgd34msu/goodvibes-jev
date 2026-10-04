import { verifyNativeWorkExecution } from './native-execution-verifier.js';
import { nativeSettlementDigest, type NativeWorkSettlementReceipt } from './native-settlement-types.js';
import type { CheckSettings } from '../../contract/check.js';
import type { ReadAccessFilter } from '../../tools/shared/read-access.js';
/** Native work -> durable runner bridge. No product payload can provide its authority owners. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { canonicalJson, type DecisionLog, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { decideAutonomous } from '../../gate/autonomous-decision.js';
import { criteriaSetIdForWork, durableKeyHash, durablePayloadRevision, freezeDurableRequest, type DurableContractAdmission, type DurableContractKey, type DurableContractRequest, type DurableStartedContract } from '../../contract/durable-admission.js';
import { captureNativeContractSource } from '../../contract/native-source.js';
import type { ContractRunner } from '../../contract/runner.js';
import { isTerminalContractStatus, type ContractView } from '../../contract/types.js';
import type { NativeContractCompositionOwner } from '../../runtime/contract-composition.js';
import { NativeWorkExecutionError, parseNativeWorkExecutionRecord, parseNativeWorkExecutionIntent, type NativeWorkExecutionIntent, type NativeWorkExecutionRecord, type NativeWorkExecutionStorage, type NativeWorkExecutionTarget, type NativeWorkExecutionTransaction } from './native-execution-types.js';

export interface NativePairedExecutionSnapshot {
  readonly kind: 'pairing-token'; readonly tokenId: string; readonly principalId: string;
  readonly authorityId: string; readonly authorityRevision: string; readonly scopes: readonly string[];
}
/** Nonserialized transport-created capability. Keep the credential inside its authenticated owner. */
export interface NativePairedExecutionAuthority {
  current(): NativePairedExecutionSnapshot | null;
  withCurrent<T>(expected: NativePairedExecutionSnapshot, callback: (assertCurrent: () => NativePairedExecutionSnapshot) => T | Promise<T>): Promise<T>;
}
export interface NativeExecutionScope { readonly root: string; readonly scopeId: string; readonly scopeRevision: string; }
export interface NativeExecutionScopeOwner {
  currentScope(root: string): NativeExecutionScope;
  withCurrentScope<T>(expected: NativeExecutionScope, callback: (assertCurrent: () => void) => T | Promise<T>): Promise<T>;
}
type NativeRunner = Pick<ContractRunner, 'startDurable' | 'resumeDurable' | 'get' | 'list' | 'cancel' | 'join' | 'inspectDurable' | 'joinDurable'>;
export interface NativeWorkExecutionStatus {
  readonly kind: 'execution';
  readonly execution: NativeWorkExecutionRecord;
  readonly contract: ContractView | null;
  readonly currentTarget: NativeWorkExecutionTarget | null;
  readonly currentAttempt: boolean;
  readonly recovery: 'available' | 'required' | 'terminal' | 'cancelled';
  readonly settlement?: { readonly state: 'pending' | 'required' | 'failed' | 'published'; readonly evidenceId?: string; readonly reportSequence?: number; readonly evidenceSequence?: number };
}
export interface NativeWorkExecutionIntentStatus {
  readonly kind: 'intent';
  readonly intent: NativeWorkExecutionIntent;
  readonly currentTarget: NativeWorkExecutionTarget | null;
  readonly currentAttempt: boolean;
  readonly recovery: 'pending' | 'required' | 'cancelled';
}
export type NativeWorkExecutionObservation = NativeWorkExecutionStatus | NativeWorkExecutionIntentStatus;
export interface NativeWorkExecutionHost {
  readonly nativeOwner: NativeContractCompositionOwner;
  attachRunner(runner: NativeRunner): void;
  start(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, options?: { readonly signal?: AbortSignal }): Promise<DurableStartedContract>;
  status(key: DurableContractKey, authority: NativePairedExecutionAuthority): NativeWorkExecutionStatus;
  statusByAttempt(workId: string, attemptId: string, authority: NativePairedExecutionAuthority): NativeWorkExecutionObservation;
  cancelTarget(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, reason: string): Promise<void>;
  cancel(key: DurableContractKey, authority: NativePairedExecutionAuthority, reason: string): Promise<void>;
  resume(key: DurableContractKey, authority: NativePairedExecutionAuthority, options?: { readonly signal?: AbortSignal }): Promise<DurableStartedContract>;
  /** Explicit proof/publication recovery; never calls runner start or resume. */
  settle(key: DurableContractKey, authority: NativePairedExecutionAuthority, options?: { readonly signal?: AbortSignal }): Promise<NativeWorkSettlementReceipt>;
  close(): Promise<void>;
}
const REQUIRED_SCOPES = ['write:fleet', 'read:work-ledger'] as const;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Canonical protocol encodings of real owner facts, never generated authority.
const authorityBinding = (value: NativePairedExecutionSnapshot) => ({ authorityId: hash({ pairedPrincipal: value.authorityId }), authorityRevision: hash({ pairedIncarnation: value.authorityRevision }) });
const scopeBinding = (value: NativeExecutionScope) => ({ scopeId: hash({ workspaceScope: value.scopeId }), scopeRevision: hash({ workspaceGeneration: value.scopeRevision }) });
const equalTarget = (a: NativeWorkExecutionTarget, b: NativeWorkExecutionTarget) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key as keyof NativeWorkExecutionTarget] === b[key as keyof NativeWorkExecutionTarget]);
const equalScopes = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((scope, index) => scope === [...b].sort()[index]);
function paired(owner: NativePairedExecutionAuthority): NativePairedExecutionSnapshot {
  const value = owner.current();
  if (!value || value.kind !== 'pairing-token' || value.principalId !== value.authorityId || value.authorityRevision !== value.tokenId
    || !REQUIRED_SCOPES.every(scope => value.scopes.includes('*') || value.scopes.includes(scope))) throw new NativeWorkExecutionError('unsupported-authority');
  return Object.freeze({ ...value, scopes: Object.freeze([...value.scopes].sort()) });
}
function captureTarget(value: NativeWorkExecutionTarget): NativeWorkExecutionTarget {
  const target = Object.freeze({ workId: value.workId, workRevision: value.workRevision, criteriaRevision: value.criteriaRevision, attemptId: value.attemptId, attemptRevision: value.attemptRevision });
  if (Object.keys(value).length !== 5 || ![target.workId, target.attemptId].every(id => typeof id === 'string' && id.length > 0)
    || ![target.workRevision, target.criteriaRevision, target.attemptRevision].every(revision => Number.isSafeInteger(revision) && revision >= 0)) throw new NativeWorkExecutionError('invalid');
  return target;
}
function captureKey(value: DurableContractKey): DurableContractKey { const key = Object.freeze({ ...value }); durableKeyHash(key); return key; }
function targetKey(target: NativeWorkExecutionTarget): DurableContractKey {
  return { workId: target.workId, criteriaId: criteriaSetIdForWork(target.workId), criteriaRevision: String(target.criteriaRevision), attemptId: target.attemptId };
}
function workFor(current: NativeWorkExecutionTransaction, target: NativeWorkExecutionTarget, principal: string) {
  const work = current.ledger.works.find(item => item.id === target.workId);
  const attempt = current.ledger.attempts.find(item => item.id === target.attemptId);
  if (!work || !attempt || work.revision !== target.workRevision || work.criteriaRevision !== target.criteriaRevision
    || work.currentAttemptId !== target.attemptId || attempt.workId !== target.workId || attempt.revision !== target.attemptRevision
    || attempt.ownerId !== principal || attempt.state !== 'active' || work.reportedState === 'cancelled' || work.reportedState === 'complete') throw new NativeWorkExecutionError('stale');
  return work;
}
interface ActiveOwner { readonly authority: NativePairedExecutionAuthority; readonly expected: NativePairedExecutionSnapshot; readonly scope: NativeExecutionScope; claimed: boolean; contractId?: string; }

export function createNativeWorkExecutionHost(deps: {
  readonly projectId: string; readonly projectRoot: string; readonly sessionId: string;
  readonly storage: NativeWorkExecutionStorage; readonly scopes: NativeExecutionScopeOwner; readonly port: JudgmentPort;
  readonly decisionLog: Pick<DecisionLog, 'get'>;
  readonly verification?: { readonly settings: () => CheckSettings; readonly readAccessFilter: ReadAccessFilter; readonly automatic?: boolean };
  /** Trusted host lifetime, invoked only for this owner's actual admitted receipt. */
  readonly cancelForeground?: (contractId: string) => Promise<void>;
  readonly joinForeground?: (contractId: string) => Promise<void>;
}): NativeWorkExecutionHost {
  const projectRoot = realpathSync(deps.projectRoot);
  let runner: NativeRunner | undefined; let closed = false; let closing: Promise<void> | undefined;
  interface Delivery { target: NativeWorkExecutionTarget; identity: NativePairedExecutionSnapshot; controller: AbortController; generation?: number; promise: Promise<DurableStartedContract>; }
  const deliveries = new Map<string, Delivery>();
  interface Settlement { readonly authority: NativePairedExecutionSnapshot; readonly controller: AbortController; readonly promise: Promise<NativeWorkSettlementReceipt>; }
  const settlements = new Map<string, Settlement>(); const settlementFailures = new Set<string>();
  const active = new Map<string, ActiveOwner>(); const pending = new Set<Promise<unknown>>(); const lifetime = new AbortController();
  const requireRunner = () => { if (!runner) throw new NativeWorkExecutionError('unavailable'); return runner; };
  const assertOpen = () => { if (closed) throw new NativeWorkExecutionError('closed'); };
  function currentContract(record: NativeWorkExecutionRecord): ContractView | null {
    const currentRunner = requireRunner();
    return record.receipt ? currentRunner.get(record.receipt.contractId) ?? currentRunner.inspectDurable?.(record.request.key)?.contract ?? null : null;
  }
  function status(current: NativeWorkExecutionTransaction, authority: NativePairedExecutionAuthority): NativeWorkExecutionStatus {
    assertOpen(); const execution = current.record; if (!execution) throw new NativeWorkExecutionError('not-found');
    inspectAuthority(execution, authority);
    const contract = execution.receipt ? currentContract(execution) : null;
    const work = current.ledger.works.find(item => item.id === execution.target.workId);
    const attempt = current.ledger.attempts.find(item => item.id === execution.target.attemptId && item.workId === execution.target.workId);
    const currentTarget = work && attempt ? { workId: work.id, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptId: attempt.id, attemptRevision: attempt.revision } : null;
    const recovery = execution.state === 'cancelled' ? 'cancelled' : contract && isTerminalContractStatus(contract.status) ? 'terminal'
      : execution.state === 'launch-claimed' && !active.get(durableKeyHash(execution.request.key))?.claimed ? 'required' : 'available';
    const key = durableKeyHash(execution.request.key);
    const settlement: NativeWorkExecutionStatus['settlement'] = current.settlement ? { state: 'published', evidenceId: current.settlement.evidenceId, reportSequence: current.settlement.reportSequence, evidenceSequence: current.settlement.evidenceSequence }
      : settlements.has(key) ? { state: 'pending' } : settlementFailures.has(key) ? { state: 'failed' } : { state: 'required' };
    return { kind: 'execution', execution, contract, currentTarget, currentAttempt: !!work && !!attempt && work.currentAttemptId === attempt.id && attempt.state === 'active', recovery, settlement };
  }
  function track<T>(run: () => Promise<T>): Promise<T> {
    assertOpen(); const promise = Promise.resolve().then(run); pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  function scope() { const current = deps.scopes.currentScope(projectRoot); if (current.root !== projectRoot || realpathSync(deps.projectRoot) !== projectRoot) throw new NativeWorkExecutionError('stale'); return current; }
  function inspectAuthority(record: NativeWorkExecutionRecord | NativeWorkExecutionIntent, owner: NativePairedExecutionAuthority) {
    const current = paired(owner); const currentScope = scope();
    if (record.projectId !== deps.projectId || record.request.input.projectRoot !== projectRoot || authorityBinding(current).authorityId !== record.request.binding.authorityId
      || authorityBinding(current).authorityRevision !== record.request.binding.authorityRevision || !equalScopes(current.scopes, record.authorityScopes)
      || scopeBinding(currentScope).scopeId !== record.request.binding.scopeId || scopeBinding(currentScope).scopeRevision !== record.request.binding.scopeRevision) throw new NativeWorkExecutionError('stale');
    return { current, currentScope };
  }
  function assertRecorded(record: NativeWorkExecutionRecord) {
    for (const id of record.decision.judgmentDecisionIds) {
      const entry = deps.decisionLog.get(id);
      if (!entry || entry.status !== 'answered' || entry.context.site !== 'work-ledger.native-start'
        || !entry.notes.some(note => note.kind === 'action' && note.action === `autonomous:claim:${record.decision.decisionId}`)
        || !entry.notes.some(note => note.kind === 'readings' && note.readings !== null && typeof note.readings === 'object' && !Array.isArray(note.readings)
          && canonicalJson(note.readings['autonomousDecision']) === canonicalJson(record.decision as unknown as EntryType))) throw new NativeWorkExecutionError('unavailable');
    }
  }
  function assertRecord(current: NativeWorkExecutionTransaction, record: NativeWorkExecutionRecord, owner: ActiveOwner) {
    assertOpen(); assertRecorded(record);
    if (current.intent && (current.intent.state !== 'associated' || durablePayloadRevision(current.intent.request) !== durablePayloadRevision(record.request))) throw new NativeWorkExecutionError('stale'); const auth = inspectAuthority(record, owner.authority);
    if (auth.currentScope.scopeId !== owner.scope.scopeId || auth.currentScope.scopeRevision !== owner.scope.scopeRevision) throw new NativeWorkExecutionError('stale');
    const work = workFor(current, record.target, owner.expected.principalId);
    if (record.state === 'cancelled' || current.record?.state === 'cancelled' || !current.record
      || durablePayloadRevision(current.record.request) !== durablePayloadRevision(record.request)
      || work.goal !== record.request.input.nativeSource?.goal || JSON.stringify(work.criteria) !== JSON.stringify(record.request.input.nativeSource.criteria)) throw new NativeWorkExecutionError('stale');
  }
  function claimOwner(record: NativeWorkExecutionRecord, authority: NativePairedExecutionAuthority): ActiveOwner {
    const { current, currentScope } = inspectAuthority(record, authority); const key = durableKeyHash(record.request.key);
    const prior = active.get(key);
    if (prior) { inspectAuthority(record, prior.authority); return prior; }
    const owner = { authority, expected: current, scope: currentScope, claimed: false }; active.set(key, owner); return owner;
  }
  async function withCurrent(admission: DurableContractAdmission, launch: (assertCurrent: () => void) => void) {
    const owner = active.get(durableKeyHash(admission.key));
    if (!owner) throw new NativeWorkExecutionError('recovery-required');
    await owner.authority.withCurrent(owner.expected, async assertAuthority => {
      await deps.scopes.withCurrentScope(owner.scope, async assertScope => {
        await deps.storage.transaction(admission.key, current => {
          const record = current.record;
          if (!record || durablePayloadRevision(record.request) !== admission.payloadRevision) throw new NativeWorkExecutionError('conflict');
          assertRecord(current, record, owner);
          if (record.state === 'launch-claimed' && !owner.claimed) throw new NativeWorkExecutionError('recovery-required');
          const { input: _input, ...receipt } = admission;
          if (record.receipt && (record.receipt.contractId !== receipt.contractId || record.receipt.ownerAgentId !== receipt.ownerAgentId || record.receipt.payloadRevision !== receipt.payloadRevision)) throw new NativeWorkExecutionError('conflict');
          const next: NativeWorkExecutionRecord = { ...record, receipt, state: 'launch-claimed' };
          return { next: record.state === 'launch-claimed' ? null : next, value: next };
        }, (record, readCurrent) => {
          launch(() => { assertAuthority(); assertScope(); assertRecord(readCurrent(), record, owner); owner.claimed = true; owner.contractId = admission.contractId; });
        });
      });
    });
  }
  function requestFor(current: NativeWorkExecutionTransaction, target: NativeWorkExecutionTarget, expected: NativePairedExecutionSnapshot, expectedScope: NativeExecutionScope): DurableContractRequest {
    const key = targetKey(target); const work = workFor(current, target, expected.principalId);
    const source = captureNativeContractSource({ sourceId: work.source?.sourceId ?? hash({ projectId: deps.projectId, workId: work.id }), sourceRevision: work.source?.sourceRevision ?? hash({ workId: work.id, workRevision: work.revision }),
      inputRevision: hash({ projectId: deps.projectId, target, goal: work.goal, criteria: work.criteria, ...(work.source ? { source: work.source } : {}) }),
      criteriaId: key.criteriaId, criteriaRevision: key.criteriaRevision, goal: work.goal, criteria: work.criteria });
    const binding = { sourceId: source.sourceId, inputRevision: source.inputRevision,
      actionId: hash({ projectId: deps.projectId, key, operation: 'run-native-work' }),
      actionRevision: hash({ projectRoot, sessionId: deps.sessionId, target, authorityScopes: expected.scopes }),
      ...authorityBinding(expected), ...scopeBinding(expectedScope) };
    return freezeDurableRequest({ key, binding, input: { ask: work.title, nativeSource: source, projectRoot, sessionId: deps.sessionId, origin: 'external', isolation: 'auto' } });
  }
  function assertIntent(current: NativeWorkExecutionTransaction, intent: NativeWorkExecutionIntent): void {
    if (current.intent?.state === 'cancelled') throw new NativeWorkExecutionError('prevented-before-admission');
    if (current.record || !current.intent || current.intent.state !== 'admitting' || current.intent.generation !== intent.generation
      || !equalTarget(current.intent.target, intent.target) || durablePayloadRevision(current.intent.request) !== durablePayloadRevision(intent.request)) throw new NativeWorkExecutionError('stale');
  }
  async function prepareIntent(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, delivery: Delivery, resume: boolean, signal: AbortSignal): Promise<NativeWorkExecutionIntent> {
    const expected = paired(authority); const expectedScope = scope();
    return authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
      deps.storage.transactionByAttempt(target.attemptId, current => {
        assertOpen(); signal.throwIfAborted(); assertAuthority(); assertScope();
        if (current.record) throw new NativeWorkExecutionError('conflict');
        const prior = current.intent;
        if (prior) {
          inspectAuthority(prior, authority);
          if (!equalTarget(prior.target, target)) throw new NativeWorkExecutionError('conflict');
          if (prior.state === 'cancelled') throw new NativeWorkExecutionError('prevented-before-admission');
          if (prior.state === 'associated') throw new NativeWorkExecutionError('recovery-required');
          if (!resume) throw new NativeWorkExecutionError(prior.state === 'refused' ? 'refused' : 'pending-intent');
        } else if (resume) throw new NativeWorkExecutionError('not-found');
        const request = requestFor(current, target, expected, expectedScope);
        if (prior && durablePayloadRevision(prior.request) !== durablePayloadRevision(request)) throw new NativeWorkExecutionError('stale');
        const intent = parseNativeWorkExecutionIntent({ version: 1, projectId: deps.projectId, target, authorityScopes: expected.scopes,
          request: prior?.request ?? request, generation: (prior?.generation ?? 0) + 1, state: 'admitting' });
        return { next: null, nextIntent: intent, value: intent };
      }, intent => { delivery.generation = intent.generation; })));
  }
  async function decide(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, signal: AbortSignal, refreshDecision = false, intent?: NativeWorkExecutionIntent): Promise<NativeWorkExecutionRecord> {
    const expected = paired(authority); const expectedScope = scope(); const key = targetKey(target);
    const original = deps.storage.current(key); const work = workFor(original, target, expected.principalId);
    const request = intent?.request ?? requestFor(original, target, expected, expectedScope);
    const source = request.input.nativeSource!; const binding = request.binding;
    const assertCurrent = () => {
      assertOpen(); const current = deps.storage.current(key);
      if (intent) assertIntent(current, intent);
      else if (current.record?.state === 'cancelled' || current.intent?.state === 'cancelled') throw new NativeWorkExecutionError('stale');
      signal.throwIfAborted(); const latest = paired(authority); const currentScope = scope();
      if (latest.authorityId !== expected.authorityId || latest.authorityRevision !== expected.authorityRevision || !equalScopes(latest.scopes, expected.scopes)
        || currentScope.scopeId !== expectedScope.scopeId || currentScope.scopeRevision !== expectedScope.scopeRevision) throw new NativeWorkExecutionError('stale');
      const latestWork = workFor(current, target, latest.principalId);
      if (latestWork.goal !== work.goal || JSON.stringify(latestWork.criteria) !== JSON.stringify(work.criteria)) throw new NativeWorkExecutionError('stale');
    };
    // No authority, workspace or database lock is held while Jev or its backoff waits.
    const read = await decideAutonomous({ port: deps.port, site: 'work-ledger.native-start',
      instructions: 'Decide whether to start exactly this native work attempt from its complete original goal and ordered criteria. Authentication and scope are fixed host constraints. Do not ask for human approval or invent missing requirements.',
      actionDescription: 'Start the exact bound native work attempt through the durable contract runner.', binding,
      state: { originalSource: { goal: source.goal, criteria: source.criteria }, revisions: { work: target.workRevision, criteria: target.criteriaRevision, attempt: target.attemptRevision }, operation: { kind: 'start-native-work', projectRoot }, deterministicConstraints: { existingActiveClaim: true } } as unknown as EntryType,
      evidence: [{ id: 'native-work-source', revision: source.inputRevision }, { id: 'native-work-attempt', revision: hash(target) }, ...(intent ? [{ id: 'native-intent-evaluation', revision: String(intent.generation) }] : [])],
      continuations: [], conditions: [], allowAct: true, assertCurrent, signal });
    assertCurrent();
    if (read.decision.outcome !== 'act') {
      if (intent) await authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
        deps.storage.transaction(key, current => { assertAuthority(); assertScope(); assertCurrent(); assertIntent(current, intent);
          return { next: null, nextIntent: { ...intent, state: 'refused' }, value: undefined }; })));
      throw new NativeWorkExecutionError('refused', read.decision);
    }
    const record = parseNativeWorkExecutionRecord({ version: 1, projectId: deps.projectId, target, authorityScopes: expected.scopes, request, decision: read.decision, decisionContext: read.context, receipt: null, state: 'prepared' });
    await authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
      deps.storage.transaction(key, current => {
        assertAuthority(); assertScope(); assertCurrent(); workFor(current, target, expected.principalId);
        if (current.record) {
          if (durablePayloadRevision(current.record.request) !== durablePayloadRevision(request)) throw new NativeWorkExecutionError('conflict');
          if (!refreshDecision) return { next: null, value: undefined };
          if (current.record.state !== 'prepared') throw new NativeWorkExecutionError('recovery-required');
          read.recordClaim(); assertAuthority(); assertScope(); assertCurrent();
          return { next: { ...record, receipt: current.record.receipt }, value: undefined };
        }
        if (!intent) throw new NativeWorkExecutionError('invalid');
        assertIntent(current, intent);
        read.recordClaim(); assertAuthority(); assertScope(); assertCurrent();
        return { next: record, nextIntent: { ...intent, state: 'associated' }, value: undefined };
      })));
    return deps.storage.current(key).record!;
  }
  function ownedDelivery(target: NativeWorkExecutionTarget, authority: NativePairedExecutionAuthority, signal: AbortSignal | undefined,
    run: (delivery: Delivery, signal: AbortSignal) => Promise<DurableStartedContract>): Promise<DurableStartedContract> {
    assertOpen(); const identity = paired(authority); const key = durableKeyHash(targetKey(target)); const prior = deliveries.get(key);
    if (prior) {
      if (!equalTarget(prior.target, target) || prior.identity.authorityId !== identity.authorityId || !equalScopes(prior.identity.scopes, identity.scopes)) return Promise.reject(new NativeWorkExecutionError('conflict'));
      return prior.promise;
    }
    const controller = new AbortController(); const combined = AbortSignal.any([lifetime.signal, controller.signal, ...(signal ? [signal] : [])]);
    let delivery!: Delivery;
    const promise = track(async () => {
      try { combined.throwIfAborted(); return await run(delivery, combined); }
      catch (error) {
        if (!closed) {
          const current = deps.storage.currentByAttempt(target.attemptId);
          if (!current.record && current.intent?.state === 'cancelled') { inspectAuthority(current.intent, authority); throw new NativeWorkExecutionError('prevented-before-admission'); }
        }
        throw error;
      }
    });
    delivery = { target, identity, controller, promise }; deliveries.set(key, delivery);
    const release = () => { if (deliveries.get(key) === delivery) deliveries.delete(key); };
    void promise.then(release, release); return promise;
  }
  function settle(input: DurableContractKey, authority: NativePairedExecutionAuthority, options: { readonly signal?: AbortSignal } = {}): Promise<NativeWorkSettlementReceipt> {
    assertOpen(); const key = captureKey(input); const identity = paired(authority); const id = durableKeyHash(key);
    const current = deps.storage.current(key); const record = current.record;
    if (!record) return Promise.reject(new NativeWorkExecutionError('not-found'));
    const ownerFacts = inspectAuthority(record, authority);
    const reconcile = () => authority.withCurrent(ownerFacts.current, async assertAuthority => deps.scopes.withCurrentScope(ownerFacts.currentScope, async assertScope => {
      if (!deps.storage.settle) throw new NativeWorkExecutionError('unavailable');
      return deps.storage.settle(key, latest => { assertAuthority(); assertScope(); inspectAuthority(record, authority);
        if (!latest.settlement || latest.settlement.receiptDigest !== nativeSettlementDigest(record.receipt)) throw new NativeWorkExecutionError('conflict'); return null; }, () => {});
    }));
    // Durable replay reconfirms directory durability, without reading Jev, artifacts or runner effects.
    if (current.settlement) return track(reconcile);
    const prior = settlements.get(id);
    if (prior) {
      if (prior.authority.authorityId !== identity.authorityId || prior.authority.authorityRevision !== identity.authorityRevision || !equalScopes(prior.authority.scopes, identity.scopes)) return Promise.reject(new NativeWorkExecutionError('conflict'));
      return prior.promise;
    }
    if (!deps.verification || !deps.storage.settle) return Promise.reject(new NativeWorkExecutionError('unavailable'));
    const verification = deps.verification; const publish = deps.storage.settle.bind(deps.storage);
    // This verification owner is explicitly captured even after restart. It grants no execution continuation.
    const owner: ActiveOwner = { authority, expected: ownerFacts.current, scope: ownerFacts.currentScope, claimed: false };
    const controller = new AbortController(); const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
    const recordDigest = nativeSettlementDigest(record);
    const assertCurrent = () => {
      signal.throwIfAborted(); const latest = deps.storage.current(key);
      if (!latest.record || nativeSettlementDigest(latest.record) !== recordDigest) throw new NativeWorkExecutionError('stale');
      assertRecord(latest, record, owner); signal.throwIfAborted();
    };
    const promise = track(async () => {
      assertCurrent();
      let proof: Awaited<ReturnType<typeof verifyNativeWorkExecution>>;
      try { proof = await verifyNativeWorkExecution({ execution: record, runner: { get: id => id === record.receipt?.contractId ? currentContract(record) : null, join: async id => { await requireRunner().join(id); await deps.joinForeground?.(id); await requireRunner().joinDurable?.(record.request.key); } }, port: deps.port, decisionLog: deps.decisionLog,
        settings: verification.settings(), readAccessFilter: verification.readAccessFilter, signal, assertCurrent }); } catch (error) {
        // Another authenticated host may have published while these reads were in flight.
        if (!closed && deps.storage.current(key).settlement) return reconcile();
        throw error;
      }
      return authority.withCurrent(owner.expected, async assertAuthority => deps.scopes.withCurrentScope(owner.scope, async assertScope => {
        // A concurrent settlement is reconciled under the same owner lock before any stale-target guard.
        return publish(key, latest => {
          assertAuthority(); assertScope(); inspectAuthority(record, authority);
          if (latest.settlement) return null;
          assertRecord(latest, record, owner); proof.assertCurrent();
          return { report: proof.report, attestation: proof.attestation, receiptDigest: nativeSettlementDigest(record.receipt), contractDigest: proof.contractDigest, actorId: owner.expected.principalId };
        }, () => { assertAuthority(); assertScope(); proof.assertCurrent(); signal.throwIfAborted(); });
      }));
    });
    const owned = { authority: identity, controller, promise }; settlements.set(id, owned); settlementFailures.delete(id);
    void promise.then(() => { if (settlements.get(id) === owned) settlements.delete(id); }, () => { if (settlements.get(id) === owned) settlements.delete(id); settlementFailures.add(id); });
    return promise;
  }
  function settleAfterCompletion(result: DurableStartedContract, authority: NativePairedExecutionAuthority): void {
    if (!deps.verification || deps.verification.automatic === false || closed) return;
    // Register lifetime now, before join/check await, and drain it during cancellation and close.
    void settle(result.admission.key, authority).catch(() => {});
  }
  async function cancelAndJoin(contractId: string, reason: string): Promise<void> {
    // The persisted receipt is already owner-validated. Cleanup cannot depend on
    // another protected status lookup: revocation may occur during cancellation.
    const foreground = Promise.resolve().then(() => deps.cancelForeground?.(contractId));
    const background = Promise.resolve().then(async () => { requireRunner().cancel(contractId, reason); await requireRunner().join(contractId); });
    const results = await Promise.allSettled([foreground, background]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async function cancelAttempt(workId: string, attemptId: string, suppliedTarget: NativeWorkExecutionTarget | undefined, authority: NativePairedExecutionAuthority, reason: string): Promise<void> {
    if (!reason.trim()) throw new NativeWorkExecutionError('invalid');
    const expected = paired(authority); const expectedScope = scope(); let validated = false;
    let validatedKey: string | undefined; const contractIds = new Set<string>();
    const drain = async () => {
      const operations = [...deliveries.values()].filter(delivery => delivery.target.workId === workId && delivery.target.attemptId === attemptId && delivery.identity.authorityId === expected.authorityId);
      for (const operation of operations) operation.controller.abort();
      for (const [id, settlement] of settlements) if (id === validatedKey) settlement.controller.abort();
      // Verification may be waiting for runner/foreground drainage. Cancel effects
      // before joining verification, otherwise each lifetime can wait on the other.
      const cleanup = new Map<string, Promise<void>>();
      const stopKnown = () => {
        const localContract = validatedKey ? active.get(validatedKey)?.contractId : undefined;
        if (localContract) contractIds.add(localContract);
        for (const id of contractIds) if (!cleanup.has(id)) { const stopping = cancelAndJoin(id, reason); void stopping.catch(() => {}); cleanup.set(id, stopping); }
      };
      stopKnown(); await Promise.allSettled(operations.map(operation => operation.promise)); stopKnown();
      // Preserve the already validated cleanup identity through a later revocation
      // or an association acknowledgement that arrives after cancellation.
      await Promise.allSettled([...settlements].filter(([id]) => id === validatedKey).map(([, settlement]) => settlement.promise));
      const results = await Promise.allSettled([...cleanup.values()]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    };
    try {
      await authority.withCurrent(expected, async assertAuthority => deps.scopes.withCurrentScope(expectedScope, async assertScope =>
        deps.storage.transactionByAttempt(attemptId, current => {
          assertOpen(); assertAuthority(); assertScope();
          const existing = current.record ?? current.intent;
          if (existing) {
            if (existing.target.workId !== workId) throw new NativeWorkExecutionError('not-found');
            inspectAuthority(existing, authority); validated = true; validatedKey = durableKeyHash(existing.request.key);
            if (current.record?.receipt) contractIds.add(current.record.receipt.contractId);
            if (current.intent?.state === 'associated' && !current.record) throw new NativeWorkExecutionError('recovery-required');
            return { next: current.record && current.record.state !== 'cancelled' ? { ...current.record, state: 'cancelled' } : null,
              nextIntent: current.intent && current.intent.state !== 'cancelled' ? { ...current.intent, state: 'cancelled' } : null, value: undefined };
          }
          if (!suppliedTarget) throw new NativeWorkExecutionError('not-found');
          const request = requestFor(current, suppliedTarget, expected, expectedScope); validated = true; validatedKey = durableKeyHash(request.key);
          const intent = parseNativeWorkExecutionIntent({ version: 1, projectId: deps.projectId, target: suppliedTarget, authorityScopes: expected.scopes, request, generation: 1, state: 'cancelled' });
          return { next: null, nextIntent: intent, value: undefined };
        })));
    } catch (error) {
      if (validated) { await Promise.allSettled([drain()]); if (!(error instanceof NativeWorkExecutionError)) throw new NativeWorkExecutionError('unavailable'); }
      throw error;
    }
    // Persist first, release locks, then abort and join real evaluation settlement.
    await drain();
  }
  async function retainReceipt(result: DurableStartedContract): Promise<DurableStartedContract> {
    const cancelled = await deps.storage.transaction(result.admission.key, current => {
      const record = current.record;
      if (!record || durablePayloadRevision(record.request) !== result.admission.payloadRevision) throw new NativeWorkExecutionError('conflict');
      if (record.receipt && (record.receipt.contractId !== result.admission.contractId || record.receipt.ownerAgentId !== result.admission.ownerAgentId)) throw new NativeWorkExecutionError('conflict');
      // The engine may remember a launch whose native acknowledgement was lost.
      // Never turn that replay into a fresh prepared operation or permission to resume.
      const state = record.state === 'prepared' && result.state !== 'prepared' ? 'launch-claimed' as const : record.state;
      return { next: record.receipt && state === record.state ? null : { ...record, receipt: result.admission, state }, value: record.state === 'cancelled' };
    });
    if (cancelled || closed) await cancelAndJoin(result.admission.contractId, 'Native work was cancelled during admission');
    return result;
  }
  const host: NativeWorkExecutionHost = {
    nativeOwner: { admission: { withCurrent }, decisions: { authorityOf(contract) {
      const key = contract.durableAdmission?.key; if (!key) throw new NativeWorkExecutionError('invalid');
      const owner = active.get(durableKeyHash(key)); const current = deps.storage.current(key);
      if (!owner || !current.record) throw new NativeWorkExecutionError('recovery-required');
      if (durablePayloadRevision(current.record.request) !== contract.durableAdmission?.payloadRevision
        || (current.record.receipt && current.record.receipt.contractId !== contract.id)) throw new NativeWorkExecutionError('conflict');
      assertRecord(current, current.record, owner);
      const binding = current.record.request.binding;
      return { authorityId: binding.authorityId, authorityRevision: binding.authorityRevision, scopeId: binding.scopeId, scopeRevision: binding.scopeRevision };
    } } },
    attachRunner(value) { assertOpen(); if (runner) throw new NativeWorkExecutionError('conflict'); runner = value; },
    start(input, authority, options = {}) {
      const target = captureTarget(input);
      return ownedDelivery(target, authority, options.signal, async (delivery, signal) => {
        requireRunner(); let record = deps.storage.currentByAttempt(target.attemptId).record;
        if (record) {
          if (!equalTarget(record.target, target) || record.state === 'cancelled') throw new NativeWorkExecutionError('conflict');
          inspectAuthority(record, authority);
        } else {
          const intent = await prepareIntent(target, authority, delivery, false, signal);
          record = await decide(target, authority, signal, false, intent);
        }
        claimOwner(record, authority);
        const result = await requireRunner().startDurable(record.request);
        try { const retained = await retainReceipt(result); settleAfterCompletion(retained, authority); return retained; }
        catch (error) { await cancelAndJoin(result.admission.contractId, 'Native association could not be retained'); throw error; }
      });
    },
    status(key, authority) { assertOpen(); return status(deps.storage.current(key), authority); },
    statusByAttempt(workId, attemptId, authority) {
      assertOpen(); const current = deps.storage.currentByAttempt(attemptId);
      const stored = current.record ?? current.intent;
      if (!stored || stored.target.workId !== workId) throw new NativeWorkExecutionError('not-found');
      if (current.record) return status(current, authority);
      const intent = current.intent!; inspectAuthority(intent, authority);
      if (intent.state === 'associated') throw new NativeWorkExecutionError('recovery-required');
      const work = current.ledger.works.find(item => item.id === workId);
      const attempt = current.ledger.attempts.find(item => item.id === attemptId && item.workId === workId);
      const delivery = deliveries.get(durableKeyHash(intent.request.key));
      return { kind: 'intent', intent, currentTarget: work && attempt ? { workId, attemptId, workRevision: work.revision, criteriaRevision: work.criteriaRevision, attemptRevision: attempt.revision } : null,
        currentAttempt: !!work && !!attempt && work.currentAttemptId === attemptId && attempt.state === 'active',
        recovery: intent.state === 'cancelled' ? 'cancelled' : intent.state === 'admitting' && delivery?.generation === intent.generation ? 'pending' : 'required' };
    },
    cancel(input, authority, reason) { const key = captureKey(input); return track(() => cancelAttempt(key.workId, key.attemptId, undefined, authority, reason)); },
    cancelTarget(input, authority, reason) { const target = captureTarget(input); return track(() => cancelAttempt(target.workId, target.attemptId, target, authority, reason)); },
    resume(input, authority, options = {}) {
      const key = captureKey(input); const current = deps.storage.currentByAttempt(key.attemptId); const stored = current.record ?? current.intent;
      if (!stored) return Promise.reject(new NativeWorkExecutionError('not-found'));
      if (durableKeyHash(stored.request.key) !== durableKeyHash(key)) return Promise.reject(new NativeWorkExecutionError('conflict'));
      return ownedDelivery(stored.target, authority, options.signal, async (delivery, signal) => {
        const latest = deps.storage.currentByAttempt(key.attemptId);
        if (!latest.record) {
          const intent = await prepareIntent(stored.target, authority, delivery, true, signal);
          const record = await decide(stored.target, authority, signal, false, intent);
          claimOwner(record, authority); const retained = await retainReceipt(await requireRunner().startDurable(record.request)); settleAfterCompletion(retained, authority); return retained;
        }
        const existing = latest.record; inspectAuthority(existing, authority);
        if (existing.state === 'cancelled') throw new NativeWorkExecutionError('stale');
        if (existing.state === 'launch-claimed' && !active.get(durableKeyHash(key))?.claimed) throw new NativeWorkExecutionError('recovery-required');
        signal.throwIfAborted();
        if (existing.state === 'prepared') await decide(existing.target, authority, signal, true);
        claimOwner(existing, authority);
        const retained = await retainReceipt(await requireRunner().resumeDurable(key)); settleAfterCompletion(retained, authority); return retained;
      });
    },
    settle,
    close() {
      if (closing) return closing; closed = true; lifetime.abort();
      const contracts = runner?.list({ includeTerminal: false }) ?? [];
      for (const contract of contracts) if (contract.durableAdmission && active.has(durableKeyHash(contract.durableAdmission.key))) runner?.cancel(contract.id, 'Native work host closed');
      closing = Promise.allSettled([...pending, ...contracts.map(contract => runner?.join(contract.id))]).then(() => { active.clear(); }); return closing;
    },
  };
  return host;
}

export { NativeWorkExecutionError };
export type { NativeWorkExecutionTarget, NativeWorkExecutionRecord, NativeWorkExecutionStorage, NativeWorkExecutionIntent };

export type { NativeWorkSettlementReceipt } from './native-settlement-types.js';
