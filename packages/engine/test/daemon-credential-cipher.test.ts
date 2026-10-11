import { describe, expect, test } from 'bun:test';
import { createAtRestCipher, createDaemonCredentialStore, type DaemonCredentialStore } from '../sdk/src/platform/config/daemon-credential-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';

const FIXTURE_KEY = Buffer.alloc(32, 7).toString('base64');
function store(initial: string | null) {
  let value = initial;
  let writes = 0;
  const port: DaemonCredentialStore = {
    async resolveRef() { return value; },
    async resolveConfigSecret() { return value; },
    async put(_name, next) { writes++; value = next; },
    async has() { return value !== null; },
    async getOrCreateDaemonSecret(name, create) {
      if (value !== null) return value;
      const next = create(); await port.put(name, next); return next;
    },
  };
  return { port, get value() { return value; }, get writes() { return writes; } };
}

describe('pinned draft key preservation', () => {
  test('existing valid fixture key round-trips without changing it', async () => {
    const fixture = store(FIXTURE_KEY); const cipher = createAtRestCipher(fixture.port);
    const encrypted = await cipher.encrypt('fixture draft');
    expect(await cipher.decrypt(encrypted)).toBe('fixture draft');
    expect(fixture.value).toBe(FIXTURE_KEY); expect(fixture.writes).toBe(0);
  });
  test('malformed existing key refuses rather than replacing it', async () => {
    const fixture = store('dummy-malformed-existing-key');
    await expect(createAtRestCipher(fixture.port).encrypt('fixture draft')).rejects.toThrow();
    expect(fixture.value).toBe('dummy-malformed-existing-key'); expect(fixture.writes).toBe(0);
  });
  test('decrypt with missing key refuses without generating a replacement', async () => {
    const ciphertext = await createAtRestCipher(store(FIXTURE_KEY).port).encrypt('fixture draft');
    const fixture = store(null);
    await expect(createAtRestCipher(fixture.port).decrypt(ciphertext)).rejects.toThrow();
    expect(fixture.writes).toBe(0); expect(fixture.value).toBeNull();
  });
});

