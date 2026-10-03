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
    close(sessionId: string): void | Promise<void>;
    dispose(): void | Promise<void>;
  };
  /** Reads and clears the memory-spine reachability recheck timer. */
  readonly takeMemorySpineTimer: () => ReturnType<typeof setInterval> | null;
  readonly bootstrapUnsubs: (() => void)[];
  readonly runtimeUnsubs: (() => void)[];
  readonly forensicsCollector: { dispose(): void };
  readonly executionLedger: { dispose(): void };
  readonly disposeSessionWriteLedger: () => void | Promise<void>;
  /**
   * `RuntimeServices.dispose()`, stops every poller the composed graph started.
   * Runs LAST, after shutdownRuntime: the final flushes below still need the
   * schedulers, the orchestration registry and the provider registry alive.
   */
  readonly disposeRuntimeGraph: () => void | Promise<void>;
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
  // Latch before invoking any collaborator, including a synchronously reentrant
  // close. Repeated callers share the same completion and failure result.
  // Collaborators must not await this owner's shutdown from inside their own
  // disposal: that is a dependency cycle, including indirectly wrapped waits.
  let closing: Promise<void> | undefined;
  return (sessionData) => closing ??= Promise.resolve().then(async () => {
    const failures: unknown[] = [];
    const attempt = async (dispose: () => unknown): Promise<void> => {
      try {
        const result = dispose();
        if (result === closing) throw new Error('A shutdown callback cannot await its own shutdown');
        await result;
      } catch (error) { failures.push(error); }
    };
    await attempt(() => deps.sessionSpineClient.close(deps.sessionId));
    await attempt(() => deps.sessionSpineClient.dispose());
    await attempt(() => {
      const timer = deps.takeMemorySpineTimer();
      if (timer !== null) clearInterval(timer);
    });

    // Take subscriptions out of the live arrays before invoking callbacks. One
    // broken unsubscribe must neither retain itself nor strand its siblings.
    for (const unsubscribe of deps.bootstrapUnsubs.splice(0)) await attempt(unsubscribe);
    for (const unsubscribe of deps.runtimeUnsubs.splice(0)) await attempt(unsubscribe);
    await attempt(() => deps.forensicsCollector.dispose());
    await attempt(() => deps.executionLedger.dispose());
    await attempt(() => deps.disposeSessionWriteLedger());
    await attempt(() => shutdownAgentBrowserSessions());
    await attempt(() => deps.deferredStartup.drain(100));
    await attempt(() => deps.agentExternalServices.stop());
    await attempt(() => {
      const timer = deps.agentStatusIntervalRef.value;
      deps.agentStatusIntervalRef.value = null;
      if (timer !== null) clearInterval(timer);
    });
    let title = '';
    await attempt(() => { title = deps.conversationTitle(); });
    await attempt(() => shutdownRuntime(
      deps.sessionId,
      sessionData,
      deps.model,
      deps.provider,
      title,
      deps.scheduleManager,
      deps.hookDispatcher,
      deps.providerRegistry,
      deps.sessionOrchestration,
      deps.shutdownOptions,
    ));
    // Always last: final persistence and SDK shutdown still need the graph.
    await attempt(() => deps.disposeRuntimeGraph());
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Agent shutdown failed to release one or more owned resources');
  });
}
