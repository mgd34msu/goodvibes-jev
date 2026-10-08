import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting } from './schema.js';
import { DEFAULT_CONFIG, CONFIG_SCHEMA } from './schema.js';
import { ConfigError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookEvent } from '../hooks/types.js';
import { attachOwnedConfigHook } from './hook-attachment.js';
import { getManagedSettingLock } from '../runtime/settings/control-plane.js';
import { readHostManagedSettingLock } from '../runtime/settings/host-setting-policy-read.js';
import { requireSurfaceRoot, resolveSharedDirectory, resolveSurfaceDirectory, resolveSurfaceSharedFile } from '../runtime/surface-root.js';
import { summarizeError } from '../utils/error-display.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import { runDaemonTierMigrationPasses, runLoadMigrationPasses } from './manager-migration-passes.js';
import {
  SHARED_CONFIG_KEYS,
  isSharedConfigKey,
  persistSharedKey,
  readDotPath,
  readSharedTierFile,
  removeSharedKey,
} from './shared-config-tier.js';
import {
  deleteRawDotPath,
  isFrozenDefaultDump,
  readRawSettingsFile,
  stripFrozenDefaults,
  writeRawDotPath,
} from './settings-io.js';
import { watchConfigFiles, reloadAndNotifyChanges, type ConfigFileWatchHandle } from './config-file-watcher.js';
import { isDaemonOwnedConfigKey, listDaemonOwnedConfigPaths, type DaemonOwnedConfigPath } from './config-ownership.js';
import { resolveOrCreateDaemonPath } from './daemon-tier-paths.js';
import { clearDaemonTierForReset, daemonConfigPath, overlayDaemonTierFrom, persistDaemonKey, readDaemonTierFile } from './daemon-config-tier.js';
import { describeKeySource, type ConfigKeySource } from './manager-key-source.js';
import { DEFAULT_CONFIG_SNAPSHOT, cloneDefaultConfig, coerceSchemaValue, ensureSharedConfig, requireAbsoluteOwnedPath, sanitizeConfigShape } from './manager-bootstrap.js';
import { resolveWithProfileFallback, type ConfigProfileFallbackReader } from './profile-fallback.js';
import { ingestManagerSettings, toConfigLoadFailure, UnknownSettingFormsQueue, type IngestionNoticeSink, type SettingsIngestionNotice } from './manager-ingestion.js';
import { persistCategoryKeyRemoval, persistCategoryPatch, type CategoryIoDeps } from './manager-category-io.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { HostSettings, type HostBooleanSetting, type HostBooleanSettingHandle, type HostSettingValues } from './host-settings.js';
import { HostSettingsReadError, hostSettingsFileExists, readHostSettingValues, readHostSettingsFile, recoverHostSettingsWriteFailure } from './manager-host-settings.js';
import { announceIngestionNotice } from './settings-ingestion.js';

/** Typed values for a single daemon-settings update; scope is checked at runtime. */
export type DaemonConfigPatch = { readonly [K in ConfigKey]?: ConfigValue<K> };

/** Deep immutable type, prevents mutation of nested objects returned from getAll(). */
export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

/** Constructor overrides for CLI args and programmatic instantiation. */
interface ConfigCliOverrides {
  /** Per-instance surface-owned boolean leaves; their declared defaults must be restrictive. */
  hostSettings?: readonly HostBooleanSetting[] | undefined;
  /** Read without creating files, persisting migrations or receipts; mutators refuse. */
  readOnly?: boolean | undefined;
  /** Withhold borrowed parse-error text from unreadable-settings diagnostics; private errors retain it. */
  diagnosticMode?: 'default' | 'structural' | undefined;
  model?: string | undefined;
  autoApprove?: boolean | undefined;
  systemPromptFile?: string | undefined;
  workingDir?: string | undefined;
  surfaceRoot?: string | undefined;
  /**
   * True only in the daemon composition, which OWNS the daemon tier file. A
   * client READS it and migrates its own view, never the bytes; the default is
   * that non-writing answer. See MigrationOwnership in ./manager-migration-passes.ts.
   */
  ownsDaemonTier?: boolean | undefined;
}

export type ConfigOverrides = ConfigCliOverrides & (
  | {
    configDir: string;
    homeDir?: string | undefined;
    sharedConfigPath?: string | undefined;
    sharedTierPath?: string | undefined;
    daemonTierPath?: string | undefined;
  }
  | {
    homeDir: string;
    configDir?: string | undefined;
    sharedConfigPath?: string | undefined;
    sharedTierPath?: string | undefined;
    daemonTierPath?: string | undefined;
  }
);

interface ConfigRoots {
  configDir?: string | undefined;
  homeDir?: string | undefined;
  sharedConfigPath?: string | undefined;
  sharedTierPath?: string | undefined;
  daemonTierPath?: string | undefined;
  surfaceRoot?: string | undefined;
}

/**
 * The tier a value resolved from, and the full source report. `daemon` is the
 * daemon's own store, the single home of every daemon-owned key (see
 * config-ownership.ts), overlaid last so a value left behind in a surface silo
 * can never shadow it. Defined in manager-key-source.ts; re-exported here so
 * existing importers keep working.
 */
export type { ConfigKeyTier, ConfigKeySource } from './manager-key-source.js';

export interface ConfigSetOptions {
  bypassManagedLock?: boolean | undefined;
}

/** Callback invoked when a watched config key changes. */
export type ConfigChangeCallback<K extends ConfigKey> = (newValue: ConfigValue<K>, oldValue: ConfigValue<K>) => void;

