import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting } from './schema.js';
import { CONFIG_SCHEMA } from './schema.js';
import { ConfigError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import type { HookDispatcher } from '../hooks/index.js';
import type { HookEvent } from '../hooks/types.js';
import { attachOwnedConfigHook } from './hook-attachment.js';
import { getManagedSettingLock } from '../runtime/settings/control-plane.js';
import { readHostManagedSettingLock, readStrictManagedSettingLock } from '../runtime/settings/host-setting-policy-read.js';
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
  readRawSettingsFile,
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
import { ConfigRuntimeState, captureRuntimeValue } from './manager-runtime-state.js';
import { announceIngestionNotice } from './settings-ingestion.js';
import { freezePreparedData, normalizePreparedValue, preparedSchemaSignature, type PreparedMutationRecord,
  type PreparedConfigMutation, type PreparedConfigMutationTransition, type PreparedConfigMutationRequest,
  type PreparedConfigMutationFacts, type PreparedConfigMutationDestination,
  type PreparedConfigMutationTransitionFacts, type PreparedConfigMutationReceipt } from './prepared-mutation.js';
export type { PreparedConfigMutation, PreparedConfigMutationTransition, PreparedConfigMutationRequest,
  PreparedConfigMutationFacts, PreparedConfigMutationDestination, PreparedConfigMutationTransitionFacts,
  PreparedConfigMutationReceipt } from './prepared-mutation.js';

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
  /** Read without filesystem effects; persistent mutators refuse, runtime inputs are allowed. */
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
 * Load order: shipped defaults < frontend defaults < global < project < shared < daemon < invocation overrides
 * API keys are never persisted, loaded from env vars only.
 */
export class ConfigManager {
  private readonly readOnly: boolean;
  private readonly diagnosticMode: 'default' | 'structural';
  private readonly hostSettings: HostSettings;
  private hostLoadValues: HostSettingValues | null = null;
  private hostLoadSources: Map<string, Record<string, unknown>> | null = null;
  /** Host defaults projected by malformed/unreadable input, independently of accepted underlay tiers. */
  private hostDefaultOrigins = new Set<string>();
  private config: GoodVibesConfig;
  private runtimeState: ConfigRuntimeState;
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
  // Private identities contain no authority grant and cannot be copied or forged.
  readonly #preparedMutations = new WeakMap<PreparedConfigMutation, PreparedMutationRecord>();
  readonly #preparedTransitions = new WeakMap<PreparedConfigMutationTransition, PreparedConfigMutation>();
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
    this.runtimeState = new ConfigRuntimeState(structuredClone(this.config));

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
      this.setRuntimeOverride('provider.model', overrides.model);
    }
    if (overrides.autoApprove !== undefined) {
      this.setRuntimeOverride('behavior.autoApprove', overrides.autoApprove);
    }
    if (overrides.systemPromptFile !== undefined) {
      this.setRuntimeOverride('provider.systemPromptFile', overrides.systemPromptFile);
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
    config: GoodVibesConfig = this.config,
  ): { parent: Record<string, unknown>; field: string } {
    const parts = key.split('.');
    let cursor: unknown = config;

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
    return detachedConfigValue(resolveWithProfileFallback(key, parent[field], this.profileFallback)) as ConfigValue<K>;
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

  /**
   * Capture an exact, detached mutation on this owner. This is not admission:
   * callers must authenticate their execution separately before begin/finish.
   * Preparation never recovers, quarantines, cleans up, or writes a store.
   */
  prepareSettingMutation(request: PreparedConfigMutationRequest): PreparedConfigMutation {
    this.requireWritable();
    const incarnation = this.permissionIncarnation;
    if (request.operation !== 'set' && request.operation !== 'reset') throw new ConfigError('Unsupported prepared operation.');
    const { schema, identity } = this.preparedSchema(request.key);
    const signature = preparedSchemaSignature(schema);
    const validator = schema.validate;
    const requested = request.operation === 'set' ? request.value
      : this.hostSettings.has(request.key) ? schema.default : readDotPath(DEFAULT_CONFIG_SNAPSHOT, request.key).value;
    const value = normalizePreparedValue(request.key, schema, requested);
    const destinations = this.preparedDestinations(request.operation, request.key);
    for (const destination of destinations) readHostSettingsFile(destination.path);
    const handle = Object.freeze({}) as PreparedConfigMutation;
    const record: PreparedMutationRecord = {
      facts: freezePreparedData({ operation: request.operation, key: request.key, value, destinations, incarnation }),
      schemaIdentity: identity, schemaSignature: signature, validator,
      normalizedJson: JSON.stringify(value), phase: 'prepared',
    };
    this.#preparedMutations.set(handle, record);
    try { this.assertPreparedCurrent(record, incarnation); }
    catch (error) { record.phase = 'spent'; throw error; }
    return handle;
  }

  /** Detached proposed values are private substrate data, not redacted evidence. */
  inspectPreparedMutation(handle: PreparedConfigMutation): PreparedConfigMutationFacts {
    return freezePreparedData(structuredClone(this.preparedRecord(handle).facts));
  }

  assertPreparedMutation(handle: PreparedConfigMutation): void {
    const record = this.preparedRecord(handle);
    if (record.phase !== 'prepared') throw new ConfigError('Prepared mutation is not available.');
    this.assertPreparedCurrent(record, record.facts.incarnation);
  }

  /** Run all reentrant work before exposing the one exact owner transition. */
  beginPreparedMutation(handle: PreparedConfigMutation): PreparedConfigMutationTransition {
    const record = this.preparedRecord(handle);
    if (record.phase !== 'prepared') throw new ConfigError('Prepared mutation is not available.');
    record.phase = 'beginning';
    try {
      this.assertPreparedCurrent(record, record.facts.incarnation);
      this.invalidateLifetimes();
      this.assertPreparedCurrent(record, record.facts.incarnation + 1);
      const { schema } = this.preparedSchema(record.facts.key);
      // Validate again after invalidation subscribers, using a detached copy.
      const next = normalizePreparedValue(record.facts.key, schema, record.facts.value);
      if (JSON.stringify(next) !== record.normalizedJson) throw new ConfigError('Prepared value changed.');
      this.assertPreparedCurrent(record, record.facts.incarnation + 1);
      for (const destination of record.facts.destinations) readHostSettingsFile(destination.path);
      this.assertPreparedCurrent(record, record.facts.incarnation + 1);
      const transition = Object.freeze({}) as PreparedConfigMutationTransition;
      record.phase = 'begun'; record.transition = transition;
      this.#preparedTransitions.set(transition, handle);
      return transition;
    } catch (error) { record.phase = 'spent'; throw error; }
  }

  inspectPreparedMutationTransition(handle: PreparedConfigMutation, transition: PreparedConfigMutationTransition): PreparedConfigMutationTransitionFacts {
    this.assertPreparedMutationTransition(handle, transition);
    const record = this.preparedRecord(handle);
    return Object.freeze({ beforeIncarnation: record.facts.incarnation, afterIncarnation: record.facts.incarnation + 1 });
  }

  assertPreparedMutationTransition(handle: PreparedConfigMutation, transition: PreparedConfigMutationTransition): void {
    const record = this.preparedRecord(handle);
    if (record.phase !== 'begun' || record.transition !== transition || this.#preparedTransitions.get(transition) !== handle) {
      throw new ConfigError('Prepared mutation transition is not authentic or has been spent.');
    }
    this.assertPreparedCurrent(record, record.facts.incarnation + 1);
  }

  /**
   * After the caller's final authority check, commit synchronously with no
   * validator, invalidation subscriber or notification in the publication tail.
   * Existing whole-file last-writer-wins semantics remain; this is not file CAS.
   */
  finishPreparedMutation(handle: PreparedConfigMutation, transition: PreparedConfigMutationTransition): PreparedConfigMutationReceipt {
    const record = this.preparedRecord(handle);
    // A forged transition cannot consume a different authentic operation.
    if (record.transition !== transition || this.#preparedTransitions.get(transition) !== handle) {
      throw new ConfigError('Prepared mutation transition is not authentic.');
    }
    let stores: Map<string, Record<string, unknown>>;
    try {
      this.assertPreparedMutationTransition(handle, transition);
      stores = new Map(record.facts.destinations.map(destination => [destination.path, readHostSettingsFile(destination.path)]));
      // A host mutation also preserves the current effective project/global
      // resolution, without running ingestion announcements or recovery hooks.
      if (this.hostSettings.has(record.facts.key)) {
        for (const path of [this.configPath, this.projectConfigPath]) {
          if (path && !stores.has(path)) stores.set(path, readHostSettingsFile(path));
        }
      }
      this.assertPreparedMutationTransition(handle, transition);
    } catch (error) { record.phase = 'spent'; throw error; }
    record.phase = 'spent';
    const { key, value, destinations } = record.facts;
    const previousValue = this.resolvePath(key).parent[this.resolvePath(key).field];
    const previousHost = this.hostSettings.has(key) ? this.hostSettings.snapshot(this.config) : null;
    // Pure detached staging: never run validators, invalidation callbacks, or
    // runtime admission in the sealed publication tail. Unknown/no-write
    // receipts retain this owner's previous runtime authority.
    const staged = this.runtimeState.fork();
    writeRawDotPath(staged.nonRuntime as unknown as Record<string, unknown>, key, structuredClone(value));
    staged.retire(key);
    staged.mark(key, record.facts.operation === 'set' ? destinations[0]!.tier : undefined);
    const effective = staged.compose();
    const completedPaths: string[] = [];
    let uncertainPath: string | undefined;
    for (const destination of destinations) {
      const raw = stores.get(destination.path)!;
      const candidate = structuredClone(raw);
      const removed = destination.operation === 'remove' ? deleteRawDotPath(candidate, key) : false;
      if (destination.operation === 'set') writeRawDotPath(candidate, key, structuredClone(value));
      // Legacy local reset always rewrites global; tier reset skips absent keys.
      if (destination.operation === 'remove' && !removed && destination.tier !== 'global') {
        if (destination.tier === 'daemon') this.daemonKeysPresent.delete(key);
        if (destination.tier === 'shared') this.sharedKeysPresent.delete(key);
        continue;
      }
      try {
        writeJsonFileAtomic(destination.path, candidate, { cleanupStaleTemps: false });
        stores.set(destination.path, candidate);
        completedPaths.push(destination.path);
        if (destination.tier === 'daemon') {
          if (destination.operation === 'set') this.daemonKeysPresent.add(key);
          else this.daemonKeysPresent.delete(key);
        }
        if (destination.tier === 'shared') {
          if (destination.operation === 'set') this.sharedKeysPresent.add(key);
          else this.sharedKeysPresent.delete(key);
        }
      } catch { uncertainPath = destination.path; break; }
    }
    // Record the actual effect BEFORE any user callback. A later subscriber
    // failure, cancellation or supersession cannot rewrite this receipt.
    const receipt: PreparedConfigMutationReceipt = freezePreparedData({
      status: uncertainPath === undefined ? 'committed' : completedPaths.length > 0 ? 'partial' : 'unknown',
      completedPaths, ...(uncertainPath === undefined ? {} : { uncertainPath }),
    });
    if (receipt.status === 'committed' || completedPaths.length > 0) {
      if (previousHost) {
        const values = this.hostSettings.defaults();
        this.hostSettings.overlay(values, stores.get(this.configPath)!);
        if (this.projectConfigPath) this.hostSettings.overlay(values, stores.get(this.projectConfigPath)!);
        this.hostSettings.apply(staged.nonRuntime, values);
        const hostDefaultOrigins = this.updateHostSources(staged, stores);
        this.publishState(staged, staged.compose());
        // No callback may escape after persistence, including logging failures.
        try { this.applyHostValues(values, previousHost, true, hostDefaultOrigins); } catch { /* Receipt remains truthful. */ }
      } else {
        this.publishState(staged, effective);
        try {
          this.notifyPersistedChange(key, previousValue);
        } catch { /* Publication already completed; never report a false refusal. */ }
      }
    }
    return receipt;
  }

  private preparedRecord(handle: PreparedConfigMutation): PreparedMutationRecord {
    const record = this.#preparedMutations.get(handle);
    if (!record || record.phase === 'spent') throw new ConfigError('Prepared mutation is not authentic or has been spent.');
    return record;
  }

  private preparedSchema(key: ConfigKey): { schema: Omit<ConfigSetting, 'key'>; identity: object } {
    const host = this.hostSettings.definitions.find(definition => definition.key === key);
    if (host) return { schema: this.hostSettings.schema(key)!, identity: host };
    const schema = CONFIG_SCHEMA.find(entry => entry.key === key);
    if (!schema) throw new ConfigError('Unknown prepared setting key.');
    this.resolvePath(key);
    return { schema, identity: schema };
  }

  private preparedDestinations(operation: 'set' | 'reset', key: ConfigKey): PreparedConfigMutationDestination[] {
    const destination = (path: string, tier: PreparedConfigMutationDestination['tier'], effect: 'set' | 'remove'): PreparedConfigMutationDestination => ({ path, tier, operation: effect });
    if (this.hostSettings.has(key)) {
      const project = this.projectConfigPath !== null && readDotPath(readHostSettingsFile(this.projectConfigPath), key).present;
      if (operation === 'set') return [destination(project ? this.projectConfigPath! : this.configPath, project ? 'project' : 'global', 'set')];
      return [...(project ? [destination(this.projectConfigPath!, 'project', 'set')] : []), destination(this.configPath, 'global', 'set')];
    }
    if (operation === 'set') {
      if (this.daemonTierPath && isDaemonOwnedConfigKey(key)) return [destination(this.daemonTierPath, 'daemon', 'set')];
      if (this.sharedTierPath && isSharedConfigKey(key)) return [destination(this.sharedTierPath, 'shared', 'set')];
      return [destination(this.configPath, 'global', 'set')];
    }
    return [destination(this.configPath, 'global', 'remove'),
      ...(this.daemonTierPath && isDaemonOwnedConfigKey(key) ? [destination(this.daemonTierPath, 'daemon', 'remove')] : []),
      ...(this.sharedTierPath && isSharedConfigKey(key) ? [destination(this.sharedTierPath, 'shared', 'remove')] : [])];
  }

  private assertPreparedCurrent(record: PreparedMutationRecord, incarnation: number): void {
    this.requireWritable();
    const { key, operation } = record.facts;
    const { schema, identity } = this.preparedSchema(key);
    // Host validators are freshly allocated by the legacy accessor; the frozen
    // per-instance host descriptor is their stable identity.
    if (identity !== record.schemaIdentity || preparedSchemaSignature(schema) !== record.schemaSignature
      || (!this.hostSettings.has(key) && schema.validate !== record.validator)) throw new ConfigError('Prepared setting schema changed.');
    if (JSON.stringify(this.preparedDestinations(operation, key)) !== JSON.stringify(record.facts.destinations)) {
      throw new ConfigError('Prepared setting destination changed.');
    }
    if (readHostManagedSettingLock(key, this.configDir)) throw new ConfigError('Prepared setting is managed and cannot be changed.');
    if (this.permissionIncarnation !== incarnation) throw new ConfigError('Prepared setting owner changed.');
  }

  /**
   * Register an invocation-only value without filesystem effects, even on a
   * read-only manager. Survives loads until an explicit mutation supersedes it.
   * Managed policy is checked on admission; standalone lock changes do not
   * reconcile existing invocation authority.
   */
  setRuntimeOverride<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    this.setRuntimeInput(key, value, false);
  }

  /** Register a frontend default below every accepted persisted value and invocation override. */
  setRuntimeDefault<K extends ConfigKey>(key: K, value: ConfigValue<K>): void {
    this.setRuntimeInput(key, value, true);
  }

  private setRuntimeInput(key: ConfigKey, value: unknown, isDefault: boolean): void {
    this.invalidateLifetimes();
    const owned = captureRuntimeValue(key, value);
    if (readStrictManagedSettingLock(key, this.configDir)) {
      throw new ConfigError(`Setting ${key} is managed and cannot be changed.`);
    }
    const previous = readDotPath(this.config, key).value;
    const staged = this.runtimeState.fork();
    (isDefault ? staged.defaults : staged.overrides).set(key, owned);
    const effective = staged.compose();
    this.runtimeState = staged;
    this.config = effective;
    const next = readDotPath(effective, key).value;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.notifyListeners(key, previous, next);
      this.emitConfigHook(key, previous, next);
    }
  }

  /** Publish every part of a staged mutation before any observer can run. */
  private publishState(staged: ConfigRuntimeState, effective: GoodVibesConfig): void {
    this.runtimeState = staged;
    this.config = effective;
    this.sharedKeysPresent.clear();
    this.daemonKeysPresent.clear();
    for (const [key, tier] of staged.sources) {
      if (tier === 'shared') this.sharedKeysPresent.add(key as ConfigKey);
      if (tier === 'daemon') this.daemonKeysPresent.add(key as DaemonOwnedConfigPath);
    }
  }

  private notifyPersistedChange(key: ConfigKey, previous: unknown): void {
    const next = readDotPath(this.config, key).value;
    // Preserve legacy explicit-write notifications, including same-value writes.
    this.notifyListeners(key, previous, next);
    this.emitConfigHook(key, previous, next);
  }

  /**
   * Non-mutating preflight using the ordinary dynamic setter's schema, path,
   * managed-policy, and read-only checks. Does not grant future admission or
   * promise persistence; callers must still commit through setDynamic().
   * Policy reads are strict and never repair or quarantine a file.
   */
  validateDynamic(key: ConfigKey, value: unknown, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.validateSetValue(key, value, options, true);
  }

  private validateSetValue(key: ConfigKey, value: unknown, options: ConfigSetOptions, purePolicyRead: boolean): unknown {
    const schema = this.hostSettings.schema(key) ?? CONFIG_SCHEMA.find(s => s.key === key);
    value = coerceSchemaValue(key, schema, value);
    if (schema?.validate && !schema.validate(value)) {
      const hint = schema.validationHint ? ` (${schema.validationHint})` : '';
      throw new ConfigError(`Invalid value for ${key}: ${String(value)}${hint}`);
    }
    if (schema?.type === 'enum' && schema.enumValues && !schema.enumValues.includes(value as string)) {
      throw new ConfigError(`Invalid value for ${key}: "${String(value)}". Allowed: ${schema.enumValues.join(', ')}`);
    }
    if (!options.bypassManagedLock) {
      const lock = purePolicyRead ? readStrictManagedSettingLock(key, this.configDir) : getManagedSettingLock(key, this.configDir);
      if (lock) {
        throw new ConfigError(`Setting ${key} is locked by ${lock.source}: ${lock.reason}`);
      }
    }

    this.resolvePath(key);
    return value;
  }

  /** Set a config value by dot-path key and auto-save to disk. */
  set<K extends ConfigKey>(key: K, value: ConfigValue<K>, options: ConfigSetOptions = {}): void {
    this.requireWritable();
    this.invalidateLifetimes();
    if (this.hostSettings.has(key) && this.hostSettingHasProjectValue(key)) {
      (this.setProjectValue as (k: ConfigKey, v: unknown, o: ConfigSetOptions) => void)(key, value, options);
      return;
    }
    value = this.validateSetValue(key, value, options, false) as ConfigValue<K>;

    const previousValue = readDotPath(this.config, key).value;
    const previousHost = this.hostSettings.has(key) ? this.hostSettings.snapshot(this.config) : null;
    const staged = this.runtimeState.fork();
    const { parent, field } = this.resolvePath(key, staged.nonRuntime);
    parent[field] = structuredClone(value);
    const useDaemonTier = this.daemonTierPath !== null && isDaemonOwnedConfigKey(key);
    const useSharedTier = !useDaemonTier && this.sharedTierPath !== null && isSharedConfigKey(key);
    staged.retire(key);
    staged.mark(key, useDaemonTier ? 'daemon' : useSharedTier ? 'shared' : 'global');
    const effective = staged.compose();
    try {
      if (useDaemonTier) persistDaemonKey(this.daemonTierPath!, key, parent[field]);
      else if (useSharedTier) persistSharedKey(this.sharedTierPath!, key, parent[field]);
      else this.persistGlobalKey(key, parent[field]);
    } catch (error) {
      if (previousHost) recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(previousHost, true));
      throw error;
    }
    this.publishState(staged, effective);
    if (previousHost) this.refreshHostSettings(previousHost, true);
    else this.notifyPersistedChange(key, previousValue);
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
      return { key, next, previous: readDotPath(this.config, key).value };
    });
    if (prepared.length === 0) return;
    const staged = this.runtimeState.fork();
    for (const { key, next } of prepared) {
      writeRawDotPath(staged.nonRuntime as unknown as Record<string, unknown>, key, structuredClone(next));
      staged.retire(key);
      staged.mark(key, 'daemon');
    }
    const effective = staged.compose();
    try {
      const raw = readDaemonTierFile(this.daemonTierPath);
      for (const { key, next } of prepared) writeRawDotPath(raw, key, next);
      writeJsonFileAtomic(this.daemonTierPath, raw);
    } catch {
      throw new ConfigError('Could not persist daemon settings; the update was not applied.');
    }
    this.publishState(staged, effective);
    for (const { key, previous } of prepared) this.notifyPersistedChange(key, previous);
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
    value = this.validateSetValue(key, value, options, false) as ConfigValue<K>;
    const previousValue = readDotPath(this.config, key).value;
    const previousHost = this.hostSettings.has(key) ? this.hostSettings.snapshot(this.config) : null;
    const staged = this.runtimeState.fork();
    const { parent, field } = this.resolvePath(key, staged.nonRuntime);
    parent[field] = structuredClone(value);
    staged.retire(key);
    staged.mark(key, 'project');
    const effective = staged.compose();
    // Raw-file preparation is inside the same refusal boundary as the write.
    try {
      const raw = readRawSettingsFile(this.projectConfigPath);
      writeRawDotPath(raw, key, parent[field]);
      writeJsonFileAtomic(this.projectConfigPath, raw);
    } catch (error) {
      if (previousHost) recoverHostSettingsWriteFailure(error, () => this.refreshHostSettings(previousHost, true));
      throw error;
    }
    this.publishState(staged, effective);
    if (previousHost) this.refreshHostSettings(previousHost, true);
    else this.notifyPersistedChange(key, previousValue);
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
        cb(detachedConfigValue(newValue), detachedConfigValue(oldValue));
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
        payload: { key, value: detachedConfigValue(newValue), previousValue: detachedConfigValue(previousValue) },
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
   * Persist the non-runtime working view, excluding invocation inputs and
   * frontend defaults. Preserve explicit values that suppress a registered
   * frontend default; runtime authority is neither persisted nor retired.
   */
  save(): void {
    this.requireWritable();
    this.permissionIncarnation++;
    const minimal = this.runtimeState.bulkSnapshot();
    this.preserveHostSettingsForBulkSave(minimal, this.configPath);
    const staged = this.runtimeState.fork();
    staged.acceptBulkSnapshot(this.withoutDaemonOwned(minimal), 'global', this.hostSettings.keys());
    const effective = staged.compose();
    this.writeRawGlobal(minimal);
    this.publishState(staged, effective);
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

  /** Persist the non-runtime working view to project settings. Runtime maps survive. */
  saveProject(): void {
    this.requireWritable();
    this.permissionIncarnation++;
    if (!this.projectConfigPath) {
      throw new Error('ConfigManager.saveProject requires an explicit workingDir.');
    }
    const minimal = this.runtimeState.bulkSnapshot();
    this.preserveHostSettingsForBulkSave(minimal, this.projectConfigPath);
    const staged = this.runtimeState.fork();
    staged.acceptBulkSnapshot(this.withoutDaemonOwned(minimal), 'project', this.hostSettings.keys());
    const effective = staged.compose();
    writeJsonFileAtomic(this.projectConfigPath, minimal);
    this.publishState(staged, effective);
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
    const hostSource = nextHost ? structuredClone(parsed) : null;
    const malformedHostKeys = nextHost ? this.hostSettings.overlay(nextHost, parsed) : [];
    const ingested = ingestManagerSettings(parsed, file, this.ingestionSink(), migrate, new Set(this.hostSettings.keys()));
    if (nextHost) {
      this.hostLoadValues = nextHost;
      if (hostSource) this.hostLoadSources?.set(file, hostSource);
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

  /** Reconstruct accepted non-runtime layers from fresh defaults, then compose active runtime inputs. */
  load(): void {
    this.invalidateLifetimes();
    const previousHost = this.hostSettings.snapshot(this.config);
    const staged = this.runtimeState.fork();
    staged.nonRuntime = cloneDefaultConfig();
    staged.sources.clear();
    staged.globalLayer = {};
    this.hostLoadValues = this.hostSettings.active ? this.hostSettings.defaults() : null;
    this.hostLoadSources = this.hostSettings.active ? new Map() : null;
    try {
      this.ingestionNotices = [];
      if (this.hostSettings.active ? hostSettingsFileExists(this.configPath) : existsSync(this.configPath)) {
        try {
          const migrated = this.ingest(JSON.parse(readFileSync(this.configPath, 'utf-8')) as Record<string, unknown>,
            this.configPath, parsed => this.applyLoadMigrations(parsed, this.configPath));
          staged.nonRuntime = sanitizeConfigShape(deepMerge(staged.nonRuntime, migrated) as GoodVibesConfig);
          staged.recordLayer(migrated, 'global');
        } catch (error) { throw this.loadFailure('Global', this.configPath, error); }
      }
      if (this.projectConfigPath && (this.hostSettings.active ? hostSettingsFileExists(this.projectConfigPath) : existsSync(this.projectConfigPath))) {
        try {
          const migrated = this.ingest(JSON.parse(readFileSync(this.projectConfigPath, 'utf-8')) as Record<string, unknown>,
            this.projectConfigPath, parsed => this.applyLoadMigrations(parsed, this.projectConfigPath!));
          staged.nonRuntime = sanitizeConfigShape(deepMerge(staged.nonRuntime, migrated) as GoodVibesConfig);
          staged.recordLayer(migrated, 'project');
        } catch (error) { throw this.loadFailure('Project', this.projectConfigPath, error); }
      }
      this.loadSharedTier(staged);
      this.loadDaemonTier(staged);
      if (this.hostLoadValues) this.hostSettings.apply(staged.nonRuntime, this.hostLoadValues);
      const hostDefaultOrigins = this.hostLoadSources ? this.updateHostSources(staged, this.hostLoadSources) : new Set<string>();
      const effective = staged.compose();
      this.publishState(staged, effective);
      if (this.hostLoadValues) this.applyHostValues(this.hostLoadValues, previousHost, true, hostDefaultOrigins);
    } catch (error) {
      // Candidate values, invocation maps, and accepted origins were never
      // published. Keep diagnostic/incarnation changes; host permission leaves
      // alone project restrictive defaults into both live and non-runtime state.
      this.applyHostValues(this.hostSettings.defaults(), previousHost, true, new Set(this.hostSettings.keys()));
      throw error instanceof HostSettingsReadError ? this.loadFailure('Host', error.file, error) : error;
    } finally { this.hostLoadValues = null; this.hostLoadSources = null; }
  }

  /** Overlay only daemon-owned keys into the local candidate. */
  private loadDaemonTier(staged: ConfigRuntimeState): void {
    if (!this.daemonTierPath) return;
    try {
      const stored = this.ingest(readDaemonTierFile(this.daemonTierPath), this.daemonTierPath,
        raw => runDaemonTierMigrationPasses(raw, this.daemonTierPath!,
          (id, text) => this.migrationReceipt(id, text), { ownsFile: this.daemonTierOwner }));
      const applied = overlayDaemonTierFrom(stored, (key, value) => {
        const { parent, field } = resolveOrCreateDaemonPath(staged.nonRuntime as unknown as Record<string, unknown>, key);
        parent[field] = value;
      });
      for (const key of applied) staged.sources.set(key, 'daemon');
    } catch (error) { throw this.loadFailure('Daemon', this.daemonTierPath, error); }
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
  private loadSharedTier(staged: ConfigRuntimeState): void {
    if (!this.sharedTierPath) return;
    let shared: Record<string, unknown>;
    try { shared = this.ingest(readSharedTierFile(this.sharedTierPath), this.sharedTierPath); }
    catch (error) { throw this.loadFailure('Shared', this.sharedTierPath, error); }
    for (const key of SHARED_CONFIG_KEYS) {
      const found = readDotPath(shared, key);
      if (!found.present) continue;
      const { parent, field } = this.resolvePath(key, staged.nonRuntime);
      parent[field] = found.value;
      staged.sources.set(key, 'shared');
    }
  }

  /** The shared-tier settings file path, or null when no shared tier is configured. */
  getSharedTierPath(): string | null {
    return this.sharedTierPath;
  }

  /**
   * Report the accepted/post-write underlay tier and the effective origin.
   * Runtime provenance never rereads disk or reveals invocation history.
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
      acceptedTier: this.runtimeState.sources.get(key) ?? 'default',
      effectiveOrigin: this.hostDefaultOrigins.has(key) ? 'default'
        : this.runtimeState.overrides.has(key) ? 'runtime'
        : this.runtimeState.defaults.has(key) && !this.runtimeState.sources.has(key) ? 'runtime-default'
        : this.runtimeState.sources.get(key) ?? 'default',
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

  /** Derive host provenance from the same accepted raw layers that produced its values. */
  private updateHostSources(staged: ConfigRuntimeState, stores: ReadonlyMap<string, Record<string, unknown>>): Set<string> {
    const defaultOrigins = new Set<string>();
    for (const key of this.hostSettings.keys()) staged.mark(key);
    for (const [path, tier] of [[this.configPath, 'global'], [this.projectConfigPath, 'project']] as const) {
      const raw = path ? stores.get(path) : undefined;
      if (!raw) continue;
      for (const key of this.hostSettings.overlay(this.hostSettings.defaults(), raw)) defaultOrigins.add(key);
      for (const key of this.hostSettings.keys()) {
        const found = readDotPath(raw, key);
        if (!found.present) continue;
        staged.mark(key, tier);
        if (typeof found.value === 'boolean') defaultOrigins.delete(key);
      }
    }
    return defaultOrigins;
  }

  private applyHostValues(values: HostSettingValues, previous: HostSettingValues, emitHooks = false,
    defaultOrigins: ReadonlySet<string> = new Set()): void {
    this.hostDefaultOrigins = new Set(defaultOrigins);
    this.hostSettings.apply(this.config, values);
    this.hostSettings.apply(this.runtimeState.nonRuntime, values);
    for (const [key, value] of values) {
      if (previous.get(key) === value) continue;
      this.notifyListeners(key as ConfigKey, previous.get(key), value);
      if (emitHooks) this.emitConfigHook(key as ConfigKey, previous.get(key), value);
    }
  }

  private refreshHostSettings(previous: HostSettingValues, emitHooks = false): void {
    this.ingestionNotices = this.ingestionNotices.filter((notice) => notice.file !== this.configPath && notice.file !== this.projectConfigPath);
    try {
      const stores = new Map<string, Record<string, unknown>>();
      const values = readHostSettingValues(this.hostSettings, this.configPath, this.projectConfigPath,
        (raw, path) => { const captured = structuredClone(raw); this.ingest(raw, path); stores.set(path, captured); });
      const staged = this.runtimeState.fork();
      this.hostSettings.apply(staged.nonRuntime, values);
      const hostDefaultOrigins = this.updateHostSources(staged, stores);
      this.publishState(staged, staged.compose());
      this.applyHostValues(values, previous, emitHooks, hostDefaultOrigins);
    } catch (error) {
      this.applyHostValues(this.hostSettings.defaults(), previous, true, new Set(this.hostSettings.keys()));
      throw error instanceof HostSettingsReadError ? this.loadFailure('Host', error.file, error) : error;
    }
  }

  private preserveHostSettingsForBulkSave(snapshot: Record<string, unknown>, path: string): void {
    if (!this.hostSettings.active) return;
    try {
      this.hostSettings.preserveDestination(snapshot, readHostSettingsFile(path));
    } catch (error) {
      this.applyHostValues(this.hostSettings.defaults(), this.hostSettings.snapshot(this.config), true, new Set(this.hostSettings.keys()));
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
    const ownedPatch = structuredClone(patch) as Record<string, unknown>;
    const staged = this.runtimeState.fork();
    const current = staged.nonRuntime[category] as Record<string, unknown>;
    for (const [field, value] of Object.entries(ownedPatch)) {
      if (value === undefined) continue;
      const path = `${String(category)}.${field}`;
      current[field] = value;
      staged.retire(path);
      staged.mark(path, this.daemonTierPath && isDaemonOwnedConfigKey(path) ? 'daemon' : 'global');
    }
    const effective = staged.compose();
    persistCategoryPatch(String(category), ownedPatch, current, this.categoryIoDeps(staged));
    this.publishState(staged, effective);
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
    const staged = this.runtimeState.fork();
    const current = staged.nonRuntime[category] as Record<string, unknown>;
    if (!(key in current) && ![...staged.overrides.keys()].some(entry => entry === hostKey || entry.startsWith(`${hostKey}.`))) return;
    delete current[key];
    staged.retire(hostKey);
    staged.mark(hostKey);
    const effective = staged.compose();
    persistCategoryKeyRemoval(String(category), key, this.categoryIoDeps(staged));
    this.publishState(staged, effective);
  }

  private categoryIoDeps(staged: ConfigRuntimeState): CategoryIoDeps {
    return {
      configPath: this.configPath,
      daemonTierPath: this.daemonTierPath,
      writeRawGlobal: (raw) => this.writeRawGlobal(raw),
      markDaemonKey: (key, present) => { staged.mark(key, present ? 'daemon' : undefined); },
    };
  }

  /** Remove explicit preferences; full reset retains this frontend's defaults. Cross-tier disk writes are not transactional. */
  reset(key?: ConfigKey): void {
    this.requireWritable();
    this.invalidateLifetimes();
    for (const definition of this.hostSettings.definitions) {
      if (key !== undefined && key !== definition.key) continue;
      this.resetHostSetting(definition.key as ConfigKey, definition.default);
      if (key !== undefined) return;
    }
    const staged = this.runtimeState.fork();
    staged.retire(key);
    if (key === undefined) {
      staged.nonRuntime = cloneDefaultConfig();
      this.hostSettings.apply(staged.nonRuntime, this.hostSettings.defaults());
      staged.sources.clear();
      staged.globalLayer = {};
      for (const hostKey of this.hostSettings.keys()) {
        if (this.runtimeState.sources.get(hostKey) === 'project') staged.sources.set(hostKey, 'project');
      }
    } else {
      const schema = CONFIG_SCHEMA.find(setting => setting.key === key);
      if (!schema) throw new ConfigError(`Unknown config key: ${key}`);
      const path = this.resolvePath(key, staged.nonRuntime);
      path.parent[path.field] = structuredClone(readDotPath(DEFAULT_CONFIG_SNAPSHOT, key).value);
      staged.mark(key);
    }
    const effective = staged.compose();
    if (key === undefined) this.writeRawGlobal({});
    else {
      const raw = readRawSettingsFile(this.configPath);
      deleteRawDotPath(raw, key);
      this.writeRawGlobal(raw);
    }
    if (this.daemonTierPath) clearDaemonTierForReset(this.daemonTierPath, key);
    if (this.sharedTierPath) {
      const resetKeys = key === undefined ? SHARED_CONFIG_KEYS : (isSharedConfigKey(key) ? [key] : []);
      for (const sharedKey of resetKeys) removeSharedKey(this.sharedTierPath, sharedKey);
    }
    // Earlier files can have been replaced if a later write throws. Preserve
    // the complete live state; the next accepted load reconciles those bytes.
    this.publishState(staged, effective);
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

/** Caller-owned values at every read/observer boundary, including individual listeners. */
function detachedConfigValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}
