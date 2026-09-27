/**
 * What a unit agent's terminal events mean to its contract
 * (docs/design/contract-runner.md sections 4.2, 4.9, 4.10 and 6.5).
 *
 * - Completed: the unit passed (its hold released) and its phase settles; an
 *   agent that completed without being held is checked now.
 * - Failed on its turn budget or the circuit breaker: checked with trigger
 *   `agent-failed`; a nudge wakes it.
 * - Failed otherwise: Jev reads the error (`readFailure`, site
 *   `contract.transport-retry`). A transient network fault or a failure before
 *   any response is retried with a fresh agent, up to
 *   `contract.transportRetryLimit`, after `contract.transportRetryDelayMs`;
 *   anything else fails the unit and the contract (`transport` for a network
 *   fault past the limit, `other` otherwise).
 * - Cancelled by anyone but the runner: an operator stopped a member, which
 *   stops the whole contract.
 * - Silent past `contract.heartbeatTimeoutMs`: the agent is killed and the unit
 *   retried once; the second time the contract fails.
 *
 * An attempt of a best-of-N unit that fails ends alone: its siblings go on,
 * and the selection reads the ones that passed (best-of-n.ts).
 *
 * A retry is not a stall and not a fix round: the unit keeps its checks, and
 * the fresh agent's brief carries a "Previous checks" section.
 */
import { readFailure } from '@goodvibes-jev/engine/errors';
import type { AgentEvent } from '../../events/agents.js';
import type { CommunicationEvent } from '../../events/communication.js';
import { TURN_BUDGET_EXHAUSTED } from '../agents/turn-budget.js';
import { CIRCUIT_BREAKER_TRIPPED } from '../core/circuit-breaker.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { logger } from '../utils/logger.js';
import type { UnitCheckLoop } from './agent-hooks.js';
import { failureFromError, type ContractRun, type SpawnPurpose } from './run-context.js';
import { isTerminalUnitStatus, type ContractFailureKind, type ContractUnit } from './types.js';
import type { WatchedAgent } from './watchdog.js';

/** The decision site the transport reading is logged under. */
export const TRANSPORT_RETRY_SITE = 'contract.transport-retry';

export interface UnitFailureDeps {
  readonly runs: () => Iterable<ContractRun>;
  readonly agentManager: {
    getStatus(agentId: string): AgentRecord | null;
    cancel(agentId: string, kind?: 'interrupt' | 'kill'): boolean;
  };
  readonly runtimeBus: Pick<RuntimeEventBus, 'on'>;
  readonly checks: UnitCheckLoop;
  readonly failContract: (run: ContractRun, kind: ContractFailureKind, reason: string) => void;
  readonly cancelContract: (run: ContractRun, reason: string) => void;
  /** Requeues the unit's work item for a fresh agent (brief plus "Previous checks", then `firstTurn` when given). */
  readonly requeueUnit: (run: ContractRun, unit: ContractUnit, reason: string, purpose: SpawnPurpose, firstTurn?: string) => void;
}

