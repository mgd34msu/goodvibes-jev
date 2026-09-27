/**
 * One running contract's state and bookkeeping (docs/design/contract-runner.md
 * sections 2.3 and 4): the live contract tree, its orchestration engine, and
 * what the runner keeps in memory per unit (the agent's turns, a pending
 * completion hold, the check in flight, the phase's settlement).
 *
 * Every status move goes through the transition tables and emits its event;
 * every runner decision is appended to the contract's decision list. The
 * correction and completion steps (R.6) act on a contract through this class.
 */
import { JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import type { ContractEvent } from '../../events/contract.js';
import type { OrchestrationEngine } from '../orchestration/engine.js';
import type { ContractUnitOutcome } from '../orchestration/phase-runner.js';
import { summarizeError } from '../utils/error-display.js';
import type { ContractHoldOutcome } from './agent-hooks.js';
import type { ContractConfig } from './config.js';
import type { ContractTurnRecord } from './evidence.js';
import {
  isTerminalContractStatus,
  isTerminalUnitStatus,
  transitionContract,
  transitionGroup,
  transitionUnit,
  type Contract,
  type ContractDecisionAction,
  type ContractFailureKind,
  type ContractGroup,
  type ContractStatus,
  type ContractUnit,
  type ContractView,
  type GroupStatus,
  type UnitRoute,
  type UnitStatus,
} from './types.js';

/** Why a fresh agent was spawned for a unit (the CONTRACT_UNIT_SPAWNED purpose). */
export type SpawnPurpose = 'unit' | 'fresh-unit' | 'transport-retry' | 'silence-retry' | 'resume';

/** A check in flight for a unit. */
export interface InFlightCheck {
  readonly trigger: ContractUnit['checks'][number]['trigger'];
  readonly abort: AbortController;
  /** A completion arrived while this turn-end check ran: its result is discarded. */
  superseded: boolean;
}

/** What the runner keeps in memory for one unit. */
export interface UnitRuntime {
  /** Every turn the unit's agents reported, oldest first: commands and written paths for evidence. */
  readonly turns: ContractTurnRecord[];
  /** The last assistant text a turn reported: a mid-run check's output. */
  lastAssistantText: string;
  /** The agent held at its completion point, waiting for a check. */
  hold: { readonly agentId: string; readonly resolve: (outcome: ContractHoldOutcome) => void } | null;
  check: InFlightCheck | null;
  /** A turn end arrived while a check ran: one more turn-end check follows it. */
  recheckPending: boolean;
  /** The phase runner waiting for the runner to settle the unit's current agent. */
  settlement: { readonly agentId: string; readonly resolve: (outcome: ContractUnitOutcome) => void } | null;
  /** Agents the runner itself cancelled; their cancel events are not operator stops. */
  readonly expectedCancels: Set<string>;
  /** Why the next agent for this unit will be spawned. */
  nextSpawnPurpose: SpawnPurpose;
  /** When the active agent was spawned. */
  agentStartedAt: number;
  /** Where the unit's agent works: its item worktree, or the shared project root. */
  cwd: string;
  /** Aborted when the unit is cancelled or failed; checks run under it. */
  readonly abort: AbortController;
}

/** What a contract failure reads as, from the error that caused it. */
export function failureFromError(error: unknown): { readonly kind: ContractFailureKind; readonly reason: string } {
  if (error instanceof JudgmentPortMissingError) return { kind: 'judgment-unavailable', reason: error.message };
  if (error instanceof JudgmentError && error.kind !== 'aborted') return { kind: 'judgment-unavailable', reason: `Jev could not answer: ${error.message}` };
  return { kind: 'other', reason: summarizeError(error) };
}

/** An error thrown because a check or read was stopped on purpose. */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof JudgmentError && error.kind === 'aborted') || (error instanceof Error && error.name === 'AbortError');
}

export interface RunEnv {
  readonly now: () => number;
  readonly config: () => ContractConfig;
  /** Emits on the runtime bus with the contract's context, and to the runner's listeners. */
  readonly emit: (contract: Contract, event: ContractEvent) => void;
  /** An agent's silence clock restarts (a hold released: held time is not silence). */
  readonly touchAgent: (agentId: string) => void;
}

/**
 * What the correction and completion steps may do to a running contract
 * beyond moving statuses: pass a group, finish the contract, fail or cancel it.
 */
export interface RunControl {
  /** The group passed its group check (or has no criteria): dependents start, and when every group passed the deliverable is next. */
  passGroup(groupId: string): void;
  /** The deliverable passed and was committed: the contract passes and the owner record completes with the answer. */
  finishPassed(result: { readonly answer: string; readonly statusLine: string }): void;
  fail(kind: ContractFailureKind, reason: string): void;
  cancel(reason: string): void;
}

export class ContractRun {
  /** The contract's orchestration engine, once its plan is accepted. */
  engine: OrchestrationEngine | null = null;
  /** Aborted when the contract ends: shaping, planning and waits for the shared tree stop. */
  readonly abort = new AbortController();
  readonly unitRuntimes = new Map<string, UnitRuntime>();
  /** Releases the shared-tree lock held by a running group (shared mode). */
  readonly sharedTreeReleases = new Map<string, () => void>();
  /** Stops listening to the engine. */
  unsubscribeEngine: (() => void) | null = null;
  /** Set once the owner record has been settled, so it is settled once. */
  ownerSettled = false;
  /** Groups whose start (lock, routes, workstream) is under way. */
  readonly startingGroups = new Set<string>();
  /** Groups whose units all passed and were handed to the group step. */
  readonly settledGroups = new Set<string>();

