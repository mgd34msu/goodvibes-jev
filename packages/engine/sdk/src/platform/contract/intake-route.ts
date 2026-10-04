/**
 * Intake of a person's turn (docs/design/contract-runner.md 10.3). Once per
 * user turn, before the conversation model is called:
 *
 * 1. A session with an open escalation (the newest open escalation of the
 *    session's contracts): `contract.escalation-turn` reads whether the turn
 *    responds to that escalation's question. Unless it reads no at act, the
 *    turn is the owner's reply and goes to `runner.reply`, whose
 *    `contract.owner-reply` reading asks again when the reply is unclear; the
 *    turn ends there. A no at act leaves the escalation open and the turn goes
 *    on to step 2 like any other turn.
 * 2. `contract.request-route` reads the text. Route `contract` at act
 *    starts a contract with origin `turn` and the text as the ask, and the turn
 *    ends; the contract's answer arrives through its owner record's
 *    completion. Every other route, and any reading below act, leaves the turn
 *    to the conversation model, which may still start a contract through the
 *    agent tool.
 *
 * Nothing is injected into the model's prompt. The intake subsystem imports
 * this same dispatch rather than defining another.
 *
 * `toolResultStartedContract` reads the agent tool's fixed result field
 * `contractStarted: true` (a format the tool itself writes, read as code).
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { ToolResult } from '../types/tools.js';
import { isRecord } from '../utils/record-coerce.js';
import { ESCALATION_TURN_SITE, escalationTurn, turnIsUnrelated } from './batteries/escalation-turn.js';
import { REQUEST_ROUTE_SITE, requestRoute } from './batteries/request-route.js';
import type { OwnerReplyOutcome } from './escalation.js';
import type { ContractRunner } from './runner.js';
import type { ContractView, Escalation } from './types.js';

export type TurnIntakeOutcome =
  /** The turn goes on as a normal conversation turn. */
  | { readonly kind: 'turn' }
  /** A contract started for the turn's text; the turn ends. */
  | { readonly kind: 'started'; readonly contractId: string; readonly ownerAgentId: string }
  /** The turn's text answered an open escalation; the turn ends. */
  | { readonly kind: 'replied'; readonly contractId: string; readonly outcome: OwnerReplyOutcome };

export interface ContractIntake {
  /** Reads one user turn; see the module comment. */
  intake(turn: { readonly text: string; readonly sessionId: string; readonly signal?: AbortSignal | undefined }): Promise<TurnIntakeOutcome>;
}

export interface ContractIntakeDeps {
  readonly runner: Pick<ContractRunner, 'start' | 'list' | 'reply' | 'nativeMode'>;
  /** The project a turn's contract works in. */
  readonly projectRoot: string;
}

/** The session's newest open escalation, with its contract. */
export function openEscalation(contracts: readonly ContractView[]): { readonly contract: ContractView; readonly escalation: Escalation } | null {
  let newest: { readonly contract: ContractView; readonly escalation: Escalation } | null = null;
  for (const contract of contracts) {
    if (contract.nativeSource !== undefined) continue;
    for (const escalation of contract.escalations) {
      if (escalation.resolvedAt !== undefined) continue;
      if (newest === null || escalation.at > newest.escalation.at) newest = { contract, escalation: escalation as Escalation };
    }
  }
  return newest;
}

export function createContractIntake(deps: ContractIntakeDeps): ContractIntake {
  return {
    async intake(turn) {
      if (deps.runner.nativeMode === true) throw new Error('Native intake requires source-bearing host admission; legacy owner replies are unavailable');
      const signal = turn.signal === undefined ? {} : { signal: turn.signal };
      const waiting = openEscalation(deps.runner.list({ sessionId: turn.sessionId }));
      if (waiting !== null) {
        const read = await escalationTurn.run(
          judgmentPort(ESCALATION_TURN_SITE),
          { question: waiting.escalation.question, turn: turn.text },
          { site: ESCALATION_TURN_SITE, ...signal },
        );
        const reading = read.readings.responds;
        if (!turnIsUnrelated(reading)) {
          read.recordAction(`the owner's reply to ${waiting.escalation.id} (${reading.verdict}, ${reading.outcome})`);
          const outcome = await deps.runner.reply(waiting.contract.id, waiting.escalation.id, turn.text);
          return { kind: 'replied', contractId: waiting.contract.id, outcome };
        }
        read.recordAction(`not a reply to ${waiting.escalation.id}: read as a request`);
      }
      const routed = await requestRoute.route(judgmentPort(REQUEST_ROUTE_SITE), { request: turn.text }, { site: REQUEST_ROUTE_SITE, ...signal });
      if (routed.route !== 'contract' || routed.reading.outcome !== 'act') {
        routed.recordAction(`left to the conversation (${routed.route}, ${routed.reading.outcome})`);
        return { kind: 'turn' };
      }
      const started = deps.runner.start({ ask: turn.text, sessionId: turn.sessionId, origin: 'turn', projectRoot: deps.projectRoot });
      routed.recordAction(`started contract ${started.contract.id}`);
      return { kind: 'started', contractId: started.contract.id, ownerAgentId: started.owner.id };
    },
  };
}

/** Whether an agent tool result says it started a contract (the tool's own `contractStarted` field). */
export function toolResultStartedContract(result: ToolResult): boolean {
  if (!result.success || result.output === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(result.output);
    return isRecord(parsed) && parsed['contractStarted'] === true;
  } catch {
    return false;
  }
}

/** The line a turn that ended at intake leaves in the conversation. */
export function describeIntake(outcome: Exclude<TurnIntakeOutcome, { kind: 'turn' }>): string {
  if (outcome.kind === 'started') {
    return `[Contract] Contract ${outcome.contractId} took this request; its answer arrives when every acceptance criterion is checked and met.`;
  }
  const next = outcome.outcome.nextEscalationId === undefined ? '' : ` It asks again (${outcome.outcome.nextEscalationId}).`;
  return `[Contract] Your reply to contract ${outcome.contractId} (${outcome.outcome.escalationId}) was read as ${outcome.outcome.reading}: ${outcome.outcome.action}.${next}`;
}