/** Unsubscribe handle returned by ConfigManager.subscribe(). */
export type ConfigUnsubscribe = () => void;

/**
 * ConfigManager, Layered, mutable, persistent config system.
 *
 * Load order: defaults < global surface settings < project surface settings < CLI overrides
 * API keys are never persisted, loaded from env vars only.
 */
export class ConfigManager {
  private readonly readOnly: boolean;
  private readonly diagnosticMode: 'default' | 'structural';
  private readonly hostSettings: HostSettings;
  private hostLoadValues: HostSettingValues | null = null;
  private config: GoodVibesConfig;
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly projectConfigPath: string | null;
  private readonly workingDirectory: string | null;
  private readonly homeDirectory: string | null;
  /** Surface-root-independent shared settings file (~/.goodvibes/shared/settings.json), or null. */
  private readonly sharedTierPath: string | null;
  /** The daemon's own settings store (`~/.goodvibes/daemon/settings.json`), or null. */
  private readonly daemonTierPath: string | null;
  /** True only in the daemon composition, the runtime allowed to REWRITE that store. */
  private readonly daemonTierOwner: boolean;
  /** Shared keys whose value the last load actually sourced from the shared tier file. */
  private readonly sharedKeysPresent = new Set<ConfigKey>();
  /** Daemon-owned keys the last load sourced from the daemon store. */
  private readonly daemonKeysPresent = new Set<DaemonOwnedConfigPath>();
  private hookDispatcher: Pick<HookDispatcher, 'fire'> | null = null;
  /** Owner-profile read fallback for UNSET keys. Injected; null unless installed. */
  private profileFallback: ConfigProfileFallbackReader | null = null;
  private readonly invalidationListeners = new Set<() => void>();
  private permissionIncarnation = 0;
  private readonly _listeners = new Map<string, Set<(newVal: unknown, oldVal: unknown) => void>>();
  /** Active config-file watch handle (external-edit live reload), or null. */
  private _fileWatch: ConfigFileWatchHandle | null = null;
  /** Settings the last load could not ingest. See ./settings-ingestion.ts. */
  private ingestionNotices: SettingsIngestionNotice[] = [];
  private readonly unknownSettingForms = new UnknownSettingFormsQueue();

  constructor(overrides: ConfigOverrides) {
    this.readOnly = overrides.readOnly ?? false;
    this.diagnosticMode = overrides.diagnosticMode ?? 'default';
    this.hostSettings = new HostSettings(overrides.hostSettings);
    const roots = overrides as ConfigRoots;
    const configDir = requireAbsoluteOwnedPath(roots.configDir, 'configDir');
    const homeDirectory = requireAbsoluteOwnedPath(roots.homeDir, 'homeDir') ?? null;
    const workingDirectory = requireAbsoluteOwnedPath(overrides.workingDir, 'workingDir') ?? null;
    const sharedConfigPath = requireAbsoluteOwnedPath(roots.sharedConfigPath, 'sharedConfigPath');
    const surfaceRoot = roots.surfaceRoot ? requireSurfaceRoot(roots.surfaceRoot, 'ConfigManager surfaceRoot') : null;
    if ((!configDir || workingDirectory || homeDirectory) && !surfaceRoot) {
      throw new Error('ConfigManager surfaceRoot is required when deriving config paths from homeDir/workingDir.');
    }
    const base = configDir ?? resolveSurfaceDirectory(homeDirectory!, surfaceRoot!);
    this.configDir = base;
    this.configPath = join(base, 'settings.json');
    this.workingDirectory = workingDirectory;
    this.homeDirectory = homeDirectory;
    this.projectConfigPath = this.workingDirectory
      ? resolveSurfaceDirectory(this.workingDirectory, surfaceRoot!, 'settings.json')
      : null;
    this.config = cloneDefaultConfig();
    this.hostSettings.apply(this.config, this.hostSettings.defaults());

    const ownedSharedConfigPath = sharedConfigPath ?? (
      this.homeDirectory ? resolveSurfaceSharedFile(this.homeDirectory, surfaceRoot!) : null
    );
    if (ownedSharedConfigPath && !this.readOnly) {
      ensureSharedConfig(ownedSharedConfigPath);
    }

    // The surface-root-INDEPENDENT shared tier for cross-surface keys (tts.*):
    // an explicit override, else derived from homeDir as ~/.goodvibes/shared/
    // settings.json. A configDir-only construction (no homeDir) has no shared tier.
    const sharedTierPath = requireAbsoluteOwnedPath(roots.sharedTierPath, 'sharedTierPath');
    this.sharedTierPath = sharedTierPath ?? (
      this.homeDirectory ? resolveSharedDirectory(this.homeDirectory, 'shared', 'settings.json') : null
    );

    // The daemon tier: every daemon-owned key's single home, shared by every
    // product on this machine. Surface-root-independent, exactly like the
    // shared tier, the daemon is a peer runtime, not a guest in the TUI's
    // storage root. A configDir-only construction (no homeDir) has none.
    const daemonTierPath = requireAbsoluteOwnedPath(roots.daemonTierPath, 'daemonTierPath');
    this.daemonTierPath = daemonTierPath ?? (
      this.homeDirectory ? daemonConfigPath(this.homeDirectory) : null
    );
    // Set BEFORE load(): that load is where the daemon-tier migration asks.
    this.daemonTierOwner = !this.readOnly && overrides.ownsDaemonTier === true;

    this.load();

    // Apply constructor overrides (CLI args, etc.) after load
    if (overrides.model !== undefined) {
      this.config.provider.model = overrides.model;
    }
    if (overrides.autoApprove !== undefined) {
      this.config.behavior.autoApprove = overrides.autoApprove;
    }
    if (overrides.systemPromptFile !== undefined) {
      this.config.provider.systemPromptFile = overrides.systemPromptFile;
    }
  }

