/** Native semantic ownership. Registered continuations never run through an owner reply or a fake tool. */
import { hashState, JudgmentError, type EntryType, type JudgmentPort, type JudgmentRetryProgress } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { captureJevDecisionContext, parseJevDecision, type JevDecision, type JevDecisionBinding, type JevVersionRef } from '@goodvibes-jev/judgment/decisions';
import { decideAutonomous, type AutonomousDecision } from '../gate/autonomous-decision.js';
import { autonomousSourceEvidence } from '../permissions/autonomous.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { assertNativeContractSource, nativeContractSourceForAdmission } from './native-source.js';
import { assertDurableCheckpoint } from './durable-admission.js';
import { isTerminalContractStatus, type Contract, type ContractView, type ContractRouteSelector } from './types.js';

export type NativeContractStage = 'shape' | 'plan' | 'evidence' | 'stall' | 'fix-plan' | 'attempts';
export interface NativeContractAuthority {
  readonly authorityId: string;
  readonly authorityRevision: string;
  readonly scopeId: string;
  readonly scopeRevision: string;
}
export interface NativeContractCondition {
  readonly ref: JevVersionRef;
  readonly description: string;
  /** Host-owned observation. Resolving without a changed registered revision is an error. */
  wait(signal: AbortSignal): Promise<void>;
  current(): JevVersionRef;
}
export interface NativeContractDecisionHost {
  /** Authenticated native host ownership, rebuilt before every transport attempt and continuation. */
  authorityOf(contract: ContractView): NativeContractAuthority;
  /** External evidence/resource changes only. Never approval or Jev availability. */
  conditions?(contract: ContractView, stage: NativeContractStage, targetId: string): readonly NativeContractCondition[];
  onRetry?(contractId: string, progress: JudgmentRetryProgress): void;
  /** Typed semantic notification; observer failure cannot change the decision or execute work. */
  onDecision?(contractId: string, record: NativeContractDecisionRecord): void;
}
export interface NativeContractServices {
  readonly host: NativeContractDecisionHost;
  changed(contract: Contract): void;
  /** Existing authoritative contract store must finish this write before a budgeted continuation starts. */
  checkpoint?(contract: Contract): void;
  cancel?(contract: Contract, reason: string): void;
}
export interface NativeContractDecisionRecord {
  readonly schemaVersion: 1;
  readonly stage: NativeContractStage;
  readonly targetId: string;
  readonly decision: JevDecision;
  readonly operationRevision: string;
}
export interface NativeContractDecisionState {
  readonly schemaVersion: 1;
  readonly history: NativeContractDecisionRecord[];
  /** A deferred receipt is a pending condition, never a saved permission to execute. */
  readonly pending: Record<string, NativeContractDecisionRecord>;
  /** Monotonic planner/correction budgets survive process restarts. */
  readonly spent: Record<string, number>;
  readonly plannerOutputs: Record<string, string>;
  readonly attemptChoices: Record<string, string>;
  readonly attemptedChoices: Record<string, string[]>;
}
export interface NativeContractProgress {
  readonly schemaVersion: 1;
  readonly state: 'deciding' | 'deferred' | 'refused';
  readonly stage: string;
  readonly targetId: string;
  readonly until?: JevVersionRef | undefined;
}
export interface NativeContractTransportProgress {
  readonly schemaVersion: 1;
  readonly requests: readonly JudgmentRetryProgress[];
}
const waiting = new WeakMap<Contract, Map<string, JudgmentRetryProgress>>();
function readLifetime(contract: Contract, owner: NativeContractServices, signal?: AbortSignal) {
  const expected = authority(contract, owner);
  const owned = new Set<string>();
  const active = () => { checkAlive(contract, signal); if (JSON.stringify(authority(contract, owner)) !== JSON.stringify(expected)) { owner.cancel?.(contract, 'Native authority or scope changed'); throw new JudgmentError('aborted', 'Native authority or scope changed'); } };
  const publish = () => { const current = waiting.get(contract); contract.nativeWaiting = current?.size ? { schemaVersion: 1, requests: [...current.values()] } : undefined; owner.changed(contract); };
  return { beforeAttempt: active,
    onRetry(progress: JudgmentRetryProgress) { if (isTerminalContractStatus(contract.status)) return; const current = waiting.get(contract) ?? new Map<string, JudgmentRetryProgress>(); waiting.set(contract, current); current.set(progress.logicalRequestId, progress); owned.add(progress.logicalRequestId); publish(); owner.host.onRetry?.(contract.id, progress); },
    finish() { for (const id of owned) waiting.get(contract)?.delete(id); if (owned.size > 0) publish(); },
  };
}
/** Routing uses the same owner signal and before-attempt guard as every other native read. */
export async function nativeContractRoute(selector: ContractRouteSelector, contract: Contract, services: NativeContractServices | undefined, request: Parameters<ContractRouteSelector>[0], signal?: AbortSignal) {
  if (contract.nativeSource === undefined) return selector({ ...request, signal });
  autonomousSourceEvidence(nativeContractSourceForAdmission(contract));
  const scope = readLifetime(contract, ownedServices(services), signal);
  try { scope.beforeAttempt(); const route = await selector({ ...request, signal, beforeAttempt: scope.beforeAttempt, onRetry: scope.onRetry }); scope.beforeAttempt(); return route; }
  finally { scope.finish(); }
}

