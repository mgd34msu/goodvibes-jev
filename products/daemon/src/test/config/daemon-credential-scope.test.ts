/**
 * daemon-credential-scope.test.ts, where a credential lands, and who can read
 * it afterwards.
 *
 * ── The failure this comes from ──────────────────────────────────────────
 *
 * The owner configured Google credentials on one surface and the daemon,
 * serving Telegram, with that surface closed, reported no email integration
 * available, because the value had been filed in a tier only that surface reads.
 * The rule that came out of it: a credential configured anywhere has to be
 * usable by the daemon afterwards, including when the surface that configured it
 * is not running.
 *
 * ── Why this test exists ──────────────────────────────────────────────────
 *
 * This repository's daemon-side subjects had zero test coverage:
 * `createDaemonCredentialStore` had no test importers here, and
 * `secret-config.ts`, the derivation the whole scheme rests on, had none
 * either. These are the assertions whose subjects live in this repository;
 * write-site behavior (the settings modal, the onboarding wizard, `/config
 * set`, provider key intake) is tested where those surfaces live.
 *
 * Every assertion here runs against real temp directories and a real
 * SecretsManager / ConfigManager. Nothing stands in for the store itself; the
 * tier a key landed in is read back from `listDetailed()`, which is the only
 * honest way to assert it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, daemonConfigPath } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  SECRET_CONFIG_KEYS,
  buildGoodVibesSecretKey,
  defaultSecretBackedScope,
  isSecretConfigKey,
  persistSecretBackedConfigValue,
} from '../../config/secret-config.ts';
import { createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.ts';
import { makeOwnedTempDir as makeProjectTempDir } from '../helpers/owned-temp.ts';

const roots: string[] = [];

/**
 * A temp home, with the workspace kept OUTSIDE it. The project tier is searched
 * up the ancestor chain, so a workspace nested under the home would make the
 * home's own store reachable as both the user store and an ancestor project
 * store, and the tier a key landed in would stop being decidable. Siblings keep
 * the three tiers genuinely distinct on disk.
 */
