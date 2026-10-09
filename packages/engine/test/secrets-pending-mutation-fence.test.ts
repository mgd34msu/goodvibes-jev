import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'secret-pending-fence-')); roots.push(root);
  let policy = 'plaintext_allowed';
  const manager = new SecretsManager({ projectRoot: join(root, 'project'), globalHome: join(root, 'home'), surfaceRoot: 'synthetic-fixture', configManager: { get: () => policy } as never });
  await manager.set('SYNTHETIC_FENCE_KEY', 'synthetic-old', { scope: 'user', medium: 'plaintext' });
  const path = (await manager.listDetailed()).find(row => row.key === 'SYNTHETIC_FENCE_KEY')!.path!;
  const release = await acquireCrossProcessLock(`${path}.mutation.lock`, { strictOwnership: true });
  return { manager, release, setPolicy: (value: string) => { policy = value; } };
}

test('a lock-blocked replacement fences synchronously, preserves unrelated credentials, and restores only the new value', async () => {
  const { manager, release } = await fixture();
  const pending = manager.set('SYNTHETIC_FENCE_KEY', 'synthetic-new', { scope: 'user', medium: 'plaintext' });
  try {
    expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY')).toEqual({ state: 'unsupported' });
    expect(manager.resolveLocalSecretSync('SYNTHETIC_UNRELATED_KEY')).toEqual({ state: 'absent' });
    // The old bytes remain until lock acquisition, but may no longer prove owner identity.
    expect(await manager.get('SYNTHETIC_FENCE_KEY')).toBe('synthetic-old');
  } finally { release(); await pending; }
  expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY')).toEqual({ state: 'resolved', value: 'synthetic-new' });
});

test('finishing one overlapping write cannot release the next write\'s fence', async () => {
  const { manager, release } = await fixture();
  // The project target is free; the user target stays explicitly locked.
  const first = manager.set('SYNTHETIC_FENCE_KEY', 'synthetic-first', { scope: 'project', medium: 'plaintext' });
  const second = manager.set('SYNTHETIC_FENCE_KEY', 'synthetic-second', { scope: 'user', medium: 'plaintext' });
  try {
    expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY').state).toBe('unsupported');
    await first;
    expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY').state).toBe('unsupported');
  } finally { release(); await Promise.all([first, second]); }
  expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY').state).toBe('resolved');
});

test.each(['delete', 'deleteFromScope'] as const)('a lock-blocked %s fences before acquisition', async (method) => {
  const { manager, release } = await fixture();
  const pending = method === 'delete' ? manager.delete('SYNTHETIC_FENCE_KEY') : manager.deleteFromScope('SYNTHETIC_FENCE_KEY', 'user');
  try { expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY')).toEqual({ state: 'unsupported' }); }
  finally { release(); await pending; }
  expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY')).toEqual({ state: 'absent' });
});

test('a refused pending mutation preserves stored bytes and releases its temporary fence', async () => {
  const { manager, release, setPolicy } = await fixture();
  const pending = manager.set('SYNTHETIC_FENCE_KEY', 'synthetic-refused', { scope: 'user', medium: 'plaintext' });
  const refused = pending.then(() => null, error => error as Error);
  expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY').state).toBe('unsupported');
  setPolicy('require_secure');
  release(); expect((await refused)?.message).toContain('policy changed');
  setPolicy('plaintext_allowed');
  expect(manager.resolveLocalSecretSync('SYNTHETIC_FENCE_KEY')).toEqual({ state: 'resolved', value: 'synthetic-old' });
});
