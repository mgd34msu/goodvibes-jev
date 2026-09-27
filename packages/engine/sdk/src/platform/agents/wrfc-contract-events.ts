/**
 * The review loop's lifecycle on the `contracts` event domain. The loop runs
 * until the contract runner replaces it (ledger task R.10); until then it
 * reports through the same events the runner emits, so every consumer reads
 * one vocabulary. A chain is reported as a contract whose id is the chain id,
 * and its constraints as the contract's criteria. This file goes with the loop.
 */
import type { ContractStatus } from '../../events/contract.js';
import { emitContractEvent } from '../contract/events.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { Constraint } from './completion-report.js';
import type { WrfcChain, WrfcState } from './wrfc-types.js';

/** The contract status each review-loop state reports as. */
const STATUS_OF_STATE: Readonly<Record<WrfcState, ContractStatus>> = {
  pending: 'queued',
  engineering: 'running',
  integrating: 'running',
  reviewing: 'judging',
  fixing: 'fixing',
  awaiting_gates: 'judging',
  gating: 'judging',
  committing: 'committing',
  passed: 'passed',
  failed: 'failed',
};

/** A step id inside a chain (engineer, review, gate or fix round); ids only, nothing is emitted. */
export function wrfcStepId(chainId: string, suffix: string): string {
  return `${chainId}:${suffix}`;
}

function contractStatusOf(chain: Pick<WrfcChain, 'failureKind'>, state: WrfcState): ContractStatus {
  return state === 'failed' && chain.failureKind === 'cancelled' ? 'cancelled' : STATUS_OF_STATE[state];
}

export function emitWrfcChainCreated(bus: RuntimeEventBus, sessionId: string, chain: Pick<WrfcChain, 'id' | 'task' | 'ownerAgentId'>): void {
  emitContractEvent(bus, sessionId, {
    type: 'CONTRACT_CREATED',
    contractId: chain.id,
    sessionId,
    origin: 'agent-tool',
    ask: chain.task,
    ownerAgentId: chain.ownerAgentId,
  });
}

/** A state change, reported only when the contract status it maps to changes. */
export function emitWrfcStateChanged(
  bus: RuntimeEventBus,
  sessionId: string,
  chain: Pick<WrfcChain, 'id' | 'failureKind'>,
  from: WrfcState,
  to: WrfcState,
): void {
  const fromStatus = STATUS_OF_STATE[from];
  const toStatus = contractStatusOf(chain, to);
  if (fromStatus === toStatus) return;
  emitContractEvent(bus, sessionId, { type: 'CONTRACT_STATUS_CHANGED', contractId: chain.id, from: fromStatus, to: toStatus });
}

/** The chain's constraints, captured once, reported as the contract's plan criteria. */
export function emitWrfcConstraintsPlanned(bus: RuntimeEventBus, sessionId: string, chain: Pick<WrfcChain, 'id' | 'task'>, constraints: readonly Constraint[]): void {
  emitContractEvent(bus, sessionId, {
    type: 'CONTRACT_PLANNED',
    contractId: chain.id,
    goal: chain.task,
    criteria: constraints.map((constraint) => ({
      id: constraint.id,
      text: constraint.text,
      origin: 'stated' as const,
      serves: [],
      disposition: 'judged' as const,
    })),
    groups: [],
    units: [],
    repair: 0,
  });
}

/**
 * One review, reported as a deliverable check (or a unit check for a compound
 * sub-deliverable): each constraint met unless the review left it unsatisfied.
 * The review is a single verdict, so every reading is at act.
 */