function makeHome(): string {
  const root = makeProjectTempDir('gv-cred-scope');
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

function workspaceFor(home: string): string {
  const projectRoot = join(home, '..', 'workspace');
  mkdirSync(projectRoot, { recursive: true });
  return projectRoot;
}

function makeSecrets(home: string, configManager?: ConfigManager): SecretsManager {
  return new SecretsManager({
    projectRoot: workspaceFor(home),
    globalHome: home,
    ...(configManager ? { configManager } : {}),
  });
}

async function scopeOf(secrets: SecretsManager, key: string): Promise<string | undefined> {
  const records = await secrets.listDetailed();
  return records.find((record) => record.key === key)?.scope;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The allowlist and the default, which decide the tier for every write below.
// ---------------------------------------------------------------------------

describe('SECRET_CONFIG_KEYS', () => {
  test('carries the mail and calendar credentials whose schema says "never in config"', () => {
    for (const key of [
      'surfaces.email.password',
      'surfaces.email.imapPassword',
      'surfaces.email.imap.password',
      'surfaces.email.smtp.password',
      'surfaces.calendar.caldavPassword',
    ]) {
      expect(SECRET_CONFIG_KEYS.has(key as ConfigKey)).toBe(true);
      expect(isSecretConfigKey(key)).toBe(true);
    }
  });
});

describe('defaultSecretBackedScope', () => {
  test('daemon-owned config keys default to the daemon tier', () => {
    expect(defaultSecretBackedScope('surfaces.email.password' as ConfigKey)).toBe('daemon');
    expect(defaultSecretBackedScope('surfaces.calendar.caldavPassword' as ConfigKey)).toBe('daemon');
    expect(defaultSecretBackedScope('surfaces.slack.botToken' as ConfigKey)).toBe('daemon');
  });

  test('a client-owned key still defaults to the user tier', () => {
    expect(defaultSecretBackedScope('display.themeMode' as ConfigKey)).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// The write path itself, the config value is a reference, the value is in the
// store, and no settings file anywhere holds the plaintext.
// ---------------------------------------------------------------------------

describe('secret-backed config write', () => {
  test('surfaces.email.password lands in the encrypted daemon store, and no config file holds the password', async () => {
    const home = makeHome();
    const configManager = new ConfigManager({
      homeDir: home,
      workingDir: home,
      surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    });
    const secrets = makeSecrets(home, configManager);
    const key = 'surfaces.email.password' as ConfigKey;

    const configValue = await persistSecretBackedConfigValue(
      configManager,
      secrets,
      key,
      'mailbox-app-password',
    );

    // The config key holds a reference, never the password.
    expect(configValue).toBe('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_EMAIL_PASSWORD');
    expect(configManager.get(key)).toBe(configValue);

    // The value is in the secret store, in the daemon tier.
    expect(await secrets.get('GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('mailbox-app-password');
    expect(await scopeOf(secrets, 'GOODVIBES_SURFACES_EMAIL_PASSWORD')).toBe('daemon');

    // No settings JSON anywhere under this home carries the plaintext. The
    // daemon-owned key routes to the daemon settings file, so check that one by
    // name as well as the surface file.
    for (const path of [
      daemonConfigPath(home),
      join(home, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'settings.json'),
      join(home, '.goodvibes', 'settings.json'),
    ]) {
      if (!existsSync(path)) continue;
      expect(readFileSync(path, 'utf-8')).not.toContain('mailbox-app-password');
    }
  });

  test('clearing a secret-backed setting removes the credential from the tier it was written to', async () => {
    const home = makeHome();
    const configManager = new ConfigManager({
      homeDir: home,
      workingDir: home,
      surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    });
    const secrets = makeSecrets(home, configManager);
    const key = 'surfaces.calendar.caldavPassword' as ConfigKey;

    await persistSecretBackedConfigValue(configManager, secrets, key, 'caldav-secret');
    expect(await secrets.get('GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD')).toBe('caldav-secret');

    // An empty write is a clear. A delete narrowed to the wrong tier would leave
    // the daemon still holding the live credential while the caller was told the
    // setting was cleared.
    await persistSecretBackedConfigValue(configManager, secrets, key, '');
    expect(configManager.get(key)).toBe('');
    expect(await secrets.get('GOODVIBES_SURFACES_CALENDAR_CALDAV_PASSWORD')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The daemon's own credential store.
// ---------------------------------------------------------------------------

describe('DaemonCredentialStore.put', () => {
  test('defaults to the daemon tier, since every caller is the daemon itself', async () => {
    const home = makeHome();
    const secrets = makeSecrets(home);
    const store = createDaemonCredentialStore(secrets);

    await store.put('GOODVIBES_DAEMON_DRAFT_AESKEY', 'a-generated-key', { medium: 'secure' });

    expect(await scopeOf(secrets, 'GOODVIBES_DAEMON_DRAFT_AESKEY')).toBe('daemon');
    expect(await store.has('GOODVIBES_DAEMON_DRAFT_AESKEY')).toBe(true);
  });

  test('an explicit non-daemon scope is still honoured for a key the platform does not own', async () => {
    const home = makeHome();
    const secrets = makeSecrets(home);
    const store = createDaemonCredentialStore(secrets);

    await store.put('SOME_UNOWNED_KEY', 'value', { scope: 'user', medium: 'secure' });
    expect(await scopeOf(secrets, 'SOME_UNOWNED_KEY')).toBe('user');
  });

  test('has() is honest about a key that was never written', async () => {
    const home = makeHome();
    const store = createDaemonCredentialStore(makeSecrets(home));
    expect(await store.has('GOODVIBES_NEVER_WRITTEN')).toBe(false);
    expect(await store.resolveConfigSecret('surfaces.email.password')).toBeNull();
  });

  test('resolveRef reads a goodvibes:// reference and a bare key name alike', async () => {
    const home = makeHome();
    const secrets = makeSecrets(home);
    const store = createDaemonCredentialStore(secrets);
    await store.put('GOODVIBES_SURFACES_NTFY_TOKEN', 'ntfy-token-value', { medium: 'secure' });

    // The reference is what a config file holds; the bare name is what internal
    // callers pass. Both have to reach the same value or a credential resolves
    // for one call site and not the other.
    expect(await store.resolveRef('goodvibes://secrets/goodvibes/GOODVIBES_SURFACES_NTFY_TOKEN'))
      .toBe('ntfy-token-value');
    expect(await store.resolveRef('GOODVIBES_SURFACES_NTFY_TOKEN')).toBe('ntfy-token-value');
  });
});

// ---------------------------------------------------------------------------
// The round-trip the owner actually described: configure through the settings
// path, read it back from the daemon's own store with that surface gone.
// ---------------------------------------------------------------------------

describe('configure on one surface, resolve from the daemon', () => {
  test('a mailbox password set through the settings path resolves through the daemon credential store', async () => {
    const home = makeHome();
    const configManager = new ConfigManager({
      homeDir: home,
      workingDir: home,
      surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    });
    const surfaceSecrets = makeSecrets(home, configManager);

    await persistSecretBackedConfigValue(
      configManager,
      surfaceSecrets,
      'surfaces.email.imapPassword' as ConfigKey,
      'imap-app-password',
    );

    // A DIFFERENT SecretsManager, standing in for the daemon process: same home,
    // different project root, and nothing carried over from the surface.
    const daemonProjectRoot = join(home, '..', 'somewhere-else');
    mkdirSync(daemonProjectRoot, { recursive: true });
    const daemonSecrets = new SecretsManager({ projectRoot: daemonProjectRoot, globalHome: home });
    const credentials = createDaemonCredentialStore(daemonSecrets);

    expect(await credentials.resolveConfigSecret('surfaces.email.imapPassword')).toBe('imap-app-password');
    expect(buildGoodVibesSecretKey('surfaces.email.imapPassword')).toBe('GOODVIBES_SURFACES_EMAIL_IMAP_PASSWORD');
  });
});
