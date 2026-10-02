/** Internal policy-file mechanics shared by ordinary and read-only host readers. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../../types/errors.js';
import type { ManagedSettingLock, SettingsControlPlaneStore } from './control-plane-store.js';

export function getSettingsControlPath(configDir: string): string {
  return join(configDir, 'settings-sync.json');
}

export function defaultStore(): SettingsControlPlaneStore {
  return {
    version: 2,
    events: [],
    managedLocks: [],
    failures: [],
    syncedSettings: [],
    managedSettings: [],
    conflicts: [],
    rollbackHistory: [],
  };
}

export function migrateStore(raw: unknown): SettingsControlPlaneStore {
  if (!raw || typeof raw !== 'object') return defaultStore();
  const store = raw as Partial<SettingsControlPlaneStore> & { version?: number };
  if (store.version === 2) {
    return {
      ...defaultStore(),
      ...store,
      events: Array.isArray(store.events) ? store.events : [],
      managedLocks: Array.isArray(store.managedLocks) ? store.managedLocks : [],
      failures: Array.isArray(store.failures) ? store.failures : [],
      syncedSettings: Array.isArray(store.syncedSettings) ? store.syncedSettings : [],
      managedSettings: Array.isArray(store.managedSettings) ? store.managedSettings : [],
      conflicts: Array.isArray(store.conflicts) ? store.conflicts : [],
      rollbackHistory: Array.isArray(store.rollbackHistory) ? store.rollbackHistory : [],
    };
  }
  return {
    ...defaultStore(),
    events: Array.isArray(store.events) ? store.events : [],
    managedLocks: Array.isArray(store.managedLocks) ? store.managedLocks : [],
    failures: Array.isArray(store.failures) ? store.failures : [],
  };
}

/** Read typed host lock metadata without quarantine, repair, or persistence. */
export function readHostManagedSettingLock(key: string, configDir: string): Readonly<Omit<ManagedSettingLock, 'key'>> | null {
  let raw: string;
  try { raw = readFileSync(getSettingsControlPath(configDir), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw policyReadFailure();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw policyReadFailure();
    const locks = (parsed as { managedLocks?: unknown }).managedLocks;
    // Legacy stores with no lock list migrate to an empty one. A present list
    // must be readable before metadata can claim either locked or unlocked.
    if (locks !== undefined && !Array.isArray(locks)) throw policyReadFailure();
    const store = migrateStore(parsed);
    for (const lock of store.managedLocks) {
      if (!lock || typeof lock !== 'object' || typeof lock.key !== 'string'
        || typeof lock.source !== 'string' || typeof lock.reason !== 'string'
        || typeof lock.updatedAt !== 'number' || !Number.isFinite(lock.updatedAt)) throw policyReadFailure();
    }
    const lock = store.managedLocks.find(entry => entry.key === key);
    return lock ? Object.freeze({ source: lock.source, reason: lock.reason, updatedAt: lock.updatedAt }) : null;
  } catch { throw policyReadFailure(); }
}

function policyReadFailure(): ConfigError {
  return new ConfigError('Host setting metadata is unavailable because managed policy could not be read.');
}
