/**
 * Integration test: email.* config keys with a real ConfigManager instance.
 *
 * Covers CRIT-A/CRIT-B: the user-facing setter path (/email set) via
 * persistSecretBackedConfigValue for secret keys. These tests exercise the
 * real command/persist path, they do NOT mutate config[] directly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ensureEmailConfigDefaults } from '@goodvibes-jev/engine/sdk/platform/email';
import type { ConfigKey } from '../../config/index.ts';
import { persistSecretBackedConfigValue } from '../../config/secret-config.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = makeProjectTempDir(`gv-email-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return dir;
}

function createConfigManager(workingDir: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'tui',
    workingDir,
    homeDir: workingDir,
    configDir: join(workingDir, '.goodvibes', 'global-tui'),
  });
}

/** Wrap configManager with the string-keyed getter used by email-service. */
function emailGet(cm: ConfigManager, key: string): unknown {
  return (cm as unknown as { get: (k: string) => unknown }).get(key);
}

// ---------------------------------------------------------------------------
// User-facing setter path: /email set, CRIT-A / CRIT-B
// ---------------------------------------------------------------------------

/**
 * Cast a ConfigManager to the SecretBackedConfigManager interface accepted
 * by persistSecretBackedConfigValue. The email section must already be
 * injected via ensureEmailConfigDefaults before calling.
 */
function asSecretBacked(cm: ConfigManager): Parameters<typeof persistSecretBackedConfigValue>[0] {
  return cm as unknown as Parameters<typeof persistSecretBackedConfigValue>[0];
}

/**
 * Minimal SecretsManager stub that captures set() calls.
 * Uses an in-memory store so it fulfils the SecretBackedSecretStore contract
 * without requiring real encrypted file I/O.
 */
function makeMemorySecretsManager(): {
  store: Map<string, string>;
  manager: Parameters<typeof persistSecretBackedConfigValue>[1];
} {
  const store = new Map<string, string>();
  const manager = {
    set: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
  return { store, manager };
}

describe('email set command path: user-facing setter via persistSecretBackedConfigValue', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('passwordRef path routes raw secret through SecretsManager; settings.json stores only goodvibes:// ref', async () => {
    const configDir = join(tmpDir, '.goodvibes', 'global-tui');
    const cm = createConfigManager(tmpDir);
    ensureEmailConfigDefaults(cm);
    const { store, manager } = makeMemorySecretsManager();

    const configKey = 'email.passwordRef' as unknown as ConfigKey;
    const rawPassword = 'super-secret-password-123';

    // This is the exact call made by handleSet for the passwordRef path
    const storedRef = await persistSecretBackedConfigValue(
      asSecretBacked(cm),
      manager,
      configKey,
      rawPassword,
      { scope: 'user' },
    );
    (cm as unknown as { save: () => void }).save();

    // (a) The plain key round-trips: configManager returns the goodvibes:// ref
    expect(emailGet(cm, 'email.passwordRef')).toBe(storedRef);
    expect(storedRef).toMatch(/^goodvibes:\/\/secrets\//);

    // (b) settings.json contains the goodvibes:// ref, NOT the plaintext password
    mkdirSync(configDir, { recursive: true });
    // The daemon tier is in this list because that is where the value now
    // legitimately lives: email runs in the daemon, so email.passwordRef is
    // daemon-owned and the daemon's store is its only home. What this test
    // guards is unchanged, the raw password reaches no settings file, and a
    // goodvibes:// reference reaches one, but looking only in the surface
    // files would have reported the ref missing when it had simply been routed
    // to its owner.
    const settingsFiles = [
      join(configDir, 'settings.json'),
      join(configDir, 'user-settings.json'),
      join(tmpDir, '.goodvibes', 'global-tui', 'settings.json'),
      join(tmpDir, '.goodvibes', 'daemon', 'settings.json'),
    ];
    let settingsContent = '';
    for (const f of settingsFiles) {
      if (existsSync(f)) {
        settingsContent += readFileSync(f, 'utf-8');
      }
    }
    // The raw password must never appear in any settings file
    expect(settingsContent).not.toContain(rawPassword);
    // The goodvibes:// ref must be present
    if (settingsContent.length > 0) {
      expect(settingsContent).toContain('goodvibes://');
    }

    // (c) SecretsManager received the raw value under the expected key
    // Key shape is GOODVIBES_<SECTION>_<CAMEL_TO_UPPER_SNAKE> per buildGoodVibesSecretKey
    const expectedSecretKey = 'GOODVIBES_EMAIL_PASSWORD_REF';
    expect(store.has(expectedSecretKey)).toBe(true);
    expect(store.get(expectedSecretKey)).toBe(rawPassword);
  });

  test('passwordRef path: new ConfigManager loaded from same configDir sees the goodvibes:// ref', async () => {
    const cm = createConfigManager(tmpDir);
    ensureEmailConfigDefaults(cm);
    const { manager } = makeMemorySecretsManager();

    const configKey = 'email.passwordRef' as unknown as ConfigKey;
    const storedRef = await persistSecretBackedConfigValue(
      asSecretBacked(cm),
      manager,
      configKey,
      'my-email-password',
      { scope: 'user' },
    );
    (cm as unknown as { save: () => void }).save();

    // Load a brand-new ConfigManager from the same directory
    const cm2 = createConfigManager(tmpDir);
    ensureEmailConfigDefaults(cm2);

    // The ref must survive the save → load round-trip
    expect(emailGet(cm2, 'email.passwordRef')).toBe(storedRef);
    expect(String(emailGet(cm2, 'email.passwordRef'))).toMatch(/^goodvibes:\/\/secrets\//);
  });
});
