import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { createAtRestCipher, createDaemonCredentialStore } from '../sdk/src/platform/config/daemon-credential-store.js';

const KEY = 'GOODVIBES_DAEMON_DRAFT_AESKEY';
function owner(home: string) {
  return new SecretsManager({ globalHome: home, projectRoot: home, daemonHome: join(home, 'daemon'), surfaceRoot: 'daemon' });
}

test('independent process creators share one draft namespace and every draft survives reopen', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-draft-key-'));
  const fixture = join(home, 'creator.ts');
  writeFileSync(fixture, `import { SecretsManager } from ${JSON.stringify(new URL('../sdk/src/platform/config/secrets.ts', import.meta.url).href)};
import { createAtRestCipher, createDaemonCredentialStore } from ${JSON.stringify(new URL('../sdk/src/platform/config/daemon-credential-store.ts', import.meta.url).href)};
const [home, id] = process.argv.slice(2);
const secrets = new SecretsManager({ globalHome: home, projectRoot: home, daemonHome: home + '/daemon', surfaceRoot: 'daemon' });
const cipher = createAtRestCipher(createDaemonCredentialStore(secrets));
while (!(await Bun.file(home + '/start').exists())) await Bun.sleep(5);
await secrets.set('SYNTHETIC_OTHER_' + id, 'synthetic unrelated ' + id, { scope: 'daemon', medium: 'secure' });
await Bun.write(home + '/draft-' + id, await cipher.encrypt('synthetic draft ' + id));
await secrets.set('SYNTHETIC_AFTER_' + id, 'synthetic after ' + id, { scope: 'daemon', medium: 'secure' });
const userOwner = new SecretsManager({ globalHome: home, projectRoot: home + '/project-' + id, daemonHome: home + '/daemon-' + id, surfaceRoot: 'shared-fixture' });
await userOwner.set('SYNTHETIC_USER_' + id, 'synthetic user ' + id, { scope: 'user', medium: 'secure' });
`);
  const children = Array.from({ length: 8 }, (_, id) => Bun.spawn([process.execPath, fixture, home, String(id)], { stdout: 'pipe', stderr: 'pipe' }));
  try {
    writeFileSync(join(home, 'start'), 'start');
    for (const child of children) {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
    }
    const cipher = createAtRestCipher(createDaemonCredentialStore(owner(home)));
    for (let id = 0; id < children.length; id++) {
      expect(await cipher.decrypt(readFileSync(join(home, `draft-${id}`), 'utf8'))).toBe(`synthetic draft ${id}`);
      expect(await owner(home).get(`SYNTHETIC_OTHER_${id}`)).toBe(`synthetic unrelated ${id}`);
      expect(await owner(home).get(`SYNTHETIC_AFTER_${id}`)).toBe(`synthetic after ${id}`);
      const userOwner = new SecretsManager({ globalHome: home, projectRoot: home, daemonHome: join(home, 'unrelated-daemon'), surfaceRoot: 'shared-fixture' });
      expect(await userOwner.get(`SYNTHETIC_USER_${id}`)).toBe(`synthetic user ${id}`);
    }
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exited));
    rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

test('existing malformed namespace material and missing decrypt never create a replacement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'daemon-draft-preserve-'));
  try {
    const secrets = owner(home);
    await expect(createAtRestCipher(createDaemonCredentialStore(secrets)).decrypt('invalid')).rejects.toThrow('missing');
    expect(await secrets.get(KEY)).toBeNull();
    await secrets.set(KEY, 'invalid-existing-key', { scope: 'daemon', medium: 'secure' });
    const path = join(home, 'daemon', 'secrets.enc');
    const before = readFileSync(path);
    await expect(createAtRestCipher(createDaemonCredentialStore(owner(home))).encrypt('synthetic')).rejects.toThrow('invalid');
    expect(readFileSync(path)).toEqual(before);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a namespace without atomic first-create authority refuses new drafts', async () => {
  const fixture = { async get() { return null; }, async set() { throw new Error('must not write'); } };
  await expect(createAtRestCipher(createDaemonCredentialStore(fixture)).encrypt('synthetic')).rejects.toThrow('atomic namespace owner');
});

test('user-tier writes never depend on an inaccessible daemon namespace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'secret-actual-target-'));
  try {
    const blocker = join(home, 'not-a-directory'); writeFileSync(blocker, 'fixture');
    const secrets = new SecretsManager({ globalHome: home, projectRoot: join(home, 'project'), surfaceRoot: 'daemon',
      daemonHome: join(blocker, 'daemon') });
    await secrets.set('SYNTHETIC_USER_ONLY', 'synthetic value', { scope: 'user', medium: 'secure' });
    expect(await secrets.get('SYNTHETIC_USER_ONLY')).toBe('synthetic value');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a live policy change cannot redirect mutation into an unlocked secure namespace', async () => {
  const home = mkdtempSync(join(tmpdir(), 'secret-policy-race-'));
  const secure = join(home, 'daemon', 'secrets.enc');
  const release = await acquireCrossProcessLock(`${secure}.mutation.lock`, { strictOwnership: true });
  let policy = 'plaintext_allowed';
  const configManager = { get() { return policy; } } as unknown as ConfigManager;
  try {
    const secrets = new SecretsManager({ globalHome: home, projectRoot: home, daemonHome: join(home, 'daemon'),
      surfaceRoot: 'daemon', configManager });
    const pending = secrets.set('SYNTHETIC_POLICY_RACE', 'synthetic', { scope: 'daemon' });
    policy = 'require_secure';
    await expect(pending).rejects.toThrow('policy changed');
    expect(existsSync(secure)).toBe(false);
  } finally { release(); rmSync(home, { recursive: true, force: true }); }
});

test('an inaccessible optional plaintext fallback does not block a valid secure target', async () => {
  const home = mkdtempSync(join(tmpdir(), 'secret-fallback-target-'));
  try {
    const blocker = join(home, 'not-a-directory'); writeFileSync(blocker, 'fixture');
    const secureUserFilePath = join(home, 'working-secure.enc');
    const secrets = new SecretsManager({ globalHome: home, projectRoot: home, surfaceRoot: 'daemon',
      secureUserFilePath, plaintextUserFilePath: join(blocker, 'fallback.json'), policy: 'preferred_secure' });
    await secrets.set('SYNTHETIC_SECURE_TARGET', 'synthetic value', { scope: 'user', medium: 'secure' });
    expect(await secrets.get('SYNTHETIC_SECURE_TARGET')).toBe('synthetic value');
    expect(existsSync(secureUserFilePath)).toBe(true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