  getControlPlaneConfigDir(): string {
    return this.configDir;
  }

  /** One owned, synchronous permission frame; no listeners/hooks run while it is copied. */
  getAutonomousPermissionSnapshot(): Readonly<{ permissions: GoodVibesConfig['permissions']; autoApprove: boolean; directory: string | null; incarnation: number }> {
    // Preserve the public detached-copy contract. Admission captures its own
    // deeply frozen frame through snapshotJudgmentInput before any await.
    return structuredClone({ permissions: this.config.permissions, autoApprove: this.config.behavior.autoApprove,
      directory: this.workingDirectory, incarnation: this.permissionIncarnation });
  }

  getWorkingDirectory(): string | null {
    return this.workingDirectory;
  }

  getHomeDirectory(): string | null {
    return this.homeDirectory;
  }

  /** Absolute global surface settings path. */
  getConfigPath(): string {
    return this.configPath;
  }

  /** Project settings path, when a working directory was supplied. */
  getProjectConfigPath(): string | undefined {
    return this.projectConfigPath ?? undefined;
  }

  attachHookDispatcher(hookDispatcher: Pick<HookDispatcher, 'fire'> | null): () => void {
    return attachOwnedConfigHook(this, dispatcher => { this.hookDispatcher = dispatcher; }, hookDispatcher);
  }

  /** Install (or clear) the owner-profile read fallback. See ./profile-fallback.ts. */
  attachProfileFallback(reader: ConfigProfileFallbackReader | null): void {
    this.profileFallback = reader;
  }

  private resolvePath(
    key: DaemonOwnedConfigPath,
  ): { parent: Record<string, unknown>; field: string } {
    const parts = key.split('.');
    let cursor: unknown = this.config;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (cursor == null || typeof cursor !== 'object' || !(part in (cursor as Record<string, unknown>))) {
        throw new Error(`Invalid config path: section '${parts.slice(0, i + 1).join('.')}' does not exist`);
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }

    if (cursor == null || typeof cursor !== 'object') {
      throw new Error(`Invalid config path: section '${parts.slice(0, -1).join('.')}' does not exist`);
    }

    return {
      parent: cursor as Record<string, unknown>,
      field: parts[parts.length - 1]!,
    };
  }

  /**
   * Get a config value by dot-path key.
   *
   * An UNSET key may resolve from the owner profile when a fallback reader is
   * installed, one keyed read by a consumer that needs the value. Deliberately
   * not applied by `getAll()` or any category/dump path: see ./profile-fallback.ts.
   */
  get<K extends ConfigKey>(key: K): ConfigValue<K> {
    const { parent, field } = this.resolvePath(key);
    return resolveWithProfileFallback(key, parent[field], this.profileFallback) as ConfigValue<K>;
  }

  /** Validate registration and return an immutable, manager-bound boolean handle. */
  getHostBooleanSetting(key: string): HostBooleanSettingHandle {
    if (!this.hostSettings.has(key)) throw new ConfigError(`Host boolean setting ${key} is not registered on this manager.`);
    const registeredKey = key as ConfigKey;
    const definition = this.hostSettings.definitions.find(entry => entry.key === key)!;
    const handle: HostBooleanSettingHandle = {
      key,
      get: () => this.get(registeredKey) as boolean,
      getResolved: () => {
        const value = this.get(registeredKey) as boolean;
        return Object.freeze({ key, value, defaultValue: definition.default, source: value === definition.default ? 'default' : 'local',
          managedLock: readHostManagedSettingLock(key, this.configDir) });
      },
      set: (value, options) => this.setDynamic(registeredKey, value, options),
      setProjectValue: (value, options) => this.setProjectValue(registeredKey, value as never, options),
      subscribe: (callback) => this.subscribe(registeredKey, (next, previous) => callback(next as boolean, previous as boolean)),
      reset: () => this.reset(registeredKey),
    };
    return Object.freeze(handle);
  }

  /** Opaque pre-mutation lifetime signal, including category changes and reloads.
   * Conservative: a failed or no-op mutation may invalidate too. No values leak.
   */
  onDidInvalidate(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => { this.invalidationListeners.delete(listener); };
  }

  private invalidateLifetimes(): void {
    // Publish before observers run, even if a mutation subsequently restores
    // the same value. Outstanding admission cannot survive an A -> B -> A turn.
    this.permissionIncarnation++;
    for (const listener of [...this.invalidationListeners]) {
      try { listener(); } catch { /* One subscriber must not defeat revocation. */ }
    }
  }

