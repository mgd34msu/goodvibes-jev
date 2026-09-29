/**
 * A fake contract runner for the operator surface, the hosted host and the
 * external adapters: it holds contracts in memory, starts one per `start`
 * (emitting CONTRACT_CREATED to its listeners, as the runner does), records
 * cancels and replies, and lets a test emit any runner event.
 */
import type { ContractEvent } from '../../sdk/src/events/contract.js';
import type {
  Contract,
  ContractRunner,
  ContractView,
  OwnerReplyOutcome,
  StartContractInput,
} from '../../sdk/src/platform/contract/index.js';
import type { AgentRecord } from '../../sdk/src/platform/tools/agent/index.js';
import { makeContract } from './fixtures.js';

export type FakeRunnerSurface = Pick<ContractRunner, 'start' | 'get' | 'list' | 'cancel' | 'reply' | 'on'>;

export interface FakeRunner extends FakeRunnerSurface {
  readonly contracts: Map<string, Contract>;
  readonly started: StartContractInput[];
  readonly cancelled: { readonly contractId: string; readonly reason: string }[];
  readonly replies: { readonly contractId: string; readonly escalationId: string; readonly text: string }[];
  /** Hands an event to every listener, as the runner's emit does. */
  emit(event: ContractEvent): void;
}

let counter = 0;

/** A fresh `ctr-<8 hex>` id, distinct across fakes in one test run. */
export function nextContractId(): string {
  counter += 1;
  return `ctr-${counter.toString(16).padStart(8, '0')}`;
}

export function fakeRunner(initial: readonly Contract[] = []): FakeRunner {
  const contracts = new Map(initial.map((contract) => [contract.id, contract]));
  const listeners = new Set<(event: ContractEvent) => void>();
  const started: StartContractInput[] = [];
  const cancelled: { contractId: string; reason: string }[] = [];
  const replies: { contractId: string; escalationId: string; text: string }[] = [];
  const emit = (event: ContractEvent): void => {
    for (const listener of listeners) listener(event);
  };
  const view = (contract: Contract): ContractView => structuredClone(contract);
  return {
    contracts,
    started,
    cancelled,
    replies,
    emit,
    start(input) {
      started.push(input);
      const contract = makeContract({
        id: nextContractId(),
        sessionId: input.sessionId,
        origin: input.origin,
        ask: input.ask,
        projectRoot: input.projectRoot,
        ownerAgentId: `agent-owner-${started.length}`,
        status: 'queued',
        createdAt: 1_000 + started.length,
      });
      contracts.set(contract.id, contract);
      emit({ type: 'CONTRACT_CREATED', contractId: contract.id, sessionId: input.sessionId, origin: input.origin, ask: input.ask, ownerAgentId: contract.ownerAgentId });
      return { contract: view(contract), owner: { id: contract.ownerAgentId } as unknown as AgentRecord };
    },
    get(contractId) {
      const contract = contracts.get(contractId);
      return contract === undefined ? null : view(contract);
    },
    list(filter = {}) {
      return [...contracts.values()]
        .filter((contract) => filter.sessionId === undefined || contract.sessionId === filter.sessionId)
        .filter((contract) => filter.includeTerminal === true || !['passed', 'failed', 'cancelled'].includes(contract.status))
        .map(view);
    },
    cancel(contractId, reason) {
      const contract = contracts.get(contractId);
      if (contract === undefined || ['passed', 'failed', 'cancelled'].includes(contract.status)) return false;
      cancelled.push({ contractId, reason });
      contract.status = 'cancelled';
      contract.error = reason;
      return true;
    },
    async reply(contractId, escalationId, text): Promise<OwnerReplyOutcome> {
      replies.push({ contractId, escalationId, text });
      const escalation = contracts.get(contractId)?.escalations.find((candidate) => candidate.id === escalationId);
      if (escalation !== undefined) escalation.resolvedAt = 9_000;
      return { escalationId, reading: 'approve', outcome: 'act', action: 'approved' };
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Opens an escalation on a held contract and emits it, as the runner's escalation step does. */
export function escalate(runner: FakeRunner, contractId: string, question: string): string {
  const contract = runner.contracts.get(contractId);
  if (contract === undefined) throw new Error(`no contract ${contractId}`);
  const id = `${contractId}.e${contract.escalations.length + 1}`;
  contract.escalations.push({ id, at: 5_000 + contract.escalations.length, scope: 'unit', targetId: 'u1', reason: 'stalled', question, unmetCriterionIds: ['u1.c1'] });
  contract.status = 'awaiting-owner';
  runner.emit({ type: 'CONTRACT_ESCALATED', contractId, escalationId: id, scope: 'unit', targetId: 'u1', reason: 'stalled', question, unmetCriterionIds: ['u1.c1'] });
  return id;
}

/** Ends a held contract as passed with an answer and emits CONTRACT_PASSED. */
export function pass(runner: FakeRunner, contractId: string, answer: string): void {
  const contract = runner.contracts.get(contractId);
  if (contract === undefined) throw new Error(`no contract ${contractId}`);
  contract.status = 'passed';
  contract.answer = answer;
  contract.statusLine = `Contract ${contractId} passed: 1 of 1 criterion met`;
  contract.completedAt = 8_000;
  runner.emit({ type: 'CONTRACT_PASSED', contractId, criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 });
}