describe('draft cipher lifecycle', () => {
  test('concurrent encrypt calls create one key and use fresh IVs', async () => {
    const fixture = store(null); const cipher = createAtRestCipher(fixture.port);
    const [first, second] = await Promise.all([cipher.encrypt('fixture'), cipher.encrypt('fixture')]);
    expect(fixture.writes).toBe(1);
    expect(Buffer.from(fixture.value!, 'base64').length).toBe(32);
    expect(first).not.toBe(second);
    expect(await cipher.decrypt(first)).toBe('fixture');
    expect(await cipher.decrypt(second)).toBe('fixture');
  });
  test('a missing-key decrypt does not prevent later explicit encryption', async () => {
    const fixture = store(null); const cipher = createAtRestCipher(fixture.port);
    await expect(cipher.decrypt(Buffer.alloc(28).toString('base64'))).rejects.toThrow('missing');
    expect(fixture.writes).toBe(0);
    expect(await cipher.decrypt(await cipher.encrypt('fixture'))).toBe('fixture');
    expect(fixture.writes).toBe(1);
  });
  test('authenticated corruption is refused without changing the key', async () => {
    const fixture = store(FIXTURE_KEY); const cipher = createAtRestCipher(fixture.port);
    const payload = Buffer.from(await cipher.encrypt('fixture'), 'base64');
    payload[payload.length - 1]! ^= 1;
    await expect(cipher.decrypt(payload.toString('base64'))).rejects.toThrow();
    expect(fixture.writes).toBe(0);
  });
  test('a failed store write is reread before retry, preserving a write that actually landed', async () => {
    const fixture = store(null); const put = fixture.port.put;
    let failed = false;
    fixture.port.put = async (...args) => {
      await put(...args);
      if (!failed) { failed = true; throw new Error('fixture uncertain write'); }
    };
    const cipher = createAtRestCipher(fixture.port);
    await expect(cipher.encrypt('first')).rejects.toThrow('fixture uncertain write');
    const firstValue = fixture.value;
    expect(await cipher.decrypt(await cipher.encrypt('retry'))).toBe('retry');
    expect(fixture.writes).toBe(1);
    expect(fixture.value === firstValue).toBe(true);
  });
  for (const invalid of ['', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) {
    test(`wrong-sized stored key of length ${invalid.length} is preserved`, async () => {
      const fixture = store(invalid); const cipher = createAtRestCipher(fixture.port);
      await expect(cipher.encrypt('fixture')).rejects.toThrow('invalid');
      await expect(cipher.decrypt(Buffer.alloc(28).toString('base64'))).rejects.toThrow('invalid');
      expect(fixture.writes).toBe(0);
      expect(fixture.value === invalid).toBe(true);
    });
  }
});

test('local presence distinguishes empty literal credentials, material, references and unavailable stores', () => {
  let current: { state: 'resolved'; value: string } | { state: 'absent' | 'unsupported' } = { state: 'absent' };
  const credentials = createDaemonCredentialStore({ async get() { throw new Error('Must not resolve external credentials'); },
    async set() {}, resolveLocalSecretSync() { return current; } });
  for (const value of ['', '   ']) { current = { state: 'resolved', value }; expect(credentials.inspectConfigSecret!('surfaces.slack.botToken')).toBe('absent'); }
  current = { state: 'resolved', value: 'synthetic-present' }; expect(credentials.inspectConfigSecret!('surfaces.slack.botToken')).toBe('present');
  current = { state: 'unsupported' }; expect(credentials.inspectConfigSecret!('surfaces.slack.botToken')).toBe('unavailable');
});

test('native admitted cipher retains the actual selected key incarnation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-native-cipher-'));
  try {
    const secrets = new SecretsManager({ projectRoot: root, globalHome: root, daemonHome: join(root, 'daemon'), surfaceRoot: 'native-cipher' });
    const cipher = createAtRestCipher(createDaemonCredentialStore(secrets));
    const checks: Array<() => void> = [];
    const encrypted = await cipher.encrypt('synthetic private draft', () => {}, check => { checks.push(check); });
    expect(await cipher.decrypt(encrypted)).toBe('synthetic private draft');
    expect(checks).toHaveLength(1); checks[0]?.();
    await secrets.set('GOODVIBES_DAEMON_DRAFT_AESKEY', Buffer.alloc(32, 19).toString('base64'), { scope: 'daemon', medium: 'secure' });
    expect(() => checks[0]?.()).toThrow('key changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual atomic daemon key owner checks retirement before its first write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-native-cipher-cancel-'));
  try {
    const secrets = new SecretsManager({ projectRoot: root, globalHome: root, daemonHome: join(root, 'daemon'), surfaceRoot: 'native-cipher-cancel' });
    let checks = 0;
    await expect(secrets.getOrCreateDaemonSecret('SYNTHETIC_CANCELLED_KEY', () => Buffer.alloc(32, 5).toString('base64'), () => {
      if (++checks > 1) throw new Error('Synthetic request retired');
    })).rejects.toThrow('retired');
    expect(secrets.resolveLocalSecretSync('SYNTHETIC_CANCELLED_KEY').state).toBe('absent');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native decryption bypasses an old cache and retains the selected key through consume', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-native-decrypt-'));
  try {
    const secrets = new SecretsManager({ projectRoot: root, globalHome: root, daemonHome: join(root, 'daemon'), surfaceRoot: 'native-decrypt' });
    const credentials = createDaemonCredentialStore(secrets);
    const cipher = createAtRestCipher(credentials);
    const first = await cipher.encrypt('first private fixture');
    await secrets.set('GOODVIBES_DAEMON_DRAFT_AESKEY', Buffer.alloc(32, 23).toString('base64'), { scope: 'daemon', medium: 'secure' });
    const second = await createAtRestCipher(credentials).encrypt('second private fixture');
    const checks: Array<() => void> = [];
    expect(await cipher.decrypt(second, () => {}, check => checks.push(check))).toBe('second private fixture');
    await expect(cipher.decrypt(first, () => {}, check => checks.push(check))).rejects.toThrow();
    await secrets.set('GOODVIBES_DAEMON_DRAFT_AESKEY', Buffer.alloc(32, 29).toString('base64'), { scope: 'daemon', medium: 'secure' });
    expect(() => checks[0]?.()).toThrow('key changed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