  /** Set a config value by dot-path key and auto-save to disk. */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.invalidateLifetimes();
    if (this.hostSettings.has(key) && this.hostSettingHasProjectValue(key)) {
      (this.setProjectValue as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, value, options);
      return;
    }
    const schema = this.hostSettings.schema(key) ?? CONFIG_SCHEMA.find(s => s.key === key);
    value = coerceSchemaValue(key, schema, value) as ConfigValue<K>;
    if (schema?.validate && !schema.validate(value)) {
      const hint = schema.validationHint ? ` (${schema.validationHint})` : '';
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}${hint}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }
    if (!options.bypassManagedLock) {
      const lock = getManagedSettingLock(key, this.configDir);
      if (lock) {
        throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      }
    }

    const { parent, field } = this.resolvePath(key);
    const previousValue = parent[field]!;
    const previousHost = this.hostSettings.has(key) ? this.hostSettings.snapshot(this.config) : null;
    parent[field] = value;
    // Ownership decides the store. A daemon-owned key persists to the daemon's
    // own settings file, never the surface silo, so the runtime that acts on
    // it reads the value that was just written. Shared keys persist to the
    // surface-root-independent shared tier; everything else stays local.
    const useDaemonTier = this.daemonTierPath !== null && isDaemonOwnedConfigKey(key);
    const useSharedTier = !useDaemonTier && this.sharedTierPath !== null && isSharedConfigKey(key);
    try {
      if (useDaemonTier) {
        persistDaemonKey(this.daemonTierPath!, key, value);
      } else if (useSharedTier) {
        persistSharedKey(this.sharedTierPath!, key, value);
      } else {
        this.persistGlobalKey(key, value);
      }
    } catch (error) {
      parent[field] = previousValue;
      if (previousHost) recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(previousHost, true));
      throw error;
    }
    if (useDaemonTier) this.daemonKeysPresent.add(key);
    if (useSharedTier) this.sharedKeysPresent.add(key);
    if (previousHost) {
      this.refreshHostSettings(previousHost, true);
    } else {
      this.notifyListeners(key, previousValue, value);
      this.emitConfigHook(key, previousValue, value);
    }
  }

  /**
   * Atomically update non-credential daemon settings in their one owned file.
   * Every value and managed lock is checked before persistence. Live values and
   * notifications are published only after the whole file has been replaced.
   * This is not a transaction across config tiers or concurrent processes.
   */
  setDaemonValues(patch: DaemonConfigPatch): void {
    this.requireWritable();
    this.invalidateLifetimes();
    if (!this.daemonTierPath) throw new ConfigError('A daemon settings file is required for this update.');
    const prepared = Object.entries(patch).filter(([, value]) => value !== undefined).map(([rawKey, value]) => {
      const schema = CONFIG_SCHEMA.find((setting) => setting.key === rawKey);
      if (!schema || !isDaemonOwnedConfigKey(rawKey) || isSecretBearingConfigKey(rawKey)) {
        throw new ConfigError('The update contains an unsupported daemon setting.');
      }
      const key = schema.key;
      let next: unknown;
      try {
        next = JSON.parse(JSON.stringify(coerceSchemaValue(key, schema, value)));
        const validType = schema.type === 'enum'
          ? typeof next === 'string' && schema.enumValues?.includes(next)
          : schema.type === 'object'
            ? next !== null && typeof next === 'object'
            : typeof next === schema.type && (schema.type !== 'number' || (typeof next === 'number' && Number.isFinite(next)));
        if (!validType || (schema.validate && !schema.validate(next))) throw new Error('invalid');
      } catch {
        throw new ConfigError(`Invalid value for daemon setting ${key}.`);
      }
      if (getManagedSettingLock(key, this.configDir)) {
        throw new ConfigError(`Setting ${key} is managed and cannot be changed.`);
      }
      const { parent, field } = this.resolvePath(key);
      return { key, next, parent, field, previous: parent[field] };
    });
    if (prepared.length === 0) return;
    try {
      const raw = readDaemonTierFile(this.daemonTierPath);
      for (const { key, next } of prepared) writeRawDotPath(raw, key, next);
      writeJsonFileAtomic(this.daemonTierPath, raw);
    } catch {
      throw new ConfigError('Could not persist daemon settings; the update was not applied.');
    }
    for (const { key, next, parent, field } of prepared) {
      parent[field] = next;
      this.daemonKeysPresent.add(key);
    }
    for (const { key, next, previous } of prepared) {
      this.notifyListeners(key, previous, next);
      this.emitConfigHook(key, previous, next);
    }
  }

  /**
   * Set a single key and persist it to the PROJECT settings overlay (merged
   * into the raw on-disk shape, keeping only explicit keys), leaving the global
   * file untouched, so an approval like fetch.allowLocalhost scopes to this
   * project and survives restarts. Falls back to set() with no project path.
   */
  setProjectValue<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.invalidateLifetimes();
    if (!this.projectConfigPath) {
      (this.set as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, value, options);
      return;
    }
    const schema = this.hostSettings.schema(key) ?? CONFIG_SCHEMA.find(s => s.key === key);
    value = coerceSchemaValue(key, schema, value) as ConfigValue<K>;
    if (schema?.validate && !schema.validate(value)) {
      const hint = schema.validationHint ? ` (${schema.validationHint})` : '';
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}${hint}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }
    if (!options.bypassManagedLock) {
      const lock = getManagedSettingLock(key, this.configDir);
      if (lock) {
        throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      }
    }
    const { parent, field } = this.resolvePath(key);
    const previousValue = parent[field];
    const previousHost = this.hostSettings.has(key) ? this.hostSettings.snapshot(this.config) : null;
    parent[field] = value;
    // Read-merge-write: a file this cannot parse is quarantined (moved aside
    // with a receipt) rather than silently discarded, because the write below
    // would otherwise destroy the only copy of it.
    const raw: Record<string, unknown> = readRawSettingsFile(this.projectConfigPath);
    const segments = key.split('.');
    let cursor: Record<string, unknown> = raw;
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1] as string] = value;
    try {
      writeJsonFileAtomic(this.projectConfigPath, raw);
    } catch (error) {
      parent[field] = previousValue;
      if (previousHost) recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(previousHost, true));
      throw error;
    }
    if (previousHost) {
      this.refreshHostSettings(previousHost, true);
    } else {
      this.notifyListeners(key, previousValue, value);
      this.emitConfigHook(key, previousValue, value);
    }
  }

  /** Subscribe to changes on a config key; returns an unsubscribe function. */
  subscribe<K extends ConfigKey>(key: K, cb: ConfigChangeCallback<K>): ConfigUnsubscribe {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    // Cast via unknown to avoid deeply-recursive ConfigValue<K> comparison that
    // exceeds TypeScript's stack depth on the 100-entry conditional type.
    const wrapped = (newVal: unknown, oldVal: unknown) => (cb as (n: unknown, o: unknown) => void)(newVal, oldVal);
    this._listeners.get(key)?.add(wrapped);
    return () => {
      this._listeners.get(key)?.delete(wrapped);
    };
  }

  /**
   * Watch the on-disk config files (global, project, shared-tier) for EXTERNAL
   * edits and apply them live through the same subscribe() pipeline an
   * in-process set() uses, no restart. Returns a stop function.
   */
  watchConfigFiles(options: { intervalMs?: number } = {}): () => void {
    this.stopWatchingConfigFiles();
    const paths = [this.configPath, this.projectConfigPath, this.sharedTierPath, this.daemonTierPath].filter(
      (p): p is string => typeof p === 'string' && p.length > 0,
    );
    this._fileWatch = watchConfigFiles(paths, () => this.reloadFromDiskAndNotify(), options.intervalMs, this.hostSettings.active);
    return () => this.stopWatchingConfigFiles();
  }

  /** Stop watching all config files opened by watchConfigFiles(). */
  stopWatchingConfigFiles(): void {
    this._fileWatch?.stop();
    this._fileWatch = null;
  }

  /** Re-read config from disk and fire subscribers for every watched key that changed. */
  private reloadFromDiskAndNotify(): void {
    reloadAndNotifyChanges({
      // Registered host leaves notify inside load(), including failed reads.
      listenerKeys: [...this._listeners.keys()].filter((key) => !this.hostSettings.has(key)),
      get: (key) => this.get(key as ConfigKey),
      load: () => this.load(),
      notify: (key, oldValue, newValue) => {
        this.notifyListeners(key as ConfigKey, oldValue, newValue);
        this.emitConfigHook(key as ConfigKey, oldValue, newValue);
      },
    });
  }

  /** Notify synchronous subscribers of a key change. */
  private notifyListeners(key: ConfigKey, oldValue: unknown, newValue: unknown): void {
    const set = this._listeners.get(key);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(newValue, oldValue);
      } catch (error) {
        logger.warn('Config listener failed during setting update', {
          key,
          error: summarizeError(error),
        });
      }
    }
  }

  /** Fire the Change:config hook for a config key change. */
  private emitConfigHook(key: ConfigKey, previousValue: unknown, newValue: unknown): void {
    if (!this.hookDispatcher) return;
    try {
      const event: HookEvent = {
        path: `Change:config:${key}`,
        phase: 'Change',
        category: 'config',
        specific: key,
        sessionId: '',
        timestamp: Date.now(),
        payload: { key, value: newValue, previousValue },
      };
      this.hookDispatcher.fire(event).catch((error: unknown) => {
        logger.warn('[config] Change hook failed', {
          key,
          error: summarizeError(error),
        });
      });
    } catch (error) {
      logger.warn('[config] Change hook dispatch failed', {
        key,
        error: summarizeError(error),
      });
    }
  }

  /**
   * Set a config value from a validated ConfigKey with unknown value type (when
   * iterating schema entries). Runtime validation still applies via set().
   */
  setDynamic(key: ConfigKey, value: unknown, options: ConfigSetOptions = {}): void {
    this.set(key, value as never, options);
  }

  /** Return a deep-readonly snapshot of the full config. Nested objects are immutable. */
  getAll(): DeepReadonly<GoodVibesConfig> {
    return structuredClone(this.config) as DeepReadonly<GoodVibesConfig>;
  }

  /** Return a deep-cloned snapshot of a config category. */
  getCategory<C extends keyof GoodVibesConfig>(category: C): Readonly<GoodVibesConfig[C]> {
    return structuredClone(this.config[category]);
  }

  /** Return a deep-cloned snapshot of the live config (read-only consumers). */
  getRaw(): Readonly<GoodVibesConfig> {
    return structuredClone(this.config) as Readonly<GoodVibesConfig>;
  }

  /** Return the builtin schema; host descriptors are a separate typed surface. */
  getSchema(): ConfigSetting[] {
    return CONFIG_SCHEMA;
  }

  /** Immutable descriptors for the boolean settings registered by this host. */
  getHostSettingsSchema(): readonly HostBooleanSetting[] { return this.hostSettings.definitions; }

  /**
   * Persist a single key to the global settings file by read-merge-write, so
   * hand edits and other keys survive and no default reaches disk unless set.
   */
  private persistGlobalKey(key: ConfigKey, value: unknown): void {
    const raw = readRawSettingsFile(this.configPath);
    writeRawDotPath(raw, key, value);
    this.writeRawGlobal(raw);
  }

  private writeRawGlobal(raw: Record<string, unknown>): void {
    writeJsonFileAtomic(this.configPath, raw);
  }

  /**
   * Persist current config to the global settings file, writing only the keys
   * that differ from the shipped defaults (plus unknown keys), no default is
   * frozen onto disk; resolved config is unchanged on reload.
   */
  save(): void {
    this.requireWritable();
    const { config: minimal } = stripFrozenDefaults(
      structuredClone(this.config) as unknown as Record<string, unknown>,
    );
    this.preserveHostSettingsForBulkSave(minimal, this.configPath);
    this.writeRawGlobal(this.withoutDaemonOwned(minimal));
  }

  /**
   * Drop every daemon-owned key from a whole-config dump. A surface file must
   * never carry a daemon-owned value again, one writer per key means a
   * whole-config save cannot quietly re-seed the duplication the daemon config
   * migration just removed.
   */
  private withoutDaemonOwned(raw: Record<string, unknown>): Record<string, unknown> {
    if (!this.daemonTierPath) return raw;
    for (const key of listDaemonOwnedConfigPaths()) deleteRawDotPath(raw, key);
    return raw;
  }

  /** Persist current config to the project-level surface settings file. */
  saveProject(): void {
    this.requireWritable();
    if (!this.projectConfigPath) {
      throw new Error('ConfigManager.saveProject requires an explicit workingDir.');
    }
    const { config: minimal } = stripFrozenDefaults(
      structuredClone(this.config) as unknown as Record<string, unknown>,
    );
    this.preserveHostSettingsForBulkSave(minimal, this.projectConfigPath);
    writeJsonFileAtomic(this.projectConfigPath, this.withoutDaemonOwned(minimal));
  }

  /**
   * Every setting the last load could not ingest, with the file, the key and
   * the reason, the owner-visible signal behind the startup notice. Empty when
   * every settings file was read whole. See ./settings-ingestion.ts.
   */
  getIngestionQuarantine(): readonly SettingsIngestionNotice[] {
    return this.ingestionNotices;
  }
  /** Once a judgment port is installed: announces unknown keys that read as newer forms of known settings. */
  announceUnknownSettingForms(): Promise<void> { return this.unknownSettingForms.start(this.ingestionSink()); }
  /** Where an ingestion notice is filed; see ./manager-ingestion.ts. */
  private ingestionSink(): IngestionNoticeSink {
    return {
      diagnosticMode: this.diagnosticMode,
      record: (entry) => { this.ingestionNotices.push(entry); },
      receipt: (id, text) => { this.migrationReceipt(id, text); },
      unknown: (file, keys) => { this.unknownSettingForms.keep(file, keys, this.ingestionSink()); },
    };
  }
  private ingest(parsed: Record<string, unknown>, file: string, migrate?: (raw: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
    // Existing ingestion/migration may remove malformed categories in place.
    // Capture the host's restrictive projection first, but commit it only
    // AFTER that same persisted-setting validation gate accepts the layer.
    const nextHost = this.hostLoadValues && (file === this.configPath || file === this.projectConfigPath)
      ? new Map(this.hostLoadValues) : null;
    const malformedHostKeys = nextHost ? this.hostSettings.overlay(nextHost, parsed) : [];
    const ingested = ingestManagerSettings(parsed, file, this.ingestionSink(), migrate, new Set(this.hostSettings.keys()));
    if (nextHost) {
      this.hostLoadValues = nextHost;
      for (const key of malformedHostKeys) {
        const notice: SettingsIngestionNotice = {
          file, key, action: 'skipped', reason: 'Host setting requires a literal boolean or object category',
          remedy: 'Fix the stored value; until then this host setting uses its declared restrictive default',
        };
        announceIngestionNotice(notice);
        this.ingestionNotices.push(notice);
      }
    }
    return ingested;
  }
  private loadFailure(label: string, file: string, err: unknown): ConfigError {
    return toConfigLoadFailure(label, file, err, this.ingestionSink());
  }

  /** Load config from disk: global then project (project wins). Deep-merges with defaults. */
  load(): void {
    this.invalidateLifetimes();
    const previousHost = this.hostSettings.snapshot(this.config);
    this.hostLoadValues = this.hostSettings.active ? this.hostSettings.defaults() : null;
    try {
      this.ingestionNotices = [];
      // Load global settings
      if (this.hostSettings.active ? hostSettingsFileExists(this.configPath) : existsSync(this.configPath)) {
        try {
          const raw = readFileSync(this.configPath, 'utf-8');
          const migrated = this.ingest(
            JSON.parse(raw) as Record<string, unknown>,
            this.configPath,
            (p) => this.applyLoadMigrations(p, this.configPath),
          );

          this.config = sanitizeConfigShape(deepMerge(cloneDefaultConfig(), migrated) as GoodVibesConfig);
        } catch (err) {
          throw this.loadFailure('Global', this.configPath, err);
        }
      }

      // Load project settings and deep-merge on top (project wins)
      if (this.projectConfigPath && (this.hostSettings.active ? hostSettingsFileExists(this.projectConfigPath) : existsSync(this.projectConfigPath))) {
        try {
          const raw = readFileSync(this.projectConfigPath, 'utf-8');
          const migrated = this.ingest(
            JSON.parse(raw) as Record<string, unknown>,
            this.projectConfigPath,
            (p) => this.applyLoadMigrations(p, this.projectConfigPath!),
          );
          this.config = sanitizeConfigShape(deepMerge(this.config, migrated) as GoodVibesConfig);
        } catch (err) {
          throw this.loadFailure('Project', this.projectConfigPath, err);
        }
      }

      // Overlay the shared tier (it wins over the surface silo) for the shared
      // keys only; an absent shared key falls back to the local value.
      this.loadSharedTier();
      // Then the daemon tier, LAST of all: a daemon-owned key's value in the
      // daemon store is the only one that describes what the daemon will do, so
      // no surface-local leftover may shadow it.
      this.loadDaemonTier();
      if (this.hostLoadValues) this.applyHostValues(this.hostLoadValues, previousHost, true);
    } catch (error) {
      this.applyHostValues(this.hostSettings.defaults(), previousHost, true);
      throw error instanceof HostSettingsReadError ? this.loadFailure('Host', error.file, error) : error;
    } finally {
      this.hostLoadValues = null;
    }
  }

  /**
   * Overlay the daemon store's daemon-owned keys onto the resolved config,
   * recording which keys came from there so describeConfigKeySource is honest.
   */
  private loadDaemonTier(): void {
    this.daemonKeysPresent.clear();
    if (!this.daemonTierPath) return;
    try {
      // Daemon-owned keys live ONLY here, so a rename or removal of one is
      // applied here too. DAEMON-OWNED, CLIENT-READ: a non-owner migrates its
      // parsed copy only. Order and ownership live with the passes.
      const stored = this.ingest(
        readDaemonTierFile(this.daemonTierPath),
        this.daemonTierPath,
        (raw) => runDaemonTierMigrationPasses(raw, this.daemonTierPath!,
          (id, text) => this.migrationReceipt(id, text), { ownsFile: this.daemonTierOwner }),
      );
      const applied = overlayDaemonTierFrom(stored, (key, value) => {
        const { parent, field } = resolveOrCreateDaemonPath(this.config as unknown as Record<string, unknown>, key);
        parent[field] = value;
      });
      for (const key of applied) this.daemonKeysPresent.add(key);
    } catch (err) {
      throw this.loadFailure('Daemon', this.daemonTierPath, err);
    }
  }

  /** The daemon store path, or null when no daemon tier is configured. */
  getDaemonTierPath(): string | null {
    return this.daemonTierPath;
  }

  /**
   * Overlay shared-tier values for the shared keys onto the resolved config; a
   * shared key absent from the file is left at its surface-local value. Records
   * which keys were sourced from the shared tier so describeConfigKeySource is
   * honest.
   */
  private loadSharedTier(): void {
    this.sharedKeysPresent.clear();
    if (!this.sharedTierPath) return;
    let shared: Record<string, unknown>;
    try {
      shared = this.ingest(readSharedTierFile(this.sharedTierPath), this.sharedTierPath);
    } catch (err) {
      throw this.loadFailure('Shared', this.sharedTierPath, err);
    }
    for (const key of SHARED_CONFIG_KEYS) {
      const found = readDotPath(shared, key);
      if (!found.present) continue;
      const { parent, field } = this.resolvePath(key);
      parent[field] = found.value;
      this.sharedKeysPresent.add(key);
    }
  }

  /** The shared-tier settings file path, or null when no shared tier is configured. */
  getSharedTierPath(): string | null {
    return this.sharedTierPath;
  }

  /**
   * Report which tier a key's live value resolves from (daemon / shared /
   * project / global / default). Reads the on-disk layers on demand so the
   * resolution order is inspectable, see manager-key-source.ts.
   */
  describeConfigKeySource(key: ConfigKey): ConfigKeySource {
    return describeKeySource({
      key,
      value: this.get(key),
      shareable: isSharedConfigKey(key),
      daemonOwned: isDaemonOwnedConfigKey(key),
      sharedTierPath: this.sharedTierPath,
      daemonTierPath: this.daemonTierPath,
      projectConfigPath: this.projectConfigPath,
      configPath: this.configPath,
      sharedKeysPresent: this.sharedKeysPresent,
      daemonKeysPresent: this.daemonKeysPresent,
    });
  }

  /** Apply the canonical migration order, persisting only for a writable reader. */
  private applyLoadMigrations(parsed: Record<string, unknown>, sourcePath: string): Record<string, unknown> {
    return runLoadMigrationPasses(parsed, sourcePath, (id, text) => this.migrationReceipt(id, text), { ownsFile: !this.readOnly });
  }
  private requireWritable(): void {
    if (this.readOnly) throw new ConfigError('ConfigManager is read-only.');
  }
  /** File a receipt against this config's own announce-once store. */
  private migrationReceipt(id: string, text: string): void {
    if (this.readOnly) return;
    new FeatureAnnouncementStore(featureAnnouncementsPath(this)).record(id, text);
  }

  private applyHostValues(values: HostSettingValues, previous: HostSettingValues, emitHooks = false): void {
    this.hostSettings.apply(this.config, values);
    for (const [key, value] of values) {
      if (previous.get(key) === value) continue;
      this.notifyListeners(key as ConfigKey, previous.get(key), value);
      if (emitHooks) this.emitConfigHook(key as ConfigKey, previous.get(key), value);
    }
  }

  private refreshHostSettings(previous: HostSettingValues, emitHooks = false): void {
    this.ingestionNotices = this.ingestionNotices.filter((notice) => notice.file !== this.configPath && notice.file !== this.projectConfigPath);
    try {
      const values = readHostSettingValues(this.hostSettings, this.configPath, this.projectConfigPath,
        (raw, path) => { this.ingest(raw, path); });
      this.applyHostValues(values, previous, emitHooks);
    } catch (error) {
      this.applyHostValues(this.hostSettings.defaults(), previous, true);
      throw error instanceof HostSettingsReadError ? this.loadFailure('Host', error.file, error) : error;
    }
  }

  private preserveHostSettingsForBulkSave(snapshot: Record<string, unknown>, path: string): void {
    if (!this.hostSettings.active) return;
    try {
      this.hostSettings.preserveDestination(snapshot, readHostSettingsFile(path));
    } catch (error) {
      this.applyHostValues(this.hostSettings.defaults(), this.hostSettings.snapshot(this.config), true);
      throw error;
    }
  }

  private hostSettingHasProjectValue(key: string): boolean {
    try { return this.projectConfigPath !== null && readDotPath(readHostSettingsFile(this.projectConfigPath), key).present; }
    catch (error) {
      recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(this.hostSettings.snapshot(this.config), true));
    }
  }

  private resetHostSetting(key: ConfigKey, value: boolean): void {
    if (this.hostSettingHasProjectValue(key)) this.setProjectValue(key, value as never);
    const lock = getManagedSettingLock(key, this.configDir);
    if (lock) throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
    const previous = this.hostSettings.snapshot(this.config);
    // Reset must revoke the global copy too even when ordinary host set() edits
    // an existing higher-priority project leaf. This is the same owned scalar
    // persistence used by set(), with its read-only and managed-lock guards.
    try { this.persistGlobalKey(key, value); }
    catch (error) { recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(previous, true)); }
    this.refreshHostSettings(previous, true);
  }

  /**
   * Merge a partial patch into a config category and auto-save, the correct
   * way to update array/object fields that cannot be expressed as a scalar
   * dot-path key (e.g. notifications.webhookUrls). Shallow-merged.
   */
  mergeCategory<C extends keyof GoodVibesConfig>(category: C, patch: Partial<GoodVibesConfig[C]>): void {
    this.requireWritable();
    this.invalidateLifetimes();
    if (Object.keys(patch).some((key) => this.hostSettings.has(`${String(category)}.${key}`))) {
      throw new ConfigError('Registered host settings require the guarded scalar set API.');
    }
    persistCategoryPatch(
      String(category),
      patch as Record<string, unknown>,
      this.config[category]! as Record<string, unknown>,
      this.categoryIoDeps(),
    );
  }

  /**
   * Remove a key from an object-shaped category and auto-save. mergeCategory
   * can only set keys, so clearing an override (e.g. a feature-flag entry back
   * to its default) requires this explicit removal.
   */
  removeCategoryKey<C extends keyof GoodVibesConfig>(category: C, key: string): void {
    this.requireWritable();
    this.invalidateLifetimes();
    const hostKey = `${String(category)}.${key}`;
    if (this.hostSettings.has(hostKey)) { this.reset(hostKey as ConfigKey); return; }
    const current = this.config[category]! as Record<string, unknown>;
    if (!(key in current)) return;
    delete current[key];
    persistCategoryKeyRemoval(String(category), key, this.categoryIoDeps());
  }

  private categoryIoDeps(): CategoryIoDeps {
    return {
      configPath: this.configPath,
      daemonTierPath: this.daemonTierPath,
      writeRawGlobal: (raw) => this.writeRawGlobal(raw),
      markDaemonKey: (key, present) => {
        if (present) this.daemonKeysPresent.add(key as ConfigKey);
        else this.daemonKeysPresent.delete(key as ConfigKey);
      },
    };
  }

  /** Reset one key (or all config) to defaults and persist the removal. */
  reset(key?: ConfigKey): void {
    this.requireWritable();
    this.invalidateLifetimes();
    for (const definition of this.hostSettings.definitions) {
      if (key !== undefined && key !== definition.key) continue;
      this.resetHostSetting(definition.key as ConfigKey, definition.default);
      if (key !== undefined) return;
    }
    if (key === undefined) {
      this.config = cloneDefaultConfig();
      this.hostSettings.apply(this.config, this.hostSettings.defaults());
      // A full reset means no explicit keys remain, clear the file to defaults.
      this.writeRawGlobal({});
    } else {
      const schema = this.hostSettings.schema(key) ?? CONFIG_SCHEMA.find(s => s.key === key);
      if (!schema) throw new ConfigError(`Unknown config key: ${key}`);
      const livePath = this.resolvePath(key);
      livePath.parent[livePath.field] = structuredClone(readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value);
      // Remove the explicit on-disk value so the key falls back to its default.
      const raw = readRawSettingsFile(this.configPath);
      deleteRawDotPath(raw, key);
      this.writeRawGlobal(raw);
    }
    // Reset removes the daemon-store value too, else the daemon tier would
    // re-overlay on the next load and defeat the reset.
    if (this.daemonTierPath) {
      for (const daemonKey of clearDaemonTierForReset(this.daemonTierPath, key)) {
        this.daemonKeysPresent.delete(daemonKey);
      }
    }
    // Reset removes the shared-tier OVERRIDE for any shared key, else a stale
    // shared value would re-overlay on the next load and defeat the reset.
    if (this.sharedTierPath) {
      const resetKeys = key === undefined ? SHARED_CONFIG_KEYS : (isSharedConfigKey(key) ? [key] : []);
      for (const sharedKey of resetKeys) {
        removeSharedKey(this.sharedTierPath, sharedKey);
        this.sharedKeysPresent.delete(sharedKey);
      }
    }
  }
}

/** Deep-merge source into target. Returns a new object. Source non-objects are ignored, target clone is returned.
 * Non-object source values will not overwrite object target values (type-safe merge). */
function deepMerge(target: unknown, source: unknown): unknown {
  const result: Record<string, unknown> = isObject(target)
    ? structuredClone(target) as Record<string, unknown>
    : {};
  if (!isObject(source)) return result;
  for (const key of Object.keys(source)) {
    const sv = source[key]!;
    const tv = result[key]!;
    if (isObject(sv) && isObject(tv)) {
      result[key] = deepMerge(tv, sv);
    } else if (sv !== undefined && !isObject(tv)) {
      // Only overwrite non-object target values, never replace an object with a scalar.
      // Clone assigned values so config instances never share mutable references.
      result[key] = structuredClone(sv);
    }
  }
  return result;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}