export interface NativeContractContinuation {
  readonly id: string;
  readonly kind: 'reconsider' | 'gather-evidence' | 'revise-action';
  readonly description: string;
  readonly input?: EntryType | undefined;
}
export interface NativeContractDecisionInput {
  readonly stage: NativeContractStage;
  readonly targetId: string;
  readonly action: string;
  readonly allowAct: boolean;
  /** Rebuild only this operation's current evidence/limits, not unrelated parallel progress. */
  readonly state: () => EntryType;
  readonly continuations: readonly NativeContractContinuation[];
  readonly decisionIds?: readonly string[] | undefined;
  readonly signal: AbortSignal;
}
export interface NativeContractDecision extends AutonomousDecision {
  readonly continuationId?: string | undefined;
}

const INSTRUCTIONS = 'Decide the exact native contract operation from the complete original goal and ordered criteria, current evidence, deterministic constraints and remaining budgets. Do not replace requirements, mark unshown work met, override delegation or capability boundaries, or reset a spent correction budget. Act only on the exact offered operation when supported. Revise selects only a registered eligible continuation. Defer waits only for a registered external condition, never a person or Jev availability. Reject when no permissible continuation can meet the original task. No human will approve this work.';

export function nativeDecisionState(contract: Contract): NativeContractDecisionState {
  if (contract.nativeSource === undefined) throw new JudgmentError('invalid-request', 'Native decisions require the original source');
  return contract.nativeDecisions ??= { schemaVersion: 1, history: [], pending: {}, spent: {}, plannerOutputs: {}, attemptChoices: {}, attemptedChoices: {} };
}
export function nativeSpent(contract: Contract, key: string): number { return nativeDecisionState(contract).spent[key] ?? 0; }
export function spendNative(contract: Contract, services: NativeContractServices | undefined, key: string): number {
  const state = nativeDecisionState(contract);
  const count = (state.spent[key] ?? 0) + 1;
  state.spent[key] = count;
  if (services?.checkpoint !== undefined) services.checkpoint(contract); else services?.changed(contract);
  return count;
}
function ownedServices(services: NativeContractServices | undefined): NativeContractServices {
  if (services === undefined) throw new JudgmentError('invalid-request', 'Native contract requires its authenticated semantic owner');
  return services;
}
function authority(contract: Contract, services: NativeContractServices): NativeContractAuthority {
  assertNativeContractSource(contract);
  if (contract.durableAdmission !== undefined) assertDurableCheckpoint(contract, contract.durableAdmission);
  const result = services.host.authorityOf(structuredClone(contract));
  const binding = captureJevDecisionContext({ decisionId: 'authority', binding: { sourceId: 'source', inputRevision: 'input', actionId: 'action', actionRevision: 'revision', ...result }, judgmentDecisionIds: [], evidence: [], continuations: [], resumeConditions: [] }).binding;
  return { authorityId: binding.authorityId, authorityRevision: binding.authorityRevision, scopeId: binding.scopeId, scopeRevision: binding.scopeRevision };
}
function checkAlive(contract: Contract, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (isTerminalContractStatus(contract.status)) throw new JudgmentError('aborted', 'Native contract ended');
  assertNativeContractSource(contract);
}
function authorityIdentity(value: NativeContractAuthority): NativeContractAuthority {
  return { authorityId: value.authorityId, authorityRevision: value.authorityRevision, scopeId: value.scopeId, scopeRevision: value.scopeRevision };
}
/** External evidence may advance a deferred operation; a different owner or scope may not adopt it. */
function assertAuthority(contract: Contract, owner: NativeContractServices, expected: NativeContractAuthority, signal: AbortSignal): void {
  checkAlive(contract, signal);
  if (JSON.stringify(authority(contract, owner)) !== JSON.stringify(authorityIdentity(expected))) {
    owner.cancel?.(contract, 'Native authority or scope changed');
    throw new JudgmentError('aborted', 'Native authority or scope changed');
  }
}

