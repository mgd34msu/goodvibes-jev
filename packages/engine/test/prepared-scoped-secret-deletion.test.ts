import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { encryptStore, decryptStore, deriveLegacyEncryptionKey } from '../sdk/src/platform/config/secrets-keyfile.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = makeProjectTempDir('prepared-scoped-secret'); roots.push(root);
  const daemon = join(root, 'daemon'); mkdirSync(daemon);
  const path = join(daemon, 'secrets.json');
  writeFileSync(path, JSON.stringify({ version: 1, secrets: { SYNTHETIC: 'private-fixture', OTHER: 'keep' } }));
  const manager = new SecretsManager({ surfaceRoot: 'agent', projectRoot: join(root, 'project'), globalHome: root, daemonHome: daemon });
  return { manager, path, root };
}
test('prepared scoped deletion captures only physical destinations and never creates key material', async () => {
  const f = fixture(); const prepared = f.manager.prepareScopedDeletion('SYNTHETIC', 'daemon');
  expect(JSON.stringify(f.manager.inspectPreparedScopedDeletion(prepared))).not.toContain('private-fixture');
  expect(existsSync(join(f.root, '.goodvibes', 'secrets.key'))).toBe(false);
  expect((await f.manager.applyPreparedScopedDeletion(prepared, () => {})).status).toBe('committed');
  expect(JSON.parse(readFileSync(f.path, 'utf8')).secrets).toEqual({ OTHER: 'keep' });
  expect(() => f.manager.assertCompletedScopedDeletion(prepared)).not.toThrow();
  await expect(f.manager.applyPreparedScopedDeletion(prepared, () => {})).rejects.toThrow();
});
test('copied/cross-owner handles and raw store ABA cannot authorize deletion', async () => {
  const f = fixture(); const other = fixture(); const prepared = f.manager.prepareScopedDeletion('SYNTHETIC', 'daemon');
  expect(() => other.manager.assertPreparedScopedDeletion(prepared)).toThrow();
  expect(() => f.manager.assertPreparedScopedDeletion({ ...prepared })).toThrow();
  const raw = readFileSync(f.path, 'utf8'); writeFileSync(f.path, '{}'); writeFileSync(f.path, raw);
  await expect(f.manager.applyPreparedScopedDeletion(prepared, () => {})).rejects.toThrow();
  expect(readFileSync(f.path, 'utf8')).toBe(raw);
});
test('retained finish capability expires with the owning lock scope', async () => {
  const f = fixture(); const prepared = f.manager.prepareScopedDeletion('SYNTHETIC', 'daemon');
  let escaped: (() => unknown) | undefined;
  await f.manager.withPreparedScopedDeletion(prepared, finish => { escaped = () => finish(() => {}); });
  expect(() => escaped!()).toThrow();
  expect(JSON.parse(readFileSync(f.path, 'utf8')).secrets.SYNTHETIC).toBe('private-fixture');
});
test('reentrant credential invalidation cannot proceed into persistence', async () => {
  const f = fixture(); const prepared = f.manager.prepareScopedDeletion('SYNTHETIC', 'daemon'); let cancelled = false;
  const off = f.manager.onDidInvalidateCredentials(() => { cancelled = true; });
  const receipt = await f.manager.applyPreparedScopedDeletion(prepared, () => { if (cancelled) throw new Error('cancelled'); }); off();
  expect(receipt.status).toBe('unknown'); expect(JSON.parse(readFileSync(f.path, 'utf8')).secrets.SYNTHETIC).toBe('private-fixture');
});
test('completed deletion fence rejects post-effect file replacement rather than recapturing it', async () => {
  const f = fixture(); const prepared = f.manager.prepareScopedDeletion('SYNTHETIC', 'daemon');
  const off = f.manager.onDidChange(() => writeFileSync(f.path, JSON.stringify({ version: 1, secrets: { SYNTHETIC: 'replacement' } })));
  const receipt = await f.manager.applyPreparedScopedDeletion(prepared, () => {}); off();
  expect(receipt.status).toBe('committed'); expect(() => f.manager.assertCompletedScopedDeletion(prepared)).toThrow();
});

test.each(['modern', 'legacy'] as const)('scoped deletion preserves %s encryption and unrelated material without key lifecycle writes', async format => {
  const f = fixture(); const path = join(f.root, 'daemon', 'secrets.enc');
  const keyfile = join(f.root, '.goodvibes', 'secrets.key');
  const key = format === 'modern' ? Buffer.alloc(32, 0x31) : deriveLegacyEncryptionKey();
  if (format === 'modern') { mkdirSync(join(f.root, '.goodvibes')); writeFileSync(keyfile, key.toString('hex') + '\n'); }
  const envelope = encryptStore(JSON.stringify({ SYNTHETIC: 'private-ciphertext-fixture', OTHER: 'keep-encrypted' }), key);
  if (format === 'legacy') { delete envelope.version; delete envelope.keyId; }
  writeFileSync(path, JSON.stringify(envelope));
  const keyBefore = existsSync(keyfile) ? readFileSync(keyfile, 'utf8') : null;
  const prepared = f.manager.prepareScopedDeletion('SYNTHETIC', 'daemon');
  expect(JSON.stringify(f.manager.inspectPreparedScopedDeletion(prepared))).not.toContain('private-ciphertext-fixture');
  const receipt = await f.manager.applyPreparedScopedDeletion(prepared, () => {});
  expect(receipt.status).toBe('committed'); expect(receipt.completedPaths).toContain(path);
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  expect(stored.version).toBe(format === 'modern' ? 2 : undefined);
  expect(JSON.parse(decryptStore(stored, key))).toEqual({ OTHER: 'keep-encrypted' });
  expect(existsSync(keyfile) ? readFileSync(keyfile, 'utf8') : null).toBe(keyBefore);
  expect(() => f.manager.assertCompletedScopedDeletion(prepared)).not.toThrow();
});
test('keyfile byte ABA retires encrypted scoped deletion before any publication', async () => {
  const f = fixture(); const path = join(f.root, 'daemon', 'secrets.enc');
  const keyfile = join(f.root, '.goodvibes', 'secrets.key'); const key = Buffer.alloc(32, 0x32);
  mkdirSync(join(f.root, '.goodvibes')); writeFileSync(keyfile, key.toString('hex'));
  writeFileSync(path, JSON.stringify(encryptStore(JSON.stringify({ SYNTHETIC: 'keep' }), key)));
  const before = readFileSync(path, 'utf8'); const prepared = f.manager.prepareScopedDeletion('SYNTHETIC', 'daemon');
  writeFileSync(keyfile, Buffer.alloc(32, 0x33).toString('hex')); writeFileSync(keyfile, key.toString('hex'));
  await expect(f.manager.applyPreparedScopedDeletion(prepared, () => {})).rejects.toThrow();
  expect(readFileSync(path, 'utf8')).toBe(before);
});
