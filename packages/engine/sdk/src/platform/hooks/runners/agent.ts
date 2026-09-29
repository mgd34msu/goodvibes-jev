import type { HookDefinition, HookResult, HookEvent } from '../types.js';
import { logger } from '../../utils/logger.js';
import type { AgentManager } from '../../tools/agent/index.js';
import { summarizeError } from '../../utils/error-display.js';

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
  manager: Pick<AgentManager, 'spawn' | 'getStatus' | 'cancel'>,
): Promise<HookResult> {
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
