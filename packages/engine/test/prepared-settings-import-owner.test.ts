import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { SubscriptionManager, type ProviderSubscription } from '../sdk/src/platform/config/subscriptions.js';
import { decryptStore } from '../sdk/src/platform/config/secrets-keyfile.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(policy: 'plaintext_allowed' | 'require_secure' = 'plaintext_allowed') {
  const root = makeProjectTempDir('prepared-import-owner'); roots.push(root);
  const manager = new SecretsManager({ surfaceRoot: 'agent', projectRoot: join(root, 'project'), globalHome: root, policy });
  return { root, manager };
}
const token: ProviderSubscription = { provider: 'synthetic', accessToken: 'private-synthetic-token', tokenType: 'Bearer', authMode: 'oauth', overrideAmbientApiKeys: false, createdAt: 1, updatedAt: 1 };
test.each(['plaintext_allowed', 'require_secure'] as const)('opaque %s import publishes only after an authentic guarded transition', async policy => {
  const f = fixture(policy); const handle = f.manager.prepareImport([{ key: 'SYNTHETIC', value: 'private-synthetic-value', scope: 'user' }]);
  const facts = f.manager.inspectPreparedImport(handle);
  expect(JSON.stringify(facts)).not.toContain('private-synthetic-value');
  for (const destination of facts.destinations) expect(existsSync(destination.path)).toBe(false);
  const transition = f.manager.beginPreparedImport(handle); let guards = 0;
  const receipt = await f.manager.finishPreparedImport(handle, transition, () => { guards++; f.manager.assertPreparedImportTransition(handle, transition); });
  expect(receipt.status).toBe('committed'); expect(guards).toBeGreaterThanOrEqual(facts.destinations.length);
  expect(() => f.manager.assertCompletedImport(handle)).not.toThrow();
  const store = facts.destinations.find(destination => destination.tier === 'user')!;
  const parsed = JSON.parse(readFileSync(store.path, 'utf8'));
  const values = policy === 'plaintext_allowed' ? parsed.secrets : JSON.parse(decryptStore(parsed, Buffer.from(readFileSync(facts.destinations.find(destination => destination.tier === 'keyfile')!.path, 'utf8').trim(), 'hex')));
  expect(values.SYNTHETIC).toBe('private-synthetic-value');
  await expect(f.manager.finishPreparedImport(handle, transition, () => {})).rejects.toThrow();
});
test('copied handles, another native owner and a same-byte physical ABA fail before effects', async () => {
  const f = fixture(), other = fixture(); const seed = f.manager.prepareImport([{ key: 'SYNTHETIC', value: 'old', scope: 'user' }]);
  await f.manager.finishPreparedImport(seed, f.manager.beginPreparedImport(seed), () => {});
  const handle = f.manager.prepareImport([{ key: 'SYNTHETIC', value: 'new', scope: 'user' }]);
  expect(() => f.manager.assertPreparedImport({ ...handle })).toThrow(); expect(() => other.manager.assertPreparedImport(handle)).toThrow();
  const path = f.manager.inspectPreparedImport(handle).destinations[0]!.path, raw = readFileSync(path, 'utf8');
  writeFileSync(path, '{}'); writeFileSync(path, raw);
  expect(() => f.manager.beginPreparedImport(handle)).toThrow(); expect(readFileSync(path, 'utf8')).toBe(raw);
});
test('cancellation between keyfile and store leaves a truthful partial receipt and never retries', async () => {
  const f = fixture('require_secure'); const handle = f.manager.prepareImport([{ key: 'SYNTHETIC', value: 'new', scope: 'user' }]);
  const facts = f.manager.inspectPreparedImport(handle), keyfile = facts.destinations.find(destination => destination.tier === 'keyfile')!.path;
  const receipt = await f.manager.finishPreparedImport(handle, f.manager.beginPreparedImport(handle), () => { if (existsSync(keyfile)) throw new Error('cancelled'); });
  expect(receipt.status).toBe('partial'); expect(receipt.completedPaths).toEqual([keyfile]);
  expect(existsSync(facts.destinations.find(destination => destination.tier === 'user')!.path)).toBe(false);
  expect(() => f.manager.assertCompletedImport(handle)).toThrow();
});
test('credential source readset catches physical ABA without creating any local store', () => {
  const f = fixture(), plan = f.manager.prepareImport([{ key: 'SYNTHETIC', value: 'old', scope: 'user' }]);
  const path = f.manager.inspectPreparedImport(plan).destinations[0]!.path; mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, secrets: { SYNTHETIC: 'old' } }));
  const guard = f.manager.captureLocalCredentialReadset(); guard();
  const raw = readFileSync(path, 'utf8'); writeFileSync(path, '{}'); writeFileSync(path, raw); expect(guard).toThrow();
});
test('subscription import retains complete private native store and guards before publication', () => {
  const f = fixture(), path = join(f.root, 'shared', 'subscriptions.json'), manager = new SubscriptionManager(path);
  const handle = manager.prepareImport([{ kind: 'active', value: token }]);
  expect(existsSync(path)).toBe(false); expect(JSON.stringify(manager.inspectPreparedImport(handle))).not.toContain(token.accessToken);
  const transition = manager.beginPreparedImport(handle); let checks = 0;
  const receipt = manager.finishPreparedImport(handle, transition, () => { checks++; manager.assertPreparedImportTransition(handle, transition); });
  expect(receipt.status).toBe('committed'); expect(checks).toBeGreaterThanOrEqual(1); expect(manager.get(token.provider)).toEqual(token);
  expect(() => manager.assertCompletedImport(handle)).not.toThrow(); expect(() => manager.finishPreparedImport(handle, transition, () => {})).toThrow();
});
test('subscription cancellation and source ABA leave the original owning file intact', () => {
  const f = fixture(), path = join(f.root, 'subscriptions.json'), manager = new SubscriptionManager(path);
  manager.saveSubscription(token); const raw = readFileSync(path, 'utf8');
  const cancelled = manager.prepareImport([{ kind: 'active', value: { ...token, accessToken: 'new' } }]);
  const receipt = manager.finishPreparedImport(cancelled, manager.beginPreparedImport(cancelled), () => { throw new Error('cancelled'); });
  expect(receipt.status).toBe('unknown'); expect(readFileSync(path, 'utf8')).toBe(raw);
  const stale = manager.prepareImport([{ kind: 'active', value: token }]); writeFileSync(path, '{}'); writeFileSync(path, raw);
  expect(() => manager.beginPreparedImport(stale)).toThrow(); expect(readFileSync(path, 'utf8')).toBe(raw);
});
test('bulk config capture is bounded by the actual schema rather than sixteen settings', () => {
  const f = fixture(), manager = new ConfigManager({ surfaceRoot: 'agent', homeDir: f.root });
  const requests = manager.getSchema().filter(setting => setting.type === 'boolean').slice(0, 18)
    .map(setting => ({ operation: 'set' as const, key: setting.key, value: setting.default }));
  expect(requests).toHaveLength(18);
  const handle = manager.prepareSettingMutationPlan(requests), transition = manager.beginPreparedMutation(handle);
  expect(manager.inspectPreparedMutation(handle).effects).toHaveLength(18);
  expect(manager.finishPreparedMutation(handle, transition, () => manager.assertPreparedMutationTransition(handle, transition)).status).toBe('committed');
  expect(() => manager.prepareSettingMutationPlan([requests[0]!, requests[0]!])).toThrow();
});
test('one opaque secret import can clear and replace declared keys without retaining an old secret', async () => {
  const f = fixture(); const seed = f.manager.prepareImport([{ key: 'OLD', value: 'old-private-value', scope: 'user' }, { key: 'KEEP', value: 'keep-private-value', scope: 'user' }]);
  await f.manager.finishPreparedImport(seed, f.manager.beginPreparedImport(seed), () => {});
  const handle = f.manager.prepareImport([{ key: 'OLD', operation: 'delete', scope: 'user' }, { key: 'NEW', value: 'new-private-value', scope: 'user' }]);
  expect(f.manager.inspectPreparedImport(handle).items.map(item => item.configured)).toEqual([false, true]);
  const receipt = await f.manager.finishPreparedImport(handle, f.manager.beginPreparedImport(handle), () => {});
  expect(receipt.status).toBe('committed');
  const path = f.manager.inspectPreparedImport(handle).destinations[0]!.path;
  expect(JSON.parse(readFileSync(path, 'utf8')).secrets).toEqual({ KEEP: 'keep-private-value', NEW: 'new-private-value' });
});
test('scoped user clear removes its native file while preserving a nested project copy', async () => {
  const f = fixture();
  const user = f.manager.prepareImport([{ key: 'SYNTHETIC', value: 'user-private-value', scope: 'user' }]);
  await f.manager.finishPreparedImport(user, f.manager.beginPreparedImport(user), () => {});
  const freshProject = f.manager.prepareImport([{ key: 'SYNTHETIC', value: 'project-private-value', scope: 'project' }]);
  await f.manager.finishPreparedImport(freshProject, f.manager.beginPreparedImport(freshProject), () => {});
  const userPath = f.manager.inspectPreparedImport(user).destinations[0]!.path, projectPath = f.manager.inspectPreparedImport(freshProject).destinations[0]!.path;
  const deletion = f.manager.prepareScopedDeletion('SYNTHETIC', 'user');
  expect((await f.manager.applyPreparedScopedDeletion(deletion, () => {})).status).toBe('committed');
  expect(JSON.parse(readFileSync(userPath, 'utf8')).secrets.SYNTHETIC).toBeUndefined();
  expect(JSON.parse(readFileSync(projectPath, 'utf8')).secrets.SYNTHETIC).toBe('project-private-value');
});
test('an absent clear and a new opaque value share one captured destination without stale duplicates', async () => {
  const f = fixture(), handle = f.manager.prepareImport([{ key: 'MISSING', operation: 'delete', scope: 'user' }, { key: 'NEW', value: 'new-private-value', scope: 'user' }]);
  const receipt = await f.manager.finishPreparedImport(handle, f.manager.beginPreparedImport(handle), () => {});
  expect(receipt.status).toBe('committed'); expect(() => f.manager.assertCompletedImport(handle)).not.toThrow();
});
