/** Ordered teardown owned by bootstrap; the shell owns the exit deadline. */
import { shutdownRuntime } from '@/runtime/index.ts';

type Cleanup = () => unknown;

export interface BootstrapShutdownDeps {
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  readonly conversationTitle: () => string;
  readonly bootstrapUnsubs: Cleanup[];
  readonly runtimeUnsubs: Cleanup[];
  readonly forensicsCollector: { dispose(): unknown };
  readonly sessionSpine: { close(sessionId: string): unknown; dispose(): unknown };
  readonly sessionInboundInputs: { dispose(): unknown };
  readonly sessionUnionCache: { dispose(): unknown };
  readonly leaveHostedSession: Cleanup;
  readonly deferredStartup: { drain(timeoutMs: number): Promise<unknown> };
  /** Wait for the admitted start and publish its handle before stopping it. */
  readonly settleExternalServices: Cleanup;
  readonly stopExternalServices: Cleanup;
  readonly agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null };
  readonly scheduleManager: Parameters<typeof shutdownRuntime>[5];
  readonly hookDispatcher: Parameters<typeof shutdownRuntime>[6];
  readonly providerRegistry: Parameters<typeof shutdownRuntime>[7];
  readonly sessionOrchestration: Parameters<typeof shutdownRuntime>[8];
  readonly persistenceOptions: Parameters<typeof shutdownRuntime>[9];
}

/** The same handler returned as bootstrapRuntime's public ctx.shutdown. */
export function createBootstrapShutdown(deps: BootstrapShutdownDeps): (sessionData: Parameters<typeof shutdownRuntime>[1]) => Promise<void> {
  // Publish ownership before callbacks run. Direct callers and the shell share
  // one completion; callbacks must not await this shutdown (even indirectly).
  let closing: Promise<void> | undefined;
  return (sessionData) => closing ??= Promise.resolve().then(async () => {
    const failures: Array<{ order: number; error: unknown }> = [];
    let sequence = 0;
    const attempt = async (cleanup: Cleanup): Promise<void> => {
      const order = sequence++;
      try {
        const result = cleanup();
        if (result === closing) throw new Error('A shutdown callback cannot await its own shutdown');
        await result;
      } catch (error) {
        failures.push({ order, error });
      }
    };
    // Take each registry before invoking its callbacks. Failed owners cannot
    // retain subscriptions or prevent their siblings from being released.
    for (const unsubscribe of deps.bootstrapUnsubs.splice(0)) await attempt(unsubscribe);
    for (const unsubscribe of deps.runtimeUnsubs.splice(0)) await attempt(unsubscribe);
    await attempt(() => deps.forensicsCollector.dispose());
    await attempt(() => deps.sessionSpine.close(deps.runtime.sessionId));
    await attempt(() => deps.sessionSpine.dispose());
    await attempt(() => deps.sessionInboundInputs.dispose());
    await attempt(() => deps.sessionUnionCache.dispose());
    // These two owners already drain concurrently. Start both even if one
    // throws synchronously, and await both before touching external services.
    await Promise.all([
      attempt(deps.leaveHostedSession),
      attempt(() => deps.deferredStartup.drain(100)),
    ]);
    // Preserve the startup owner's authority: a pending admitted start must
    // publish its handle before stop. A failed start still permits stopping
    // the existing handle. The shell's deadline retains recovery if it hangs.
    await attempt(deps.settleExternalServices);
    await attempt(deps.stopExternalServices);
    await attempt(() => {
      const timer = deps.agentStatusIntervalRef.value;
      deps.agentStatusIntervalRef.value = null;
      if (timer !== null) clearInterval(timer);
    });
    let title = '';
    await attempt(() => { title = deps.conversationTitle(); });
    // Always attempt the real durable save after independent cleanup errors.
    // Keep its failure visible, so the shell cannot discard recovery on error.
    await attempt(() => shutdownRuntime(
      deps.runtime.sessionId, sessionData, deps.runtime.model, deps.runtime.provider,
      title, deps.scheduleManager, deps.hookDispatcher,
      deps.providerRegistry, deps.sessionOrchestration, deps.persistenceOptions,
    ));
    const errors = failures.sort((a, b) => a.order - b.order).map(({ error }) => error);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'TUI shutdown failed to release one or more owned resources');
  });
}
