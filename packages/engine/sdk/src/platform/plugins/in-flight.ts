/**
 * plugins/in-flight.ts, per-plugin accounting of calls into plugin code, so a
 * reload can drain a plugin before unloading it.
 *
 * Every callable a plugin registers through the PluginAPI (slash command
 * handlers, tool handlers, gateway method handlers, runtime event hooks) is
 * wrapped by createPluginAPI to run through `track()`. A call counts as in
 * flight from the moment it enters plugin code until it returns, or, when it
 * returns a promise, until that promise settles.
 *
 * `quiesce()` marks a plugin as quiescing: from then on new calls are refused
 * with PluginQuiescingError (never queued: a queued call would otherwise run
 * against the instance being unloaded), and the returned promise resolves once
 * the in-flight count reaches zero or the timeout passes. `resume()` lifts the
 * refusal, either because the reload finished or because it was abandoned.
 */

/** Default bound for waiting on in-flight plugin calls before an unload. */
export const DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS = 30_000;

/** A call into a plugin refused because the plugin is quiescing for a reload. */
export class PluginQuiescingError extends Error {
  readonly pluginName: string;

  constructor(pluginName: string) {
    super(`Plugin '${pluginName}' is reloading; the call was refused and can be retried once the reload completes`);
    this.name = 'PluginQuiescingError';
    this.pluginName = pluginName;
  }
}

/** The outcome of waiting for a plugin's in-flight calls to finish. */
export interface PluginQuiesceResult {
  /** True when the in-flight count reached zero within the timeout. */
  readonly drained: boolean;
  /** Calls still in flight when the wait ended (0 when drained). */
  readonly inFlight: number;
  readonly waitedMs: number;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function')
    && value !== null
    && typeof (value as { then?: unknown }).then === 'function';
}

export class PluginInFlightTracker {
  private readonly counts = new Map<string, number>();
  private readonly quiescing = new Set<string>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();

  /** Calls into `plugin` currently in flight. */
  inFlight(plugin: string): number {
    return this.counts.get(plugin) ?? 0;
  }

  /** Whether new calls into `plugin` are currently refused. */
  isQuiescing(plugin: string): boolean {
    return this.quiescing.has(plugin);
  }

  /**
   * Run one call into `plugin`, counted until it returns or its promise
   * settles. Throws PluginQuiescingError without running `call` while the
   * plugin is quiescing. The call's own result or error passes through.
   */
  track<T>(plugin: string, call: () => T): T {
    if (this.quiescing.has(plugin)) throw new PluginQuiescingError(plugin);
    this.counts.set(plugin, this.inFlight(plugin) + 1);
    let result: T;
    try {
      result = call();
    } catch (error) {
      this.leave(plugin);
      throw error;
    }
    if (isThenable(result)) {
      result.then(() => this.leave(plugin), () => this.leave(plugin));
    } else {
      this.leave(plugin);
    }
    return result;
  }

  /**
   * Refuse new calls into `plugin` and wait until its in-flight calls finish,
   * at most `timeoutMs`. The refusal stays in place until `resume()`, whatever
   * the outcome, so the caller decides what happens next.
   */
  async quiesce(plugin: string, timeoutMs: number = DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS): Promise<PluginQuiesceResult> {
    this.quiescing.add(plugin);
    const startedAt = Date.now();
    if (this.inFlight(plugin) === 0) return { drained: true, inFlight: 0, waitedMs: 0 };
    const drained = await new Promise<boolean>((resolve) => {
      let waiters = this.idleWaiters.get(plugin);
      if (!waiters) {
        waiters = new Set();
        this.idleWaiters.set(plugin, waiters);
      }
      const timer = setTimeout(() => {
        waiters.delete(onIdle);
        resolve(false);
      }, Math.max(0, timeoutMs));
      const onIdle = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      waiters.add(onIdle);
    });
    return { drained, inFlight: this.inFlight(plugin), waitedMs: Date.now() - startedAt };
  }

  /** Accept new calls into `plugin` again. */
  resume(plugin: string): void {
    this.quiescing.delete(plugin);
  }

  private leave(plugin: string): void {
    const remaining = this.inFlight(plugin) - 1;
    if (remaining > 0) {
      this.counts.set(plugin, remaining);
      return;
    }
    this.counts.delete(plugin);
    const waiters = this.idleWaiters.get(plugin);
    if (!waiters) return;
    this.idleWaiters.delete(plugin);
    for (const onIdle of waiters) onIdle();
  }
}
