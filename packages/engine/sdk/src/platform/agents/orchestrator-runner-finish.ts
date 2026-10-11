// How a sub-agent run ends when it is cleaned up outside the normal
// completion path (runAgentTask, orchestrator-runner.ts): leaked background
// processes stopped, the session closed, and a cancelled run reported as
// cancelled wherever the cancel was seen.
import type { AgentRecord } from '../tools/agent/index.js';
import type { ProcessManager } from '../tools/shared/process-manager.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { AgentOrchestratorRunContext } from './orchestrator-run-context.js';
import type { AgentSession } from './session.js';

export interface AgentRunTerminal {
  readonly assertCurrent: () => void;
  readonly settle: () => Promise<void>;
}

/** Stops every process the run started (anything not running before it began). */
export function cleanupLeakedProcesses(
  processManager: ProcessManager | undefined,
  preAgentProcessIds: Set<string>,
): void {
  const pm = processManager;
  if (!pm) return;
  for (const p of pm.list()) {
    if (!preAgentProcessIds.has(p.id) && !pm.hasBoundaryOwner(p.id)) {
      pm.stop(p.id);
    }
  }
}

const sessionDisposals = new WeakMap<AgentSession, Promise<void>>();

export function disposeSession(session: AgentSession): Promise<void> {
  const existing = sessionDisposals.get(session);
  if (existing) return existing;
  const retained = Promise.withResolvers<void>();
  sessionDisposals.set(session, retained.promise);
  const dispose = async () => {
    try {
      await session.dispose();
    } catch (error) {
      logger.warn('[AgentOrchestrator] session disposal failed', {
        error: summarizeError(error),
      });
    }
  };
  void dispose().then(retained.resolve, retained.reject);
  return retained.promise;
}

/**
 * Ends a run whose record was cancelled: the loop saw it at a turn boundary,
 * or a retry wait saw it and threw. Either way the run reports AGENT_CANCELLED
 * (never AGENT_FAILED), so listeners such as the lifecycle hook bridge follow
 * the event type and never read the error wording.
 */
export async function finishCancelledRun(
  context: AgentOrchestratorRunContext,
  record: AgentRecord,
  session: AgentSession | null,
  preAgentProcessIds: Set<string>,
  turn?: number,
  terminal?: AgentRunTerminal,
): Promise<void> {
  terminal?.assertCurrent();
  if (terminal) await terminal.settle();
  else if (context.beforeRunSettlement) await context.beforeRunSettlement();
  terminal?.assertCurrent();
  record.completedAt = Date.now();
  terminal?.assertCurrent();
  context.emitAgentCancelledEvent(record.id, 'Agent cancelled');
  terminal?.assertCurrent();
  if (!context.beforeRunSettlement) cleanupLeakedProcesses(context.processManager, preAgentProcessIds);
  terminal?.assertCurrent();
  if (!session) return;
  session.appendMessage({
    type: 'session_end',
    status: 'cancelled',
    ...(turn === undefined ? {} : { turn }),
    toolCallCount: record.toolCallCount,
    durationMs: Date.now() - record.startedAt,
    timestamp: new Date().toISOString(),
  });
  terminal?.assertCurrent();
  await disposeSession(session);
  terminal?.assertCurrent();
}
