import { readFileSync, statSync } from 'node:fs';
import { ConfigError } from '../types/errors.js';
import { HostSettings, isHostSettingsObject, type HostSettingValues } from './host-settings.js';

/** Internal provenance for the existing ingestion-notice reporting path. */
export class HostSettingsReadError extends ConfigError {
  constructor(readonly file: string, message: string) { super(message); }
}

/** Publish the verified host state, then preserve the original persistence failure. */
export function recoverHostSettingsWriteFailure(error: unknown, refresh: () => void): never {
  try { refresh(); }
  catch { /* The refresh already applied restrictive defaults and recorded its read failure. */ }
  throw error;
}

/** existsSync conflates unreadable ancestors with absence; host permission must not. */
export function hostSettingsFileExists(path: string): boolean {
  try { statSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new HostSettingsReadError(path, `Host settings could not be accessed at ${path}; registered host settings use their restrictive defaults.`);
  }
}

/** Strict, read-only resolution for registered surface settings only. */
export function readHostSettingValues(
  host: HostSettings, globalPath: string, projectPath: string | null,
  validate?: (raw: Record<string, unknown>, path: string) => void,
): HostSettingValues {
  let values = host.defaults();
  for (const path of [globalPath, projectPath]) {
    if (path) {
      const raw = readHostSettingsFile(path);
      const next = new Map(values);
      host.overlay(next, raw);
      validate?.(raw, path);
      values = next;
    }
  }
  return values;
}

/** Unlike write-recovery readers, this never quarantines or repairs a file. */
export function readHostSettingsFile(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isHostSettingsObject(parsed)) throw new Error('Expected JSON object');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new HostSettingsReadError(path, `Host settings could not be read from ${path}; registered host settings use their restrictive defaults.`);
  }
}
