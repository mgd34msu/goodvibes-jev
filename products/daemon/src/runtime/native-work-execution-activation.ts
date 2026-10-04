/** Lazy daemon-owned native graph; ordinary conversations keep their own runner. */
import { createAgentExecutionGraph } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { ProcessManager, cancelAllAgentRuns } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { AgentOrchestrator } from '@goodvibes-jev/engine/sdk/platform/agents';
import type { PermissionManager } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { NativeWorkExecutionError } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution';
import { createDaemonNativeWorkExecutionServices } from './native-work-execution-composition.js';
import { createNativeWorkSessionDriver, type NativeSessionDriverOptions } from './native-work-session-driver.js';

type NativeOptions = Parameters<typeof createDaemonNativeWorkExecutionServices>[0];
export type NativeWorkExecutionActivationOptions = Omit<NativeOptions, 'agentManager' | 'agentMessageBus' | 'readAccessFilter' | 'cancelForeground'> & {
  readonly permissionManager: PermissionManager;
  readonly toolDependencies: Parameters<AgentOrchestrator['setDependencies']>[0];
  readonly featureFlags: NativeSessionDriverOptions['featureFlags'];
  readonly hookDispatcher: NativeSessionDriverOptions['hookDispatcher'];
};

export function createDaemonNativeWorkExecutionActivation(options: NativeWorkExecutionActivationOptions) {
  let closed = false;
  let opening: Promise<Awaited<ReturnType<typeof build>>> | undefined;
  let closing: Promise<void> | undefined;
  let localFleetOwnership: NonNullable<NativeOptions['additionalFleetOwnership']> = () => [];
  let foregroundFleetOwnership: typeof localFleetOwnership = () => [];
  async function build() {
    const graph = createAgentExecutionGraph({ runtimeBus: options.runtimeBus, workingDirectory: options.projectRoot,
      configManager: options.configManager, providerRegistry: options.providerRegistry,
      additionalFleetOwnership: () => [...(options.additionalFleetOwnership?.() ?? []), ...foregroundFleetOwnership(),
        ...options.acpHost.list().map(session => ({ id: `acp:${session.id}`, active: true }))] });
    localFleetOwnership = () => {
      const agents = new Map<string, boolean>();
      for (const agent of [...graph.agentManager.fleetOwnership(), ...foregroundFleetOwnership()])
        agents.set(agent.id, agents.get(agent.id) === true || agent.active);
      return Object.freeze([...agents].map(([id, active]) => Object.freeze({ id, active })));
    };
    graph.agentOrchestrator.setCancellationSource({ get: id => graph.agentManager.getCancellationSignal(id) });
    graph.agentOrchestrator.setFeatureFlagManager(options.featureFlags);
    const processManager = new ProcessManager();
    let native: Awaited<ReturnType<typeof createDaemonNativeWorkExecutionServices>> | undefined;
    let cancelForeground: (contractId: string) => Promise<void> = async () => { throw new NativeWorkExecutionError('unavailable'); };
    let joinForeground: (contractId: string) => Promise<void> = async () => { throw new NativeWorkExecutionError('unavailable'); };
    try {
      native = await createDaemonNativeWorkExecutionServices({ ...options,
        agentManager: graph.agentManager, agentMessageBus: graph.agentMessageBus,
        cancelForeground: contractId => cancelForeground(contractId),
        joinForeground: contractId => joinForeground(contractId),
        additionalFleetOwnership: () => [...(options.additionalFleetOwnership?.() ?? []), ...foregroundFleetOwnership()],
        readAccessFilter: async path => (await options.permissionManager.readAccess(path)) === 'allow' });
      const toolDependencies = { ...options.toolDependencies, ...graph, processManager,
        // The ordinary remote runner registry owns the ordinary manager.
        remoteRunnerRegistry: undefined,
        contractRunner: native.runner, contractHooks: native.runner.hooks(), permissionManager: options.permissionManager };
      graph.agentOrchestrator.setDependencies(toolDependencies);
      const owner = native;
      const driver = createNativeWorkSessionDriver({ ...options, runner: owner.runner, toolDependencies,
        assertCurrent: contract => { owner.execution.nativeOwner.decisions.authorityOf(contract); } });
      foregroundFleetOwnership = driver.fleetOwnership;
      cancelForeground = driver.cancel;
      joinForeground = driver.join;
      let drain: Promise<void> | undefined;
      async function cancelWithForeground(workId: string, attemptId: string, authority: Parameters<typeof owner.execution.cancel>[1], operation: () => Promise<void>) {
        const read = () => owner.execution.statusByAttempt(workId, attemptId, authority);
        let observed: ReturnType<typeof read> | undefined;
        try { observed = read(); } catch (error) { if (!(error instanceof NativeWorkExecutionError) || error.code !== 'not-found') throw error; }
        const receipt = observed?.kind === 'execution' ? observed.execution.receipt : null;
        // Existing effects are fenced before the durable operation can await.
        // Intent-only cancellation still reaches the host and may win first.
        const foreground = receipt ? driver.cancel(receipt.contractId) : Promise.resolve();
        const results = await Promise.allSettled([Promise.resolve().then(operation), foreground]);
        let failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')?.reason;
        try {
          // Association publication may have won after the first observation.
          // Join its actual foreground lifetime before reporting cancellation.
          const latest = read();
          if (latest.kind === 'execution' && latest.execution.receipt) await driver.cancel(latest.execution.receipt.contractId);
        } catch (error) { failure ??= error; }
        if (failure !== undefined) throw failure;
      }
      const execution = { ...owner.execution,
        cancel(...args: Parameters<typeof owner.execution.cancel>) {
          return cancelWithForeground(args[0].workId, args[0].attemptId, args[1], () => owner.execution.cancel(...args));
        },
        cancelTarget(...args: Parameters<typeof owner.execution.cancelTarget>) {
          return cancelWithForeground(args[0].workId, args[0].attemptId, args[1], () => owner.execution.cancelTarget(...args));
        },
      };
      return { execution, close() {
        if (drain) return drain;
        // Fence admission, abort foreground turns and cancel background work
        // before waiting on any one of their drains.
        const execution = owner.execution.close();
        const sessions = driver.close();
        cancelAllAgentRuns(graph.agentManager);
        const agents = Promise.allSettled(graph.agentManager.list().map(record => graph.agentManager.join(record.id)));
        const processes = processManager.close();
        drain = Promise.allSettled([execution, sessions, agents, processes]).then(async results => {
          try { await owner.close(); } finally { graph.agentOrchestrator.dispose(); localFleetOwnership = () => []; }
          const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
          if (errors.length) throw new AggregateError(errors, 'Native execution cleanup failed');
        });
        return drain;
      } };
    } catch (error) {
      cancelAllAgentRuns(graph.agentManager);
      try { await Promise.allSettled([native?.close(), processManager.close(), ...graph.agentManager.list().map(record => graph.agentManager.join(record.id))]); }
      finally { graph.agentOrchestrator.dispose(); localFleetOwnership = () => []; }
      throw error;
    }
  }
  return {
    /** Read-only resource ownership; no manager/control handle escapes. */
    fleetOwnership: () => localFleetOwnership(),
    async acquire() {
      if (closed) throw new NativeWorkExecutionError('closed');
      if (!opening) {
        const pending = build(); opening = pending;
        void pending.catch(() => { if (opening === pending && !closed) opening = undefined; });
      }
      const owner = await opening;
      if (closed) { await owner.close(); throw new NativeWorkExecutionError('closed'); }
      return owner.execution;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = opening ? opening.then(owner => owner.close(), () => {}) : Promise.resolve();
      return closing;
    },
  };
}
