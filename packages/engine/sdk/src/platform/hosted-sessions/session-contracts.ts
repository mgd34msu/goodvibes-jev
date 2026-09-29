/**
 * session-contracts.ts, a hosted session as the host of the contracts it
 * starts (docs/design/contract-runner.md 10.2).
 *
 * The session's turns reach its workspace floor's contract runner through the
 * intake and the agent tool; this file is the other direction, what the
 * runner says back to the session:
 *
 *  - a contract created under the session's id is listed on the session's
 *    record (`contractIds`), which the engine persists;
 *  - a question a contract of this session puts to its owner is delivered as
 *    the session's reply, so whoever is attached reads it, and the next turn,
 *    read by the intake, answers it;
 *  - when a contract of this session ends, the session says so: the answer
 *    when it passed (what its owner record carries as output), and what
 *    stopped it when it failed or was cancelled.
 *
 * Everything here is code over the runner's own events and ids; nothing is
 * judged.
 */
import type { ContractEvent } from '../../events/contract.js';
import { CONTRACT_PASSED_WITHOUT_OUTPUT } from '../contract/answer.js';
import type { ContractRunner } from '../contract/runner.js';

/** The runner surface a session observes. */
export type SessionContractRunner = Pick<ContractRunner, 'on' | 'get'>;

export interface SessionContractObserver {
  readonly sessionId: string;
  readonly runner: SessionContractRunner;
  /** The contracts the session started, as its record lists them now. */
  readonly contractIds: () => readonly string[];
  /** A contract was created under this session: list it on the record. */
  readonly started: (contractId: string) => void;
  /** A line the session says to whoever is attached. */
  readonly say: (line: string) => void;
}

/** The session's line for a contract event, or null when the session says nothing about it. */
export function sessionContractLine(event: ContractEvent, runner: Pick<ContractRunner, 'get'>): string | null {
  switch (event.type) {
    case 'CONTRACT_ESCALATED':
      return `[Contract] ${event.question}`;
    case 'CONTRACT_PASSED': {
      const answer = runner.get(event.contractId)?.answer?.trim() ?? '';
      return `[Contract] ${answer.length > 0 ? answer : CONTRACT_PASSED_WITHOUT_OUTPUT}`;
    }
    case 'CONTRACT_FAILED':
      return `[Contract] Contract ${event.contractId} could not be finished: ${event.reason}`;
    case 'CONTRACT_CANCELLED':
      return `[Contract] Contract ${event.contractId} was cancelled: ${event.reason}`;
    default:
      return null;
  }
}

/** Starts observing; returns the call that stops it. */
export function observeSessionContracts(observer: SessionContractObserver): () => void {
  return observer.runner.on((event) => {
    if (event.type === 'CONTRACT_CREATED') {
      if (event.sessionId === observer.sessionId && !observer.contractIds().includes(event.contractId)) observer.started(event.contractId);
      return;
    }
    // An event with no contract (a refused spawn) belongs to no session's contracts.
    if (event.contractId === undefined || !observer.contractIds().includes(event.contractId)) return;
    const line = sessionContractLine(event, observer.runner);
    if (line !== null) observer.say(line);
  });
}
