import { readJsonFileOrQuarantine, writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import {
  discoverPlugins,
  getPluginDirectories,
  loadPlugin,
  unloadPlugin,
  PluginCleanupError,
  type LoadedPlugin,
  type PluginLoaderDeps,
  type PluginPathOptions,
} from './loader.js';
import {
  PluginTrustStore,
  type PluginTrustTier,
  type PluginTrustRecord,
  type SignatureValidationResult,
} from '../runtime/plugins/trust.js';
import { PluginQuarantineEngine, type QuarantineRecord } from '../runtime/plugins/quarantine.js';
import { isHighRiskCapability, resolveCapabilityManifest } from '../runtime/plugins/manifest.js';
import type { PluginCapability, PluginManifestV2 } from '../runtime/plugins/types.js';
import { summarizeError } from '../utils/error-display.js';
import { DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS, PluginClosedError, PluginInFlightTracker } from './in-flight.js';

/**
 * PluginState, Persisted state for all plugins.
 */
interface PluginState {
  /** Map of plugin name → enabled boolean. */
  enabled: Record<string, boolean>;
  /** Map of plugin name → plugin-specific config. */
  config: Record<string, Record<string, unknown>>;
  /** Map of plugin name → trust record. */
  trust: Record<string, PluginTrustRecord>;
  /** Map of plugin name → quarantine record. */
  quarantine: Record<string, QuarantineRecord>;
}

/**
 * PluginStatus, Public-facing plugin info for /plugin list.
 */
export interface PluginStatus {
  name: string;
  version: string;
  description: string;
  author?: string | undefined;
  enabled: boolean;
  active: boolean;
  /** Trust tier for this plugin. */
  trustTier: PluginTrustTier;
  /** Whether this plugin is currently quarantined. */
  quarantined: boolean;
}

export interface PluginManagerObserver {
  subscribe(callback: () => void): () => void;
  list(): PluginStatus[];
  capabilities(name: string): {
    ok: boolean;
    error?: string | undefined;
    requested: string[];
    highRisk: string[];
    safe: string[];
    tier: PluginTrustTier;
    blocked: string[];
  } | null;
  getTrustRecord(name: string): Readonly<PluginTrustRecord> | undefined;
  getQuarantineRecord(name: string): Readonly<QuarantineRecord> | undefined;
}

const DEFAULT_STATE: PluginState = { enabled: {}, config: {}, trust: {}, quarantine: {} };

export interface PluginManagerOptions {
  readonly pathOptions: PluginPathOptions;
  readonly stateFilePath?: string | undefined;
}

/** Outcome of PluginManager.reload(). */
export interface PluginReloadSummary {
  reloaded: number;
  /** Plugins that failed to load, plus every plugin in notDrained. */
  failed: number;
  /**
   * Plugins left loaded on their current instance because calls into them
   * were still running when the quiesce timeout passed.
   */
  notDrained: string[];
}

/** Mechanical progress evidence for a caller awaiting plugin shutdown. */
export interface PluginShutdownStatus {
  readonly state: 'open' | 'closing' | 'closed' | 'failed';
  readonly lifecycleOperations: number;
  readonly pendingInstances: number;
  readonly activeCalls: readonly { readonly pluginName: string; readonly count: number }[];
  readonly cleanupFailures: number;
}

/**
 * PluginManager, orchestrates plugin discovery, loading, and persistence.
 */
export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private state: PluginState = { ...DEFAULT_STATE, enabled: {}, config: {}, trust: {}, quarantine: {} };
  private deps: PluginLoaderDeps | undefined;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private closeSettled = false;
  private closeFailures = 0;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly acquired = new Set<LoadedPlugin>();
  private readonly unloading = new WeakMap<LoadedPlugin, Promise<void>>();
  private readonly ownedCalls = new Map<PluginInFlightTracker, Set<string>>();
  private readonly cleanupErrors = new Set<PluginCleanupError>();
  /** Counts calls into loaded plugins so a reload can drain them first. */
  private inFlight = new PluginInFlightTracker();

  /** Trust store, manages tier records for all plugins. */
  private readonly trustStore = new PluginTrustStore();
  /** Quarantine engine, manages plugin quarantine state. */
  private readonly quarantineEngine = new PluginQuarantineEngine();
  private readonly subscribers = new Set<() => void>();
  private readonly pathOptions: PluginPathOptions;
  private readonly stateFilePath: string;

  constructor(options: PluginManagerOptions) {
    this.pathOptions = options.pathOptions;
    if (!options.stateFilePath) {
      throw new Error('PluginManager requires an explicit stateFilePath.');
    }
    this.stateFilePath = options.stateFilePath;
  }

  /**
   * init, Must be called once at startup with application dependencies.
   * Loads state from disk, then discovers and loads all enabled plugins.
   */
  init(deps: PluginLoaderDeps): Promise<void> {
    return this.ownOperation(async () => {
      if (deps.inFlight) this.inFlight = deps.inFlight;
      this.deps = { ...deps, inFlight: this.inFlight };
      this.loadState();
      await this.loadEnabledPlugins();
    });
  }

  /** Returns status for all discovered plugins (enabled or not). */
  list(): PluginStatus[] {
    const discovered = this.discoverPlugins();
    return discovered.map((d) => {
      const loaded = this.plugins.get(d.manifest.name);
      return {
        name: d.manifest.name,
        version: d.manifest.version,
        description: d.manifest.description,
        author: d.manifest.author,
        enabled: this.isEnabled(d.manifest.name),
        active: loaded?.active ?? false,
        trustTier: this.trustStore.getTier(d.manifest.name),
        quarantined: this.quarantineEngine.isQuarantined(d.manifest.name),
      };
    });
  }

  subscribe(callback: () => void): () => void {
    if (this.closed) return () => undefined;
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getTrustRecord(name: string): Readonly<PluginTrustRecord> | undefined {
    return this.trustStore.getRecord(name);
  }

  getQuarantineRecord(name: string): Readonly<QuarantineRecord> | undefined {
    return this.quarantineEngine.getRecord(name);
  }

  /**
   * trust, Set the trust tier for a plugin.
   *
   * For the `trusted` tier, prefer `trustSigned()` which also validates the
   * signature. This method is for operator-forced tier assignment.
   */
  trust(
    name: string,
    tier: PluginTrustTier,
    note?: string | undefined,
  ): { ok: boolean; error?: string } {
    if (this.closed) return { ok: false, error: 'Plugin manager is closed' };
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    // Warn if trying to manually set 'trusted' without a signed manifest.
    if (tier === 'trusted') {
      const manifest = discovered.manifest as { signature?: string };
      if (!manifest.signature) {
        logger.warn(
          `[plugins] '${name}' set to 'trusted' tier without a signed manifest, ` +
          'consider using /plugin verify first',
        );
      }
    }

    const record = this.trustStore.setTier(name, tier, { note });
    this.state.trust[name] = record;
    this.saveState();
    logger.info(`[plugins] ${name}: trust tier set to '${tier}'`);
    this.notifySubscribers();
    return { ok: true };
  }

  /**
   * trustSigned, Elevate a plugin to `trusted` after validating its manifest signature.
   */
  trustSigned(
    name: string,
    publicKey?: string,
  ): { ok: boolean; fingerprint?: string | undefined; error?: string } {
    if (this.closed) return { ok: false, error: 'Plugin manager is closed' };
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    const manifest = discovered.manifest as {
      name: string;
      version: string;
      capabilities?: string[] | undefined;
      signature?: string | undefined;
    };

    const result = this.trustStore.trustSigned(name, manifest, publicKey);
    if (!result.ok) {
      return { ok: false, error: result.reason };
    }

    this.state.trust[name] = result.record;
    this.saveState();
    this.notifySubscribers();
    return { ok: true, fingerprint: result.record.signatureFingerprint };
  }

  /**
   * verify, Inspect a plugin's manifest signature without changing its tier.
   */
  verify(name: string, publicKey?: string): { ok: boolean } & SignatureValidationResult {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, valid: false, reason: this.notFoundError(name) };
    }

    const manifest = discovered.manifest as {
      name: string;
      version: string;
      capabilities?: string[] | undefined;
      signature?: string | undefined;
    };

    const result = this.trustStore.verify(manifest, publicKey);
    return { ok: result.valid, ...result };
  }

  /**
   * capabilities, Return the capability information for a plugin.
   *
   * Returns the full set: requested, granted (based on current trust tier),
   * denied, and which capabilities are high-risk.
   */
  capabilities(name: string): {
    ok: boolean;
    error?: string | undefined;
    requested: string[];
    highRisk: string[];
    safe: string[];
    tier: PluginTrustTier;
    blocked: string[];
  } | null {
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return null;
    }

    const manifest = discovered.manifest as { capabilities?: string[] };
    const requested = (manifest.capabilities ?? []) as PluginCapability[];
    const tier = this.trustStore.getTier(name);
    const highRisk = requested.filter((c) => isHighRiskCapability(c));
    const safe = requested.filter((c) => !isHighRiskCapability(c));
    // Capabilities blocked by current trust tier
    const blocked = tier !== 'trusted' ? highRisk : [];

    return { ok: true, requested, highRisk, safe, tier, blocked };
  }

  /**
   * quarantine, Apply quarantine to a plugin.
   *
   * This is the high-level operator path. It resolves the plugin's declared
   * capability manifest using the current trust tier, then applies quarantine
   * immediately to the resolved capability set.
   */
  quarantine(
    name: string,
    reason: string,
  ): { ok: boolean; error?: string } {
    if (this.closed) return { ok: false, error: 'Plugin manager is closed' };
    const discovered = this.findDiscoveredPlugin(name);
    if (!discovered) {
      return { ok: false, error: this.notFoundError(name) };
    }

    if (this.quarantineEngine.isQuarantined(name)) {
      return { ok: false, error: `Plugin '${name}' is already quarantined` };
    }

    const trustTier = this.trustStore.getTier(name);
    const capabilityManifest = resolveCapabilityManifest(
      name,
      discovered.manifest as PluginManifestV2,
      undefined,
      trustTier,
    );

    const record = this.quarantineEngine.quarantine(name, capabilityManifest, reason);
    if (!record) {
      return { ok: false, error: `Failed to quarantine '${name}'` };
    }

    this.state.quarantine[name] = { ...record, revokedCapabilities: [...record.revokedCapabilities] };
    this.saveState();
    logger.warn(`[plugins] ${name}: quarantined, ${reason}`);
    this.notifySubscribers();
    return { ok: true };
  }

  /**
   * liftQuarantine, Remove quarantine from a plugin.
   */
  liftQuarantine(name: string): { ok: boolean; error?: string } {
    if (this.closed) return { ok: false, error: 'Plugin manager is closed' };
    if (!this.quarantineEngine.isQuarantined(name)) {
      return { ok: false, error: `Plugin '${name}' is not quarantined` };
    }
    this.quarantineEngine.lift(name);
    const record = this.quarantineEngine.getRecord(name);
    if (record) {
      this.state.quarantine[name] = { ...record, revokedCapabilities: [...record.revokedCapabilities] };
    }
    this.saveState();
    logger.info(`[plugins] ${name}: quarantine lifted`);
    this.notifySubscribers();
    return { ok: true };
  }

  /** Enable a plugin by name. Loads it immediately if deps are available. */
  enable(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.ownOperation(async () => {
      if (this.isEnabled(name)) {
        return { ok: false, error: `Plugin '${name}' is already enabled` };
      }

      const discovered = this.findDiscoveredPlugin(name);
      if (!discovered) {
        return { ok: false, error: this.notFoundError(name) };
      }

      this.state.enabled[name] = true;
      this.saveState();

      if (this.deps) {
        const loaded = await this.acquire(discovered, this.deps);
        if (loaded) {
          this.plugins.set(name, loaded);
          this.notifySubscribers();
        } else {
          // The admitted operator preference was already saved. Shutdown can
          // refuse registrations during init; retain that intent for restart.
          if (this.closed) return { ok: false, error: 'Plugin manager closed during enable; enabled preference retained' };
          // Revert enable on load failure
          delete this.state.enabled[name];
          this.saveState();
          return { ok: false, error: `Plugin '${name}' failed to load, check logs` };
        }
      }

      return this.closed ? { ok: false, error: 'Plugin manager closed during enable' } : { ok: true };
    });
  }

  /** Disable a plugin by name. Deactivates it immediately if active. */
  disable(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.ownOperation(async () => {
      if (!this.isEnabled(name)) {
        return { ok: false, error: `Plugin '${name}' is not enabled` };
      }

      const loaded = this.plugins.get(name);
      if (loaded) {
        await this.unload(loaded);
        this.plugins.delete(name);
      }

      delete this.state.enabled[name];
      this.saveState();
      this.notifySubscribers();
      return { ok: true };
    });
  }

  /**
   * Reload all currently enabled plugins (deactivate then reactivate). Each
   * loaded plugin is quiesced first: new calls into it are refused and the
   * calls already running get up to `quiesceTimeoutMs` to finish. A plugin
   * still busy at the timeout is not reloaded; it stays on its current
   * instance and is reported in `notDrained`.
   */
  reload(options: { readonly quiesceTimeoutMs?: number | undefined } = {}): Promise<PluginReloadSummary> {
    return this.ownOperation(async () => {
      const quiesceTimeoutMs = options.quiesceTimeoutMs ?? DEFAULT_PLUGIN_QUIESCE_TIMEOUT_MS;
      const names = Object.keys(this.state.enabled).filter((n) => this.state.enabled[n]);
      const loadedNames = names.filter((name) => this.plugins.has(name));
      let reloaded = 0;
      let failed = 0;

      const drains = await Promise.all(loadedNames.map(async (name) => ({
        name,
        drain: await this.inFlight.quiesce(name, quiesceTimeoutMs),
      })));
      if (this.closed) throw new PluginClosedError('manager');
      const notDrained = new Set<string>();
      for (const { name, drain } of drains) {
        if (drain.drained) continue;
        notDrained.add(name);
        this.inFlight.resume(name);
        logger.warn(`[plugins] ${name}: not reloaded, ${drain.inFlight} call(s) still running after ${quiesceTimeoutMs}ms`);
      }

      try {
        // Deactivate every drained plugin
        for (const name of names) {
          if (notDrained.has(name)) continue;
          const loaded = this.plugins.get(name);
          if (loaded) {
            await this.unload(loaded);
            this.plugins.delete(name);
          }
        }

        // Reactivate with cache busting, append timestamp to force fresh import
        if (this.deps) {
          const discovered = this.discoverPlugins();
          const cacheBust = Date.now();
          for (const d of discovered) {
            if (this.closed) break;
            if (!this.isEnabled(d.manifest.name) || notDrained.has(d.manifest.name)) continue;
            // Pass cacheBust so loadPlugin appends ?t=<timestamp> to the import URL,
            // forcing Bun to bypass its module cache and re-execute the file.
            const loaded = await this.acquire(d, this.deps, cacheBust);
            if (loaded) {
              this.plugins.set(d.manifest.name, loaded);
              reloaded++;
            } else {
              failed++;
            }
          }
        }
      } finally {
        for (const { name } of drains) this.inFlight.resume(name);
      }
      failed += notDrained.size;
      this.notifySubscribers();
      return { reloaded, failed, notDrained: [...notDrained] };
    });
  }

  /** Returns whether a plugin is marked as enabled in persisted state. */
  isEnabled(name: string): boolean {
    return this.state.enabled[name] === true;
  }

  /** Returns plugin-specific config for a given plugin name. */
  getPluginConfig(name: string): Record<string, unknown> {
    return this.state.config[name] ?? {};
  }

  /**
   * Stop this manager's admission, await admitted lifecycle work and calls,
   * then release every acquired instance. Operator enable/trust/config state
   * stays unchanged. Unsettled plugin callbacks keep close pending; cleanup
   * failures reject after all instances have been attempted.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.subscribers.clear();
    const drains: Promise<void>[] = [];
    for (const [tracker, names] of this.ownedCalls) {
      for (const name of names) drains.push(tracker.close(name));
    }
    const operations = [...this.operations];
    this.closePromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...drains, ...operations]);
      const errors: unknown[] = [...this.cleanupErrors];
      for (const loaded of [...this.acquired]) {
        try {
          await this.unload(loaded);
        } catch (error) {
          errors.push(error);
        }
      }
      this.plugins.clear();
      this.deps = undefined;
      this.closeFailures = errors.length;
      if (errors.length > 0) throw new AggregateError(errors, 'Plugin manager shutdown cleanup did not complete');
    });
    void this.closePromise.then(
      () => { this.closeSettled = true; },
      () => { this.closeSettled = true; },
    );
    return this.closePromise;
  }

  shutdownStatus(): PluginShutdownStatus {
    const counts = new Map<string, number>();
    for (const [tracker, names] of this.ownedCalls) {
      for (const name of names) {
        const count = tracker.inFlight(name);
        if (count > 0) counts.set(name, (counts.get(name) ?? 0) + count);
      }
    }
    return {
      state: !this.closed ? 'open' : !this.closeSettled ? 'closing' : this.closeFailures > 0 ? 'failed' : 'closed',
      lifecycleOperations: this.operations.size,
      pendingInstances: this.acquired.size,
      activeCalls: [...counts].map(([pluginName, count]) => ({ pluginName, count })),
      cleanupFailures: Math.max(this.closeFailures, this.cleanupErrors.size),
    };
  }

  private ownOperation<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new PluginClosedError('manager'));
    const pending = Promise.resolve().then(() => {
      if (this.closed) throw new PluginClosedError('manager');
      return action();
    });
    this.operations.add(pending);
    void pending.then(
      () => this.operations.delete(pending),
      (error: unknown) => {
        this.operations.delete(pending);
        if (error instanceof PluginCleanupError) this.cleanupErrors.add(error);
      },
    );
    return pending;
  }

  private async acquire(discovered: Parameters<typeof loadPlugin>[0], deps: PluginLoaderDeps, cacheBust?: number): Promise<LoadedPlugin | null> {
    if (this.closed) return null;
    const tracker = deps.inFlight ?? this.inFlight;
    const names = this.ownedCalls.get(tracker) ?? new Set<string>();
    this.ownedCalls.set(tracker, names);
    names.add(discovered.manifest.name);
    const loaded = await loadPlugin(discovered, deps, cacheBust, { throwOnCleanupError: true });
    if (loaded) this.acquired.add(loaded);
    return loaded;
  }

  private unload(loaded: LoadedPlugin): Promise<void> {
    const prior = this.unloading.get(loaded);
    if (prior) return prior;
    const pending = Promise.resolve().then(async () => {
      try {
        await unloadPlugin(loaded, { throwOnCleanupError: true });
      } finally {
        this.acquired.delete(loaded);
      }
    });
    this.unloading.set(loaded, pending);
    return pending;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async loadEnabledPlugins(): Promise<void> {
    if (!this.deps) return;
    const discovered = this.discoverPlugins();
    for (const d of discovered) {
      if (this.closed) break;
      if (!this.isEnabled(d.manifest.name)) continue;
      const loaded = await this.acquire(d, this.deps);
      if (loaded) {
        this.plugins.set(d.manifest.name, loaded);
      }
    }
    this.notifySubscribers();
  }

  private loadState(): void {
    try {
      const parsed = readJsonFileOrQuarantine<Partial<PluginState>>(this.stateFilePath, {
        label: 'plugins/state',
        recovery: 'Every plugin returns to its default enabled state, trust decisions must be made again, and any recorded quarantine is cleared.',
        validate: (raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('plugin state file is not a JSON object');
          }
          return raw as Partial<PluginState>;
        },
      });
      if (parsed) {
        this.state.enabled = parsed.enabled ?? {};
        this.state.config = parsed.config ?? {};
        this.state.trust = parsed.trust ?? {};
        this.state.quarantine = parsed.quarantine ?? {};
        // Restore trust and quarantine state into their engines.
        if (Object.keys(this.state.trust).length > 0) {
          this.trustStore.importRecords(this.state.trust);
        }
        if (Object.keys(this.state.quarantine).length > 0) {
          this.quarantineEngine.importRecords(this.state.quarantine);
        }
      }
    } catch (err) {
      logger.warn(`[plugins] Could not load state: ${summarizeError(err)}`);
    }
  }

  private saveState(): void {
    try {
      writeJsonFileAtomic(this.stateFilePath, this.state, { trailingNewline: false });
    } catch (err) {
      logger.warn(`[plugins] Could not save state: ${summarizeError(err)}`);
    }
  }

  private discoverPlugins() {
    return discoverPlugins(this.pathOptions);
  }

  private findDiscoveredPlugin(name: string) {
    return this.discoverPlugins().find((plugin) => plugin.manifest.name === name);
  }

  private notFoundError(name: string): string {
    return `Plugin '${name}' not found in configured plugin search directories (${this.describeSearchDirectories()})`;
  }

  private describeSearchDirectories(): string {
    return getPluginDirectories(this.pathOptions).join(', ');
  }

  private notifySubscribers(): void {
    if (this.closed) return;
    for (const callback of this.subscribers) {
      try {
        callback();
      } catch (err) {
        logger.warn('[plugins] subscriber callback failed', {
          error: summarizeError(err),
        });
      }
    }
  }

}
