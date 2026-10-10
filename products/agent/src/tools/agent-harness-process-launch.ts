import { ToolInputProjectionError, type ProcessManager, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { AgentHarnessBackgroundProcessArgs } from './agent-harness-background-processes-types.ts';
import type { ProcessClassificationOptions } from './agent-harness-process-classification.ts';
import { resolveKillOnTimeout, withBackgroundProcessClass } from './agent-harness-process-timeout-policy.ts';

/** Capture the calling composition, not authority supplied in model arguments. */
export function processClassificationOptions(context: CommandContext, registry?: ToolRegistry, signal?: AbortSignal, assertExecution?: () => void): ProcessClassificationOptions {
  const sourceOwner = agentResearchSourceOwner(registry);
  const workspace = context.workspace, manager = workspace.processManager, spawn = manager?.spawn;
  const shellPaths = workspace.shellPaths, workingDirectory = shellPaths?.workingDirectory;
  const session = context.session?.runtime, sessionId = session?.sessionId;
  return { signal, sourceOwner, assertCurrent() {
    signal?.throwIfAborted(); assertExecution?.();
    if (agentResearchSourceOwner(registry) !== sourceOwner || context.workspace !== workspace
      || workspace.processManager !== manager || manager?.spawn !== spawn || workspace.shellPaths !== shellPaths
      || shellPaths?.workingDirectory !== workingDirectory || context.session?.runtime !== session
      || context.session?.runtime?.sessionId !== sessionId) throw new ToolInputProjectionError('held');
  } };
}

export async function spawnClassifiedBackgroundProcess(
  manager: ProcessManager, args: AgentHarnessBackgroundProcessArgs, command: string, cwd: string | undefined,
  timeoutMs: number, options: ProcessClassificationOptions,
) {
  const spawn = manager.spawn;
  return withBackgroundProcessClass(args, command, options, async (processClass, assertCurrent) => {
    const killOnTimeout = resolveKillOnTimeout(args, processClass);
    assertCurrent();
    if (manager.spawn !== spawn) throw new ToolInputProjectionError('held');
    const result = await spawn.call(manager, command, cwd, undefined, {
      timeout_ms: timeoutMs, sigterm_grace_ms: 5_000, kill_on_timeout: killOnTimeout,
      signal: options.signal, assertCurrent,
    });
    return { processClass, killOnTimeout, result };
  });
}