/** Source getter for a construction-bound native member's real tool runtime. */
export function nativeContractActionSource(contract: Contract, services: NativeContractServices | undefined, signal: AbortSignal): () => ReturnType<typeof nativeContractSourceForAdmission> {
  const owner = ownedServices(services);
  const expected = authorityIdentity(contract.durableAdmission?.binding ?? authority(contract, owner));
  return () => {
    assertAuthority(contract, owner, expected, signal);
    return nativeContractSourceForAdmission(contract);
  };
}

/** Decorates the single shared transport; owns no retry loop and cannot turn an outage into a decision. */
export function nativeContractPort(contract: Contract, services: NativeContractServices | undefined, port: JudgmentPort, signal?: AbortSignal): JudgmentPort {
  if (contract.nativeSource === undefined) return port;
  const owner = ownedServices(services);
  return {
    ...port,
    async ask(request) {
      const lifetime = readLifetime(contract, owner, signal);
      const active = () => { lifetime.beforeAttempt(); request.signal?.throwIfAborted(); request.beforeAttempt?.(); };
      const combined = signal === undefined ? request.signal : request.signal === undefined ? signal : AbortSignal.any([signal, request.signal]);
      const originalSource = autonomousSourceEvidence(nativeContractSourceForAdmission(contract));
      const state = request.state !== null && typeof request.state === 'object' && !Array.isArray(request.state)
        ? { ...request.state, originalSource } : { input: request.state, originalSource };
      try {
        active();
        const result = await port.ask({ ...request, state: state as unknown as EntryType, ...(combined === undefined ? {} : { signal: combined }), beforeAttempt: active,
          onRetry(progress) { lifetime.onRetry(progress); request.onRetry?.(progress); },
        });
        active(); return result;
      } finally { lifetime.finish(); }
    },
  };
}

function nativeSemanticPort(contract: Contract, owner: NativeContractServices, signal: AbortSignal): JudgmentPort {
  const port = judgmentPort('contract.native');
  const metered: JudgmentPort = { ...port, async ask(request) {
    const result = await port.ask(request);
    contract.judgmentUsage.calls += 1;
    contract.judgmentUsage.inputTokens += result.usage.inputTokens;
    contract.judgmentUsage.outputTokens += result.usage.outputTokens;
    owner.changed(contract);
    return result;
  } };
  return nativeContractPort(contract, owner, metered, signal);
}

