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

test('a retired caller queued on the real store lock cannot persist a credential', async () => {
  const { manager, release } = await fixture();
  const before = manager.getCredentialMutationState();
  let active = true;
  const pending = manager.set('SYNTHETIC_FENCE_KEY', 'synthetic-never-persist', {
    scope: 'user', medium: 'plaintext', assertCurrent: () => { if (!active) throw new Error('caller retired'); },
  });
  const refused = pending.then(() => null, error => error as Error);
  expect(manager.getCredentialMutationState()).toEqual({ generation: before.generation + 1, pending: true });
  active = false; release();
  expect((await refused)?.message).toBe('caller retired');
  expect(await manager.get('SYNTHETIC_FENCE_KEY')).toBe('synthetic-old');
  // Existing pre-effect/settlement invalidation remains intact; there was no
  // successful write and no extra synthetic generation beyond that pair.
  expect(manager.getCredentialMutationState()).toEqual({ generation: before.generation + 2, pending: false });
});

test('an exact write transition survives only its own pre-lock intent and settlement', async () => {
  const { manager, release } = await fixture();
  let token: import('../sdk/src/platform/config/secrets.js').SecretWriteTransition | undefined;
  let receipt = false;
  const before = manager.getCredentialMutationState().generation;
  const pending = manager.set('SYNTHETIC_FENCE_KEY', 'synthetic-exact', { scope: 'user', medium: 'plaintext', effect: transition => {
    token = transition;
    expect(manager.inspectWriteTransition(transition)).toMatchObject({ key: 'SYNTHETIC_FENCE_KEY', phase: 'prepared', beforeGeneration: before });
    return { assertCurrent: () => manager.assertWriteTransition(transition), committed: () => {
      expect(manager.inspectWriteTransition(transition).phase).toBe('committed'); receipt = true;
    } };
  } });
  expect(token).toBeDefined();
  expect(manager.inspectWriteTransition(token!).phase).toBe('pending');
  expect(() => manager.assertWriteTransition({ ...token! })).toThrow('not authentic');
  release(); await pending;
  expect(receipt).toBe(true); expect(await manager.get('SYNTHETIC_FENCE_KEY')).toBe('synthetic-exact');
  expect(manager.getCredentialMutationState()).toEqual({ generation: before + 2, pending: false });
});

test('a reentrant intent listener cannot hide a competing credential mutation in an exact write', async () => {
  const { manager, release } = await fixture();
  let competitor: Promise<void> | undefined, entered = false, receipt = false;
  const unsubscribe = manager.onDidInvalidateCredentials(() => {
    if (!entered && manager.getCredentialMutationState().pending) {
      entered = true; competitor = manager.set('SYNTHETIC_OTHER', 'synthetic-other', { scope: 'project', medium: 'plaintext' });
    }
  });
  const pending = manager.set('SYNTHETIC_FENCE_KEY', 'synthetic-refused', { scope: 'user', medium: 'plaintext', effect: token => ({
    assertCurrent: () => manager.assertWriteTransition(token), committed: () => { receipt = true; },
  }) });
  const refused = pending.then(() => null, error => error);
  release(); expect(await refused).toBeInstanceOf(Error); unsubscribe(); await competitor;
  expect(receipt).toBe(false); expect(await manager.get('SYNTHETIC_FENCE_KEY')).toBe('synthetic-old');
  expect(await manager.get('SYNTHETIC_OTHER')).toBe('synthetic-other');
});
