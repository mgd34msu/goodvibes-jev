// The contract runner's two seams in the sub-agent turn loop (runAgentTask,
// orchestrator-runner.ts; docs/design/contract-runner.md section 4.1). Both
// apply only to an agent whose record carries a contractUnitId and only when
// the run context has contract hooks installed; every other agent is untouched.
import type { ConversationManager } from '../core/conversation.js';
import type { LLMProvider } from '../providers/interface.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { ToolResult } from '../types/tools.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { AgentOrchestratorRunContext } from './orchestrator-run-context.js';
import { setAgentProgress } from './orchestrator-utils.js';

type ChatResponse = Awaited<ReturnType<LLMProvider['chat']>>;

/**
 * Hands the finished turn (its tool calls, their results in the same order, and
 * the assistant text) to the runner. Never awaited; a throw is logged, like the
 * onToolExecuted tap, so an observer can never break the agent's loop.
 */
export function reportContractTurnEnd(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  turn: number,
  response: ChatResponse,
  results: readonly ToolResult[],
): void {
  if (!record.contractUnitId || !context.contractHooks) return;
  try {
    context.contractHooks.onTurnEnd(record, {
      turn,
      toolCalls: response.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments as Record<string, unknown> })),
      results,
      assistantText: response.content,
    });
  } catch (error) {
    logger.warn('contract onTurnEnd hook error', { agentId: record.id, error: summarizeError(error) });
  }
}

/**
 * Called where the loop would complete. Holds a contract-bound agent until the
 * runner's check answers: `release` returns false and the loop ends as usual;
 * `continue` adds the nudge verbatim as the next user turn (progress reads
 * "Turn N · Correcting…" for that turn), queues its id to be
 * reported consumed once the next model call succeeds (the steer drain's rule),
 * and returns true so the loop takes another turn. A cancelled agent is never
 * held: the loop's own cancelled detection must run.
 */
export async function holdContractCompletion(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  conversation: ConversationManager,
  turn: number,
  nudgeIdsAwaitingTurn: string[],
): Promise<boolean> {
  const hooks = context.contractHooks;
  if (!record.contractUnitId || !hooks || (record as { status: string }).status === 'cancelled') return false;
  const outcome = await hooks.holdCompletion(record);
  if (outcome.kind === 'release') return false;
  conversation.addUserMessage(outcome.message);
  nudgeIdsAwaitingTurn.push(outcome.nudgeId);
  setAgentProgress(record, `Turn ${turn + 1} · Correcting…`, 'operator');
  context.emitAgentProgress(record.id, record.progress ?? '', 'operator');
  return true;
}
