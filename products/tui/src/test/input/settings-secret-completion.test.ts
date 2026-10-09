import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { describe, expect, test, spyOn } from 'bun:test';
import { ConfigManager, SecretsManager, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { setSecretBackedSettingValue } from '../../input/settings-modal-secrets.ts';
import { persistSecretBackedConfigValue, buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../config/secret-config.ts';

const key = 'surfaces.ntfy.token';
const reference = buildGoodVibesSecretRef(buildGoodVibesSecretKey(key));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const entrypoint of ['modal', 'persist'] as const) {
  describe(`${entrypoint} secret completion`, () => {
    function fixture(value: string) {
      const storage = deferred();
      const changes: unknown[] = [];
      const errors: string[] = [];
      const config = { get: () => 'secure_only', setDynamic: (_key: string, next: unknown) => { changes.push(next); } };
      const secrets = { set: () => storage.promise, delete: () => storage.promise };
      const completion = entrypoint === 'modal'
        ? setSecretBackedSettingValue({ key, value, configManager: config as unknown as ConfigManager,
          secretsManager: secrets, setConfigValue: config.setDynamic, onError: (message) => { errors.push(message); } })
        : persistSecretBackedConfigValue(config, secrets, key, value, { scope: 'daemon' });
      return { storage, changes, errors, completion };
    }

    test('publishes the reference only after deferred storage succeeds', async () => {
      const f = fixture('new-value');
      expect(f.changes).toEqual([]);
      f.storage.resolve();
      await f.completion;
      expect(f.changes).toEqual([reference]);
      expect(f.errors).toEqual([]);
    });

    test('rejected storage leaves config untouched', async () => {
      const f = fixture('new-value');
      f.storage.reject(new Error('storage rejected'));
      if (entrypoint === 'modal') {
        expect(await f.completion).toBe(false);
        expect(f.errors[0]).toMatch(/failed/i);
      } else await expect(f.completion).rejects.toThrow('storage rejected');
      expect(f.changes).toEqual([]);
    });

    test('config persistence failure after storage is reported as incomplete', async () => {
      const storage = deferred();
      let stored = false;
      const config = { get: () => 'secure_only', validateDynamic: () => {},
        setDynamic: () => { throw new Error('config persistence failed'); } };
      const secrets = { set: async () => { await storage.promise; stored = true; }, delete: async () => {} };
      const completion = entrypoint === 'modal'
        ? setSecretBackedSettingValue({ key, value: 'new-value', configManager: config as unknown as ConfigManager,
          secretsManager: secrets, setConfigValue: config.setDynamic })
        : persistSecretBackedConfigValue(config, secrets, key, 'new-value', { scope: 'daemon' });
      storage.resolve();
      if (entrypoint === 'modal') expect(await completion).toBe(false);
      else await expect(completion).rejects.toThrow('config persistence failed');
      // Storage and config are not a transaction; no success is fabricated.
      expect(stored).toBe(true);
    });

    test('clears config only after deferred deletion succeeds', async () => {
      const f = fixture('');
      expect(f.changes).toEqual([]);
      f.storage.resolve();
      await f.completion;
      expect(f.changes).toEqual(['']);
    });

    test('rejected deletion preserves the saved reference', async () => {
      const f = fixture('');
      f.storage.reject(new Error('delete rejected'));
      if (entrypoint === 'modal') {
        expect(await f.completion).toBe(false);
        expect(f.errors[0]).toMatch(/failed/i);
      } else await expect(f.completion).rejects.toThrow('delete rejected');
      expect(f.changes).toEqual([]);
    });
  });
}

test('credential failures never echo secret material into logs or UI', async () => {
  const secret = 'synthetic-secret-must-stay-hidden';
  const errors: string[] = [];
  const logs = spyOn(logger, 'error').mockImplementation(() => {});
  try {
    const result = await setSecretBackedSettingValue({ key, value: secret,
      configManager: { get: () => 'secure_only' } as unknown as ConfigManager,
      secretsManager: { set: async () => { throw new Error(`store rejected ${secret}`); }, delete: async () => {} },
      setConfigValue: () => { throw new Error('must not publish'); }, onError: (message) => { errors.push(message); } });
    expect(result).toBe(false);
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain(secret);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(secret);
  } finally { logs.mockRestore(); }
});

test('clearing removes both storage media rather than only the currently selected policy', async () => {
  const media = new Set(['secure', 'plaintext']);
  const changes: unknown[] = [];
  const result = await setSecretBackedSettingValue({ key, value: '',
    configManager: { get: () => 'secure_only' } as unknown as ConfigManager,
    secretsManager: { set: async () => {}, delete: async (_key, options) => {
      if (options?.medium) media.delete(options.medium);
      else media.clear();
    } }, setConfigValue: (_key, value) => { changes.push(value); } });
  expect(result).toBe(true);
  expect(media.size).toBe(0);
  expect(changes).toEqual(['']);
});

for (const refusal of ['invalid-path', 'invalid-value', 'managed', 'read-only'] as const) {
  test(`config preflight ${refusal} refuses before modifying secret storage`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'secret-preflight-'));
    const configDir = join(root, 'config');
    mkdirSync(configDir, { recursive: true });
    const config = new ConfigManager({ configDir, readOnly: refusal === 'read-only' });
    const target = (refusal === 'invalid-path' ? 'absent.token' : refusal === 'invalid-value' ? 'controlPlane.hostMode' : key) as ConfigKey;
    if (refusal === 'managed') writeFileSync(join(configDir, 'settings-sync.json'), JSON.stringify({
      version: 2, managedLocks: [{ key: target, source: 'fixture', reason: 'locked', updatedAt: Date.now() }],
    }));
    let stores = 0;
    const secrets = { set: async () => { stores++; }, delete: async () => { stores++; } };
    try {
      await expect(persistSecretBackedConfigValue(config, secrets, target, 'synthetic-value', { scope: 'daemon' })).rejects.toThrow();
      expect(stores).toBe(0);
      const result = await setSecretBackedSettingValue({ key: target, value: 'synthetic-value', configManager: config,
        secretsManager: secrets, setConfigValue: (key, value) => config.setDynamic(key, value) });
      expect(result).toBe(false);
      expect(stores).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('missing storage fails closed for new credential material and clears', async () => {
  const changes: unknown[] = [];
  const config = { get: () => 'secure_only', setDynamic: (_key: string, value: unknown) => { changes.push(value); } };
  for (const value of ['must-not-be-written-raw', '']) {
    expect(await setSecretBackedSettingValue({ key, value, configManager: config as unknown as ConfigManager,
      secretsManager: null, setConfigValue: config.setDynamic })).toBe(false);
    await expect(persistSecretBackedConfigValue(config, null, key, value, { scope: 'daemon' })).rejects.toThrow('unavailable');
  }
  expect(changes).toEqual([]);
});

test('an existing opaque reference needs no secret store and uses the config-only path', async () => {
  const changes: unknown[] = [];
  const config = { get: () => 'secure_only', setDynamic: (_key: string, value: unknown) => { changes.push(value); } };
  expect(await setSecretBackedSettingValue({ key, value: reference, configManager: config as unknown as ConfigManager,
    secretsManager: null, setConfigValue: config.setDynamic })).toBe(true);
  expect(await persistSecretBackedConfigValue(config, null, key, reference, { scope: 'daemon' })).toBe(reference);
  expect(changes).toEqual([reference, reference]);
});

test('a store lacking deletion cannot claim a completed clear', async () => {
  const changes: unknown[] = [];
  const config = { get: () => 'secure_only', setDynamic: (_key: string, value: unknown) => { changes.push(value); } };
  await expect(persistSecretBackedConfigValue(config, { set: async () => {} }, key, '', { scope: 'daemon' })).rejects.toThrow('deletion is unavailable');
  expect(changes).toEqual([]);
});

test('generic whitespace clear revokes real secure and plaintext copies before clearing the reference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'generic-secret-clear-'));
  const config = new ConfigManager({ surfaceRoot: 'synthetic-fixture', homeDir: root, workingDir: root, configDir: join(root, 'config') });
  const secrets = new SecretsManager({ surfaceRoot: 'synthetic-fixture', projectRoot: root, globalHome: root, configManager: config });
  const secretKey = buildGoodVibesSecretKey(key);
  try {
    config.setDynamic('storage.secretPolicy', 'plaintext_allowed');
    await secrets.set(secretKey, 'synthetic-secure-copy', { scope: 'daemon', medium: 'secure' });
    await secrets.set(secretKey, 'synthetic-plaintext-copy', { scope: 'daemon', medium: 'plaintext' });
    config.setDynamic(key, reference);
    expect((await secrets.listDetailed()).filter(row => row.key === secretKey).map(row => row.secure).sort()).toEqual([false, true]);
    expect(await persistSecretBackedConfigValue(config, secrets, key, ' ', { scope: 'daemon' })).toBe('');
    expect(config.get(key)).toBe('');
    expect(await secrets.get(secretKey)).toBeNull();
    expect((await secrets.listDetailed()).filter(row => row.key === secretKey)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
