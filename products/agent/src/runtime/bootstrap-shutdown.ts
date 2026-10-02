/**
 * bootstrap-shutdown.ts, how a session lets go of everything it took.
 *
 * Teardown lives in one place rather than inline in bootstrapRuntime because
 * the order is load-bearing and easy to disturb by accident. It runs outermost
 * first: the session's registration on the spine, then the timers that would
 * fire into a half-torn-down runtime, then subscriptions, then the things that
 * own something outside this process, real Chromium processes, external
 * services, and only then the runtime's own shutdown.
 *
 * Every step is best-effort in the sense that a failure must not strand the
 * ones after it: a session that cannot reach the daemon still has to release
 * its browsers.
 */
import { shutdownRuntime } from '@/runtime/index.ts';
import { shutdownAgentBrowserSessions } from '../tools/agent-browser-tool.ts';

/** A mutable slot holding an interval handle, or null when none is armed. */
export interface IntervalRef {
  value: ReturnType<typeof setInterval> | null;
}

export interface RuntimeShutdownDependencies {
  readonly sessionId: string;
  readonly model: string;
  readonly provider: string;
  readonly conversationTitle: () => string;
  readonly sessionSpineClient: {
    close(sessionId: string): void;
    dispose(): void;
  };
  /** Reads and clears the memory-spine reachability recheck timer. */
  readonly takeMemorySpineTimer: () => ReturnType<typeof setInterval> | null;
  readonly bootstrapUnsubs: (() => void)[];
  readonly runtimeUnsubs: (() => void)[];
  readonly forensicsCollector: { dispose(): void };
  readonly executionLedger: { dispose(): void };
  readonly disposeSessionWriteLedger: () => void;
  /**
   * `RuntimeServices.dispose()`, stops every poller the composed graph started.
   * Runs LAST, after shutdownRuntime: the final flushes below still need the
   * schedulers, the orchestration registry and the provider registry alive.
   */
  readonly disposeRuntimeGraph: () => void;
  readonly deferredStartup: { drain(ms: number): Promise<unknown> };
  readonly agentExternalServices: { stop(): Promise<unknown> };
  readonly agentStatusIntervalRef: IntervalRef;
  /**
   * The collaborators shutdownRuntime takes after the session's own identity.
   * Named individually rather than spread from a tuple so a change to that
   * signature is a type error here, at the one place that supplies them.
   */
  readonly scheduleManager: Parameters<typeof shutdownRuntime>[5];
  readonly hookDispatcher: Parameters<typeof shutdownRuntime>[6];
  readonly providerRegistry: Parameters<typeof shutdownRuntime>[7];
  readonly sessionOrchestration: Parameters<typeof shutdownRuntime>[8];
  readonly shutdownOptions: Parameters<typeof shutdownRuntime>[9];
}

/** Build the session's `shutdown(sessionData)` handler. */
export function createRuntimeShutdown(
  deps: RuntimeShutdownDependencies,
): (sessionData: Parameters<typeof shutdownRuntime>[1]) => Promise<void> {
  return async (sessionData) => {
    try {
      // Best-effort spine close (short timeout, fire-and-forget) then stop the
      // heartbeat timer. Tolerates a racing daemon stop; never blocks teardown.
      deps.sessionSpineClient.close(deps.sessionId);
      deps.sessionSpineClient.dispose();
      // Stop the memory-spine reachability recheck timer. No wire close call is
      // needed, unlike sessions, memory ops are request/response rather than a
      // registered, heartbeat-tracked record.
      const memoryTimer = deps.takeMemorySpineTimer();
      if (memoryTimer !== null) clearInterval(memoryTimer);

      // Clear bootstrap-owned subscriptions.
      deps.bootstrapUnsubs.forEach((fn) => fn());
      deps.bootstrapUnsubs.length = 0;
      deps.runtimeUnsubs.forEach((fn) => fn());
      deps.runtimeUnsubs.length = 0;
      deps.forensicsCollector.dispose();
      deps.executionLedger.dispose();
      deps.disposeSessionWriteLedger();
      // Browser sessions own real Chromium processes; a session torn down
      // without this leaves them behind.
      await shutdownAgentBrowserSessions();
      await deps.deferredStartup.drain(100);
      await deps.agentExternalServices.stop();
      if (deps.agentStatusIntervalRef.value !== null) {
        clearInterval(deps.agentStatusIntervalRef.value);
        deps.agentStatusIntervalRef.value = null;
      }
      await shutdownRuntime(
        deps.sessionId,
        sessionData,
        deps.model,
        deps.provider,
        deps.conversationTitle(),
        deps.scheduleManager,
        deps.hookDispatcher,
        deps.providerRegistry,
        deps.sessionOrchestration,
        deps.shutdownOptions,
      );
    } finally {
      // Outermost-last: the graph's own pollers. Every step above is finished
      // with the schedulers it needed, so the config watch, fleet tick, memory
      // governor, watcher registry and the rest can finally stop. Without this
      // a session that shut down cleanly left most of its timers ticking.
      //
      // In a `finally` covering the WHOLE body, on the principle stated at the
      // top of this file: a step that fails must not strand the ones after it.
      // Several steps here can throw, an unreachable daemon, a browser that
      // will not close, a conversation that could not be persisted, and every
      // one of those is a process that must still let go of its timers. This is
      // the last teardown step in the session's life, so nothing legitimately
      // needs the graph after it.
      deps.disposeRuntimeGraph();
    }
  };
}