/** Reconstructs current bindings after a real external change. No stored receipt is replayed on resume. */
export async function decideNativeContract(contract: Contract, services: NativeContractServices | undefined, input: NativeContractDecisionInput): Promise<NativeContractDecision> {
  const owner = ownedServices(services);
  const state = nativeDecisionState(contract);
  const key = `${input.stage}:${input.targetId}`;
  // Keep the admission identity through every condition wait and fresh reading.
  // After restart, the pending receipt supplies that identity rather than the new host state.
  const expectedAuthority = authorityIdentity(state.pending[key]?.decision.binding ?? authority(contract, owner));
  for (;;) {
    assertAuthority(contract, owner, expectedAuthority, input.signal);
    const source = nativeContractSourceForAdmission(contract);
    const evidence = snapshotJudgmentInput(input.state()) as EntryType;
    const conditions = [...(owner.host.conditions?.(structuredClone(contract), input.stage, input.targetId) ?? [])];
    const capturedConditions = conditions.map(condition => ({ ref: { ...condition.ref }, description: condition.description }));
    const operationRevision = hashState({ action: input.action, allowAct: input.allowAct, evidence, source, continuations: input.continuations } as unknown as EntryType);
    const actionRevision = hashState({ operationRevision, conditions: capturedConditions.map(condition => condition.ref) } as unknown as EntryType);
    const previous = state.pending[key];
    if (previous?.decision.outcome === 'defer' && previous.operationRevision === operationRevision) {
      const until = previous.decision.until;
      const condition = conditions.find(candidate => candidate.ref.id === until.id);
      if (condition === undefined) throw new JudgmentError('invalid-request', 'Registered native resume condition is unavailable');
      const current = condition.current();
      if (current.id !== until.id) throw new JudgmentError('invalid-request', 'Native condition identity changed');
      if (current.revision === until.revision) {
        contract.nativeProgress = { schemaVersion: 1, state: 'deferred', stage: input.stage, targetId: input.targetId, until };
        owner.changed(contract);
        await condition.wait(input.signal);
        assertAuthority(contract, owner, expectedAuthority, input.signal);
        const changed = condition.current();
        if (changed.id !== until.id || changed.revision === until.revision) throw new JudgmentError('invalid-response', 'Native condition resolved without new evidence');
      }
      delete state.pending[key];
      // The condition catalog itself is recaptured; its new revision enters the next decision input.
      continue;
    }
    delete state.pending[key];
    const binding: JevDecisionBinding = { sourceId: contract.nativeSource!.sourceId, inputRevision: contract.nativeSource!.inputRevision,
      actionId: `${contract.id}:${key}`, actionRevision, ...expectedAuthority };
    const active = () => {
      assertAuthority(contract, owner, expectedAuthority, input.signal);
      if (hashState(snapshotJudgmentInput(input.state()) as EntryType) !== hashState(evidence)) { owner.cancel?.(contract, 'Native operation was superseded'); throw new JudgmentError('aborted', 'Native operation was superseded'); }
      for (const [index, condition] of conditions.entries()) {
        const current = condition.current(); const captured = capturedConditions[index]!.ref;
        if (current.id !== captured.id || current.revision !== captured.revision) { owner.cancel?.(contract, 'Native condition catalog changed'); throw new JudgmentError('aborted', 'Native condition catalog changed'); }
      }
    };
    contract.nativeProgress = { schemaVersion: 1, state: 'deciding', stage: input.stage, targetId: input.targetId }; owner.changed(contract);
    const result = await decideAutonomous({ port: nativeSemanticPort(contract, owner, input.signal),
      site: `contract.native.${input.stage}`, instructions: INSTRUCTIONS, actionDescription: input.action, binding,
      state: { source: autonomousSourceEvidence(source), evidence, externalConditions: capturedConditions.map(condition => ({ description: condition.description })) } as unknown as EntryType,
      evidence: [{ id: 'native-source', revision: hashState(source as unknown as EntryType) }, { id: 'operation-evidence', revision: hashState(evidence) },
        { id: contract.nativeSource!.criteriaId, revision: contract.nativeSource!.criteriaRevision }, { id: 'source-revision', revision: contract.nativeSource!.sourceRevision }],
      supportingDecisionIds: input.decisionIds,
      continuations: input.continuations.map(continuation => ({ ref: { id: continuation.id, kind: continuation.kind, revision: actionRevision }, description: continuation.description, input: continuation.input ?? null })),
      conditions: capturedConditions, allowAct: input.allowAct, assertCurrent: active, signal: input.signal,
    });
    result.assertCurrent();
    const record: NativeContractDecisionRecord = { schemaVersion: 1, stage: input.stage, targetId: input.targetId, operationRevision, decision: result.decision };
    state.history.push(record);
    try { owner.host.onDecision?.(contract.id, structuredClone(record)); } catch { /* An observer cannot decide or duplicate execution. */ }
    if (result.decision.outcome === 'defer') {
      state.pending[key] = record;
      contract.nativeProgress = { schemaVersion: 1, state: 'deferred', stage: input.stage, targetId: input.targetId, until: result.decision.until };
      if (owner.checkpoint !== undefined) owner.checkpoint(contract); else owner.changed(contract);
      continue;
    }
    contract.nativeProgress = result.decision.outcome === 'reject' ? { schemaVersion: 1, state: 'refused', stage: input.stage, targetId: input.targetId } : undefined;
    if (owner.checkpoint !== undefined) owner.checkpoint(contract); else owner.changed(contract);
    return { ...result, ...(result.decision.outcome === 'revise' ? { continuationId: result.decision.next.id } : {}) };
  }
}

