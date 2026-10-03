import type { HookDefinition, HookResult, HookEvent } from '../types.js';
import { logger } from '../../utils/logger.js';
import type { AgentManager } from '../../tools/agent/index.js';
import { OwnedAgentExecutionUnavailableError } from '../../tools/agent/manager.js';
import { summarizeError } from '../../utils/error-display.js';
import { createHookExecution, type HookExecutionOptions } from '../execution.js';

/**
 * Agent hook runner, spawns a subagent via AgentManager and waits for
 * completion up to the hook's configured timeout.
 *
 * The hook's `prompt` field (with `$ARGUMENTS` replaced by the event JSON)
 * becomes the agent task description.
 *
 * The spawn runs the work: it is not outside every contract, so
 * AgentManager.spawn starts a contract through the composed contract runner
 * (as the agent tool does for a spawn inside a contract) and returns the contract's
 * owner record. The contract's unit agents run in the background and Jev
 * checks their work; when the contract ends, the runner settles the owner
 * record: `completed` with the contract's answer in `fullOutput`, `failed`
 * with its error, or `cancelled`. The hook polls that record. Its result
 * carries the answer as `additionalContext`, never the operator progress
 * line. At the timeout the hook cancels the owner record, which the contract
 * runner reads as stopping the contract and its unit agents.
 */
export async function run(
  hook: HookDefinition,
  event: HookEvent,
  manager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'> & Partial<Pick<AgentManager, 'spawnOwned'>>,
  options?: HookExecutionOptions,
): Promise<HookResult> {
  if (options !== undefined) return runOwned(hook, event, manager, options);
  const promptTemplate = hook.prompt;
  if (promptTemplate == null) {
    return { ok: false, error: 'agent hook missing "prompt" field' };
  }

  const task = promptTemplate.replaceAll('$ARGUMENTS', JSON.stringify(event));
  const timeoutMs = (hook.timeout ?? 60) * 1000;
  logger.debug('agent hook: spawning agent', {
    event: event.path,
    timeoutMs,
  });

  let record;
  try {
    record = manager.spawn({
      mode: 'spawn',
      task,
      template: 'general',
      model: hook.model,
    });
  } catch (err) {
    const message = summarizeError(err);
    logger.error('agent hook: spawn failed', { event: event.path, error: message });
    return { ok: false, error: `agent spawn failed: ${message}` };
  }

  const agentId = record.id;

  logger.debug('agent hook: agent spawned', { agentId, event: event.path });

  // Poll the owner record until the contract settles it or the timeout passes.
  const pollInterval = 100; // ms
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const current = manager.getStatus(agentId);
    if (!current) {
      return { ok: false, error: `agent ${agentId} disappeared from registry` };
    }

    if (current.status === 'completed') {
      logger.debug('agent hook: agent completed', { agentId });
      // The contract's answer; `progress` is only the operator status line.
      return current.fullOutput
        ? { ok: true, additionalContext: current.fullOutput }
        : { ok: true };
    }

    if (current.status === 'failed') {
      logger.error('agent hook: agent failed', { agentId, error: current.error });
      return { ok: false, error: current.error ?? 'agent failed without error message' };
    }

    if (current.status === 'cancelled') {
      return { ok: false, error: `agent ${agentId} was cancelled before completing` };
    }

    // Agent still pending/running, wait a tick
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollInterval);
      timer.unref?.();
    });
  }

  // Timed out: cancelling the owner record stops the contract and its unit agents.
  manager.cancel(agentId);
  const timeoutSecs = hook.timeout ?? 60;
  logger.error('agent hook: timed out', { agentId, timeoutSecs });
  return { ok: false, error: `agent hook timed out after ${timeoutSecs}s (agentId: ${agentId})` };
}


/** A turn-owned hook waits for real executor/contract cleanup, never status polling. */
async function runOwned(
  hook: HookDefinition,
  event: HookEvent,
  manager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'> & Partial<Pick<AgentManager, 'spawnOwned'>>,
  options: HookExecutionOptions,
): Promise<HookResult> {
  if (hook.prompt == null) return { ok: false, error: 'agent hook missing "prompt" field' };
  if (options.signal?.aborted) return { ok: false, error: 'agent hook cancelled' };
  if (!manager.spawnOwned) return { ok: false, code: 'OWNED_AGENT_EXECUTION_UNSUPPORTED', error: 'agent hook requires captured execution settlement' };
  const execution = createHookExecution(options, hook.timeout ?? 60, 'agent');
  try {
    execution.signal.throwIfAborted();
    const owned = manager.spawnOwned({
      mode: 'spawn',
      task: hook.prompt.replaceAll('$ARGUMENTS', JSON.stringify(event)),
      template: 'general',
      model: hook.model,
    }, { signal: execution.signal });
    const current = await owned.settled;
    const agentId = current.id;
    if (execution.signal.aborted) {
      return { ok: false, error: options.signal?.aborted ? 'agent hook cancelled' : `agent hook timed out after ${hook.timeout ?? 60}s (agentId: ${agentId})` };
    }
    if (current.status === 'completed') return current.fullOutput ? { ok: true, additionalContext: current.fullOutput } : { ok: true };
    if (current.status === 'cancelled') return { ok: false, error: `agent ${agentId} was cancelled before completing` };
    return { ok: false, error: current.error ?? `agent ${agentId} settled without completing`, ...(current.failureReason === 'OWNED_AGENT_EXECUTION_UNSUPPORTED' ? { code: current.failureReason } : {}) };

  } catch (error) {
    return { ok: false, error: `agent hook failed: ${summarizeError(error)}`, ...(error instanceof OwnedAgentExecutionUnavailableError ? { code: error.code } : {}) };
  } finally {
    execution.dispose();
  }
}