export function emitWrfcReviewed(
  bus: RuntimeEventBus,
  sessionId: string,
  review: {
    readonly chainId: string;
    readonly targetId?: string | undefined;
    readonly cycle: number;
    readonly passed: boolean;
    readonly constraints: readonly Constraint[];
    readonly unsatisfiedConstraintIds: readonly string[];
  },
): void {
  const unsatisfied = new Set(review.unsatisfiedConstraintIds);
  const targetId = review.targetId ?? review.chainId;
  emitContractEvent(bus, sessionId, {
    type: 'CONTRACT_CHECKED',
    contractId: review.chainId,
    scope: review.targetId === undefined ? 'deliverable' : 'unit',
    targetId,
    checkId: `${targetId}.k${review.cycle}`,
    trigger: 'completion',
    result: review.passed ? 'pass' : 'nudge',
    criteria: review.constraints.map((constraint) => {
      const unmet = unsatisfied.has(constraint.id);
      return { criterionId: constraint.id, verdict: unmet ? 'unmet' as const : 'met' as const, probabilityUnmet: unmet ? 1 : 0, outcome: 'act' as const };
    }),
    goal: { verdict: review.passed ? 'met' : 'unmet', outcome: 'act' },
    quality: [],
    gates: [],
    decisionIds: [],
  });
}

/** A fix round: the review or gate failures handed to a fixer. */
export function emitWrfcFixRound(
  bus: RuntimeEventBus,
  sessionId: string,
  fix: { readonly chainId: string; readonly targetId?: string | undefined; readonly round: number },
): void {
  const targetId = fix.targetId ?? fix.chainId;
  emitContractEvent(bus, sessionId, {
    type: 'CONTRACT_FIX_PLANNED',
    contractId: fix.chainId,
    scope: fix.targetId === undefined ? 'deliverable' : 'unit',
    targetId,
    groupId: `${targetId}.f${fix.round}`,
    unitIds: [],
    round: fix.round,
  });
}

export function emitWrfcGateResult(
  bus: RuntimeEventBus,
  sessionId: string,
  gate: { readonly chainId: string; readonly gate: string; readonly passed: boolean; readonly skipped: boolean; readonly durationMs: number },
): void {
  emitContractEvent(bus, sessionId, {
    type: 'CONTRACT_GATE_RESULT',
    contractId: gate.chainId,
    targetId: gate.chainId,
    gate: gate.gate,
    passed: gate.passed,
    skipped: gate.skipped,
    durationMs: gate.durationMs,
  });
}

export function emitWrfcAutoCommitted(bus: RuntimeEventBus, sessionId: string, chainId: string, hash: string | undefined, note: string): void {
  emitContractEvent(bus, sessionId, {
    type: 'CONTRACT_COMMITTED',
    contractId: chainId,
    status: 'committed',
    ...(hash !== undefined ? { hash } : {}),
    note,
  });
}

/** A passed chain: its constraints were all met (the review cannot pass otherwise); fix rounds count as corrections. */
export function emitWrfcChainPassed(bus: RuntimeEventBus, sessionId: string, chain: Pick<WrfcChain, 'id' | 'constraints' | 'fixAttempts'>): void {
  emitContractEvent(bus, sessionId, {
    type: 'CONTRACT_PASSED',
    contractId: chain.id,
    criteriaMet: chain.constraints.length,
    criteriaJudged: chain.constraints.length,
    excluded: 0,
    nudges: chain.fixAttempts,
  });
}

export function emitWrfcChainFailed(
  bus: RuntimeEventBus,
  sessionId: string,
  failure: {
    readonly chainId: string;
    readonly reason: string;
    readonly failureKind: 'transport' | 'other' | 'max_turns';
    readonly membersSettled: boolean;
    readonly turnLimit?: number | undefined;
    readonly turnLimitSource?: 'default' | 'spawn-override' | 'policy-bound' | undefined;
  },
): void {
  emitContractEvent(bus, sessionId, {
    type: 'CONTRACT_FAILED',
    contractId: failure.chainId,
    reason: failure.reason,
    failureKind: failure.failureKind,
    membersSettled: failure.membersSettled,
    ...(failure.turnLimit !== undefined ? { turnLimit: failure.turnLimit } : {}),
    ...(failure.turnLimitSource !== undefined ? { turnLimitSource: failure.turnLimitSource } : {}),
  });
}

export function emitWrfcChainCancelled(bus: RuntimeEventBus, sessionId: string, chainId: string, reason: string, filesModified: number): void {
  emitContractEvent(bus, sessionId, { type: 'CONTRACT_CANCELLED', contractId: chainId, reason, filesModified });
}
