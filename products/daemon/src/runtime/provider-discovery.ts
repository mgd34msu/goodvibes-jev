import { persistProviders, scan, type DiscoveredServer, type ScanResult } from '@goodvibes-jev/engine/sdk/platform/discovery';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';

/** Production uses the canonical scanner/cache; tests supply synthetic boundaries. */
export interface DaemonProviderDiscoveryDependencies {
  readonly scan?: (signal: AbortSignal) => Promise<ScanResult>;
  readonly persist?: (roots: Parameters<typeof persistProviders>[0], servers: DiscoveredServer[]) => void | Promise<void>;
}

/** One owned startup scan, without TUI model selection or cache-removal policy. */
export function createDaemonProviderDiscovery(
  roots: Parameters<typeof persistProviders>[0],
  register: (servers: DiscoveredServer[]) => void,
  dependencies: DaemonProviderDiscoveryDependencies = {},
) {
  let closed = false;
  const lifetime = new AbortController();
  let work: Promise<void> | undefined;
  function start(): void {
    if (closed || work) return;
    work = Promise.resolve().then(async () => {
      if (closed) return;
      const result = await (dependencies.scan ? dependencies.scan(lifetime.signal) : scan(undefined, lifetime.signal));
      if (closed || result.servers.length === 0) return;
      register(result.servers);
      // A synchronous callback can reenter host.close(). Fence persistence too.
      if (closed) return;
      await (dependencies.persist ?? persistProviders)(roots, result.servers);
    }).catch(() => {
      if (closed) return;
      // Never inspect or retain scanner/provider/filesystem rejection values.
      try { logger.warn('Daemon background provider discovery failed'); } catch { /* Logging is best effort. */ }
    });
  }
  function close(): Promise<void> {
    closed = true;
    lifetime.abort();
    // Cancel admitted scan requests before awaiting their complete settlement.
    // Persistence already admitted remains owned until its promise settles.
    return work ?? Promise.resolve();
  }
  return { start, close };
}
