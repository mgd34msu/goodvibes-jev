/**
 * The seams the sub-agent loop (`runAgentTask`, agents/orchestrator-runner.ts)
 * calls for a contract-bound agent (docs/design/contract-runner.md section 4.1).
 *
 * The runner installs one implementation through `AgentOrchestrator`'s tool
 * dependencies; the loop calls it only for an agent whose record carries a
 * `contractUnitId`, so every other agent runs exactly as before.
 */
import type { AgentRecord } from '../tools/agent/index.js';
import type { ContractTurnRecord } from './evidence.js';

/**
 * What the completion hold returns. `release` lets the agent complete;
 * `continue` keeps its loop open and adds `message` (the nudge text, verbatim)
 * as the next user turn, and the loop reports `nudgeId` consumed once the
 * following model call succeeds.
 */
export type ContractHoldOutcome =
  | { readonly kind: 'release' }
  | { readonly kind: 'continue'; readonly message: string; readonly nudgeId: string };

export interface ContractAgentHooks {
  /**
   * After a turn's tool calls ran and their results joined the conversation.
   * Never awaited by the loop, and a throw is logged, not propagated.
   */
  onTurnEnd(record: AgentRecord, turn: ContractTurnRecord): void;
  /** When the agent would complete. The loop awaits it before finishing. */
  holdCompletion(record: AgentRecord): Promise<ContractHoldOutcome>;
}