/** Restart waits for the real registered condition before any unit, planner or checker is restarted. */
export async function awaitNativeResumeConditions(contract: Contract, services: NativeContractServices | undefined, signal: AbortSignal): Promise<void> {
  if (contract.nativeSource === undefined) return;
  const owner = ownedServices(services);
  for (const record of Object.values(contract.nativeDecisions?.pending ?? {})) {
    if (record.decision.outcome !== 'defer') continue;
    assertAuthority(contract, owner, record.decision.binding, signal);
    const until = record.decision.until;
    const condition = owner.host.conditions?.(structuredClone(contract), record.stage, record.targetId).find(item => item.ref.id === until.id);
    if (condition === undefined) throw new JudgmentError('invalid-request', 'Deferred native condition must be re-registered before resume');
    const current = condition.current();
    if (current.id !== until.id) throw new JudgmentError('invalid-request', 'Native condition identity changed');
    if (current.revision === until.revision) {
      contract.nativeProgress = { schemaVersion: 1, state: 'deferred', stage: record.stage, targetId: record.targetId, until }; owner.changed(contract);
      await condition.wait(signal); assertAuthority(contract, owner, record.decision.binding, signal);
      const changed = condition.current();
      if (changed.id !== until.id || changed.revision === until.revision) throw new JudgmentError('invalid-response', 'Native condition did not change on resume');
    }
    // Keep the old receipt for the actual stage to invalidate and obtain a fresh decision. Never execute it here.
  }
}

/** Stored native history is inspectable but never parsed as an executable callback or affirmative owner reply. */
export function validateNativeDecisionState(contract: Contract): void {
  const state = contract.nativeDecisions;
  if (state === undefined) return;
  if (contract.nativeSource === undefined || state.schemaVersion !== 1 || !Array.isArray(state.history)
    || !state.pending || typeof state.pending !== 'object' || Array.isArray(state.pending) || !state.spent || typeof state.spent !== 'object' || Array.isArray(state.spent)
    || !state.plannerOutputs || typeof state.plannerOutputs !== 'object' || Object.values(state.plannerOutputs).some(value => typeof value !== 'string')
    || !state.attemptChoices || typeof state.attemptChoices !== 'object' || Object.values(state.attemptChoices).some(value => typeof value !== 'string')
    || !state.attemptedChoices || typeof state.attemptedChoices !== 'object' || Object.values(state.attemptedChoices).some(value => !Array.isArray(value) || value.some(item => typeof item !== 'string'))
    || Object.values(state.spent).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid native semantic state');
  for (const entry of [...state.history, ...Object.values(state.pending)]) {
    if (entry.schemaVersion !== 1 || typeof entry.operationRevision !== 'string' || !['shape', 'plan', 'evidence', 'stall', 'fix-plan', 'attempts'].includes(entry.stage) || typeof entry.targetId !== 'string') throw new Error('Invalid native semantic record');
    const decision = parseJevDecision(entry.decision);
    if (decision.binding.sourceId !== contract.nativeSource.sourceId || decision.binding.inputRevision !== contract.nativeSource.inputRevision) throw new Error('Native decision source mismatch');
  }
}
