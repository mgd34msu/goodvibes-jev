import { TriggerManager } from '@goodvibes-jev/engine/sdk/platform/triggers';
import { createBunStreamHost, createProcessManagerTriggerHost, createTriggerActionExecutor } from '@goodvibes-jev/engine/sdk/platform/triggers';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { AgentManager, ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { SharedSessionBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { ShellPathService } from './index.js';

/**
 * The trigger family: stream watchers, on-exit process triggers, and condition
 * checks, supervised as one.
 *
 * This daemon composes the full family and feeds the manager to the fleet as
 * its trigger supervisor, so a trigger defined against the daemon fires
 * reliably. The daemon is the right process to own it, it is the one that
 * stays running.
 *
 * Two things about the shape are load-bearing:
 *  - `config` is a CLOSURE over the config manager rather than a snapshot, so
 *    toggling `watchers.triggers.*` takes effect on the next read instead of at
 *    the next restart.
 *  - the process host is ProcessManager-backed, so a supervised on-exit child
 *    inherits the same credential-environment scrub, live output collection and
 *    SIGTERM/SIGKILL watchdog as any other background command the daemon runs.
 */
export function createTriggerServices(deps: {
  readonly configManager: ConfigManager;
  readonly shellPaths: ShellPathService;
  readonly surfaceRoot: string;
  readonly agentManager: AgentManager;
  readonly processManager: ProcessManager;
  readonly sessionBroker: Pick<SharedSessionBroker, 'getSession'>;
}): TriggerManager {
  const { configManager } = deps;
  return new TriggerManager({
    storePath: deps.shellPaths.resolveProjectPath(deps.surfaceRoot, 'triggers.json'),
    config: () => ({
      enabled: configManager.get('watchers.triggers.enabled'),
      backoffLadderMs: configManager.get('watchers.triggers.backoffLadderMs'),
      breakerStrikes: configManager.get('watchers.triggers.breakerStrikes'),
      defaultCheckIntervalMs: configManager.get('watchers.triggers.defaultCheckIntervalMs'),
      probeTimeoutMs: configManager.get('watchers.triggers.probeTimeoutMs'),
      maxConcurrentChecks: configManager.get('watchers.triggers.maxConcurrentChecks'),
      observationRingSize: configManager.get('watchers.triggers.observationRingSize'),
      runHistoryLimit: configManager.get('watchers.triggers.runHistoryLimit'),
      runHistoryTtlHours: configManager.get('watchers.triggers.runHistoryTtlHours'),
      eventLogLimit: configManager.get('watchers.triggers.eventLogLimit'),
      eventLogTtlHours: configManager.get('watchers.triggers.eventLogTtlHours'),
      sweepIntervalMs: configManager.get('watchers.triggers.sweepIntervalMs'),
      supervisionTickMs: configManager.get('watchers.triggers.supervisionTickMs'),
      streamQueueLimit: configManager.get('watchers.triggers.streamQueueLimit'),
      streamBatchLines: configManager.get('watchers.triggers.streamBatchLines'),
      streamBatchIntervalMs: configManager.get('watchers.triggers.streamBatchIntervalMs'),
      onExitMaxDurationMs: configManager.get('watchers.triggers.onExitMaxDurationMs'),
      onExitStdin: configManager.get('watchers.triggers.onExitStdin'),
      outputTailBytes: configManager.get('watchers.triggers.outputTailBytes'),
    }),
    actions: createTriggerActionExecutor({ agents: deps.agentManager, processManager: deps.processManager }),
    processHost: createProcessManagerTriggerHost(deps.processManager),
    streamHost: createBunStreamHost(),
    sessionIsLive: (sessionId: string) => deps.sessionBroker.getSession(sessionId) !== null,
  });
}