  constructor(
    readonly contract: Contract,
    readonly env: RunEnv,
    readonly control: RunControl,
    /** Units an agent-tool batch or AgentInput.proposedUnits proposed, for the planner. */
    readonly proposedUnits?: readonly { readonly task: string; readonly template?: string | undefined }[] | undefined,
  ) {}

  get id(): string {
    return this.contract.id;
  }

  get terminal(): boolean {
    return isTerminalContractStatus(this.contract.status);
  }

  /** A deep copy, for callers outside the runner. */
  view(): ContractView {
    return structuredClone(this.contract);
  }

  emit(event: ContractEvent): void {
    this.env.emit(this.contract, event);
  }

  decide(action: ContractDecisionAction, targetId: string, reason: string, decisionIds: readonly string[] = [], route?: UnitRoute): void {
    const { contract } = this;
    contract.decisions.push({
      id: `${contract.id}.d${contract.decisions.length + 1}`,
      at: this.env.now(),
      action,
      targetId,
      reason,
      decisionIds: [...decisionIds],
      ...(route === undefined ? {} : { route }),
    });
  }

  moveContract(to: ContractStatus): void {
    if (this.contract.status === to) return;
    const change = transitionContract(this.contract, to);
    this.emit({ type: 'CONTRACT_STATUS_CHANGED', contractId: this.id, from: change.from, to: change.to });
  }

  moveGroup(group: ContractGroup, to: GroupStatus): void {
    if (group.status === to) return;
    const change = transitionGroup(group, to);
    this.emit({ type: 'CONTRACT_GROUP_STATUS_CHANGED', contractId: this.id, groupId: group.id, from: change.from, to: change.to });
  }

  moveUnit(unit: ContractUnit, to: UnitStatus): void {
    if (unit.status === to) return;
    const change = transitionUnit(unit, to);
    this.emit({
      type: 'CONTRACT_UNIT_STATUS_CHANGED',
      contractId: this.id,
      groupId: unit.groupId,
      unitId: unit.id,
      from: change.from,
      to: change.to,
      ...(unit.activeAgentId === undefined ? {} : { agentId: unit.activeAgentId }),
    });
  }

  /** Every unit of the plan and every attempt unit of a best-of-N unit (design 6.2). */
  allUnits(): ContractUnit[] {
    return this.contract.units.flatMap((unit) => [unit, ...(unit.attemptUnits ?? [])]);
  }

  /** A plan unit or an attempt unit, by id. */
  unit(unitId: string): ContractUnit | undefined {
    return this.allUnits().find((unit) => unit.id === unitId);
  }

  group(groupId: string): ContractGroup | undefined {
    return this.contract.groups.find((group) => group.id === groupId);
  }

  /** The unit's in-memory state, created on first use. */
  runtime(unit: ContractUnit): UnitRuntime {
    let runtime = this.unitRuntimes.get(unit.id);
    if (runtime === undefined) {
      runtime = {
        turns: [],
        lastAssistantText: '',
        hold: null,
        check: null,
        recheckPending: false,
        settlement: null,
        expectedCancels: new Set(),
        nextSpawnPurpose: 'unit',
        agentStartedAt: this.env.now(),
        cwd: this.contract.worktreePath ?? this.contract.projectRoot,
        abort: new AbortController(),
      };
      this.unitRuntimes.set(unit.id, runtime);
    }
    return runtime;
  }

  /** The unit and runtime an agent belongs to, when it is that unit's active agent. */
  activeUnitOf(agentId: string): { readonly unit: ContractUnit; readonly runtime: UnitRuntime } | null {
    const unit = this.allUnits().find((candidate) => candidate.activeAgentId === agentId);
    if (unit === undefined) return null;
    return { unit, runtime: this.runtime(unit) };
  }

  /** Resolves a unit's pending completion hold, if any. */
  releaseHold(unit: ContractUnit, outcome: ContractHoldOutcome = { kind: 'release' }): void {
    const runtime = this.unitRuntimes.get(unit.id);
    const hold = runtime?.hold;
    if (runtime === undefined || hold === null || hold === undefined) return;
    runtime.hold = null;
    this.env.touchAgent(hold.agentId);
    hold.resolve(outcome);
  }

  /** Resolves the phase runner's wait on a unit's current agent. */
  settle(unit: ContractUnit, outcome: ContractUnitOutcome): void {
    const runtime = this.unitRuntimes.get(unit.id);
    const settlement = runtime?.settlement;
    if (runtime === undefined || settlement === null || settlement === undefined) return;
    runtime.settlement = null;
    settlement.resolve(outcome);
  }

  /** Ends every unit that is not terminal with `to` (holds released, checks aborted), and every open group. */
  endOpenUnits(to: 'failed' | 'cancelled', reason: string): void {
    for (const unit of this.allUnits()) {
      const runtime = this.unitRuntimes.get(unit.id);
      runtime?.abort.abort();
      this.releaseHold(unit);
      if (isTerminalUnitStatus(unit.status)) continue;
      if (to === 'failed') unit.failureReason ??= reason;
      this.moveUnit(unit, to);
    }
    for (const group of this.contract.groups) {
      if (group.status === 'passed' || group.status === 'failed' || group.status === 'cancelled') continue;
      // A group that holds a failed unit failed with it; the others stop with the contract. A failed attempt of a best-of-N unit is not the unit failing.
      const holdsFailure = this.contract.units.some((unit) => unit.groupId === group.id && unit.status === 'failed');
      this.moveGroup(group, holdsFailure ? 'failed' : to);
    }
  }
}