export interface UnitFailureHandling {
  /** The watchdog found an agent silent past the timeout. */
  onSilent(agent: WatchedAgent, silentMs: number): void;
  /** Fails one unit and, with it, the contract; a failed attempt of a best-of-N unit fails alone and is never a candidate. */
  failUnit(run: ContractRun, unit: ContractUnit, kind: ContractFailureKind, reason: string): void;
  dispose(): void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export function createUnitFailureHandling(deps: UnitFailureDeps): UnitFailureHandling {
  function locate(agentId: string): { readonly run: ContractRun; readonly unit: ContractUnit } | null {
    for (const run of deps.runs()) {
      if (run.terminal) continue;
      const found = run.activeUnitOf(agentId);
      if (found !== null) return { run, unit: found.unit };
    }
    return null;
  }

  function failUnit(run: ContractRun, unit: ContractUnit, kind: ContractFailureKind, reason: string): void {
    if (run.terminal) return;
    if (!isTerminalUnitStatus(unit.status)) {
      unit.failureReason = reason;
      run.releaseHold(unit);
      run.moveUnit(unit, 'failed');
      run.decide('failed', unit.id, reason);
    }
    run.settle(unit, 'failed');
    // The selection reads the unit's attempts once all of them ended (design 6.2).
    if (unit.attemptOf !== undefined) return;
    deps.failContract(run, kind, reason);
  }

  function onCompleted(agentId: string): void {
    const found = locate(agentId);
    if (found === null) return;
    const { run, unit } = found;
    if (unit.status === 'passed' || unit.status === 'held-merge') {
      run.settle(unit, 'completed');
      return;
    }
    if (isTerminalUnitStatus(unit.status)) return;
    // The loop completed without holding (no contract hooks in its run
    // context): the work was never checked at completion, so check it now; a
    // nudge wakes the completed agent.
    logger.warn('contract runner: a unit agent completed without a completion hold; checking it now', { contractId: run.id, unitId: unit.id, agentId });
    const runtime = run.runtime(unit);
    deps.checks.supersede(runtime);
    void deps.checks.runCheck(run, unit, 'completion');
  }

  function onFailed(agentId: string, error: string): void {
    const found = locate(agentId);
    if (found === null) return;
    const { run, unit } = found;
    if (isTerminalUnitStatus(unit.status) || unit.status === 'held-merge') return;
    const runtime = run.runtime(unit);
    deps.checks.supersede(runtime);
    const record = deps.agentManager.getStatus(agentId);
    const stop = record?.failureReason;
    if (stop === TURN_BUDGET_EXHAUSTED || stop === CIRCUIT_BREAKER_TRIPPED) {
      void deps.checks.runCheck(run, unit, 'agent-failed');
      return;
    }
    void retryOrFail(run, unit, record?.error?.trim() || error.trim() || 'the agent failed without an error message');
  }

  async function retryOrFail(run: ContractRun, unit: ContractUnit, message: string): Promise<void> {
    const runtime = run.runtime(unit);
    let network: boolean;
    try {
      const reading = await readFailure({ message }, TRANSPORT_RETRY_SITE);
      network = reading.transientNetwork || reading.beforeResponse;
    } catch (error) {
      if (run.terminal) return;
      const failure = failureFromError(error);
      failUnit(run, unit, failure.kind, `unit ${unit.id} failed (${message}) and the failure could not be read: ${failure.reason}`);
      return;
    }
    if (run.terminal || isTerminalUnitStatus(unit.status)) return;
    const config = run.env.config();
    if (!network || unit.transportRetries >= config.transportRetryLimit) {
      const kind: ContractFailureKind = network ? 'transport' : 'other';
      const why = network ? `a transport failure after ${unit.transportRetries} retr${unit.transportRetries === 1 ? 'y' : 'ies'}` : 'a failure that is not transient';
      failUnit(run, unit, kind, `unit ${unit.id} failed with ${why}: ${message}`);
      return;
    }
    unit.transportRetries += 1;
    run.decide('transport-retry', unit.id, `retry ${unit.transportRetries} of ${config.transportRetryLimit}: ${message}`);
    await sleep(config.transportRetryDelayMs, runtime.abort.signal);
    if (run.terminal || isTerminalUnitStatus(unit.status)) return;
    deps.requeueUnit(run, unit, `transport retry ${unit.transportRetries}`, 'transport-retry');
  }

  function onCancelled(agentId: string): void {
    for (const run of deps.runs()) {
      for (const runtime of run.unitRuntimes.values()) {
        if (runtime.expectedCancels.delete(agentId)) return;
      }
    }
    const found = locate(agentId);
    if (found === null) return;
    deps.cancelContract(found.run, `unit ${found.unit.id}'s agent ${agentId} was stopped by an operator`);
  }

  function onSilent(agent: WatchedAgent, silentMs: number): void {
    const run = [...deps.runs()].find((candidate) => candidate.id === agent.contractId);
    const unit = run?.unit(agent.unitId);
    if (run === undefined || unit === undefined || run.terminal || unit.activeAgentId !== agent.agentId) return;
    const retried = run.contract.decisions.some((decision) => decision.action === 'silence-retry' && decision.targetId === unit.id);
    if (retried) {
      run.emit({ type: 'CONTRACT_UNIT_SILENT', contractId: run.id, unitId: unit.id, agentId: agent.agentId, silentMs, action: 'failed' });
      run.runtime(unit).expectedCancels.add(agent.agentId);
      deps.agentManager.cancel(agent.agentId, 'kill');
      failUnit(run, unit, 'other', `unit ${unit.id} went silent twice`);
      return;
    }
    run.emit({ type: 'CONTRACT_UNIT_SILENT', contractId: run.id, unitId: unit.id, agentId: agent.agentId, silentMs, action: 'retried' });
    run.decide('silence-retry', unit.id, `agent ${agent.agentId} silent for ${Math.round(silentMs / 1000)}s`);
    run.runtime(unit).expectedCancels.add(agent.agentId);
    deps.agentManager.cancel(agent.agentId, 'kill');
    deps.requeueUnit(run, unit, `silence retry: ${agent.agentId} was silent for ${silentMs} ms`, 'silence-retry');
  }

  function onConsumed(messageId: string, agentId: string, turn: number): void {
    for (const run of deps.runs()) {
      if (run.terminal) continue;
      for (const unit of run.allUnits()) {
        const nudge = unit.nudges.find((candidate) => candidate.id === messageId);
        if (nudge === undefined) continue;
        if (nudge.consumedAt !== undefined) return;
        nudge.consumedAt = run.env.now();
        run.emit({ type: 'CONTRACT_NUDGE_CONSUMED', contractId: run.id, unitId: unit.id, nudgeId: nudge.id, agentId, turn });
        if (unit.status === 'nudged' && unit.activeAgentId === agentId) run.moveUnit(unit, 'running');
        return;
      }
    }
  }

  const unsubscribers = [
    deps.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => onCompleted(payload.agentId)),
    deps.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => onFailed(payload.agentId, payload.error)),
    deps.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>('AGENT_CANCELLED', ({ payload }) => onCancelled(payload.agentId)),
    deps.runtimeBus.on<Extract<CommunicationEvent, { type: 'COMMUNICATION_CONSUMED' }>>('COMMUNICATION_CONSUMED', ({ payload }) => onConsumed(payload.messageId, payload.agentId, payload.turn)),
  ];

  return {
    onSilent,
    failUnit,
    dispose: () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    },
  };
}
