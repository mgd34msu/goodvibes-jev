import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { GatewayMethodCatalog, grantedGatewayScopes, type GatewayMethodDescriptor } from '../sdk/src/platform/control-plane/method-catalog.js';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const method = (id = 'synthetic.write', scopes = ['write:synthetic']): GatewayMethodDescriptor => ({
  id, title: 'Synthetic method', description: 'Synthetic scope fixture', category: 'fixture', source: 'plugin', pluginId: 'synthetic-plugin',
  access: 'admin', transport: ['http'], scopes, http: { method: 'POST', path: '/synthetic' },
});
const handler = () => ({ ok: true });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-catalog-owner-')); dirs.push(dir);
  const options = { configDir: dir, surfaceRoot: 'daemon' };
  const config = new ConfigManager(options); const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  const remove = catalog.register(method(), handler);
  const owner = catalog.attachScopePolicyOwner(() => config.invalidateExternalPolicy());
  const revision = () => createHash('sha256').update(JSON.stringify([config.getDurableConfigurationIncarnation(), owner.current().revision])).digest('hex');
  const capture = () => { config.captureDurableConfigurationIncarnation(); return revision(); };
  return { dir, options, config, catalog, owner, remove, capture, revision };
}

test('initial catalog construction and unchanged restart preserve durable scope ownership', () => {
  const f = fixture(); const before = f.capture(); const disk = readFileSync(`${f.config.getConfigPath()}.policy-epoch.json`, 'utf8');
  const nextConfig = new ConfigManager(f.options); const nextCatalog = new GatewayMethodCatalog({ includeBuiltins: false });
  nextCatalog.register(method(), handler);
  const nextOwner = nextCatalog.attachScopePolicyOwner(() => nextConfig.invalidateExternalPolicy());
  const after = createHash('sha256').update(JSON.stringify([nextConfig.getDurableConfigurationIncarnation(), nextOwner.current().revision])).digest('hex');
  expect(after).toBe(before);
  expect(readFileSync(`${f.config.getConfigPath()}.policy-epoch.json`, 'utf8')).toBe(disk);
});

test('removal and re-addition cannot revive a durable grant across restart', () => {
  const f = fixture(); const before = f.capture(); const catalogBefore = f.owner.current().revision;
  f.catalog.unregister('synthetic.write'); f.catalog.register(method(), handler);
  expect(f.owner.current().revision).toBe(catalogBefore); expect(f.revision()).not.toBe(before);
  const restarted = new ConfigManager(f.options);
  expect(restarted.getDurableConfigurationIncarnation()).toBe(f.config.getDurableConfigurationIncarnation());
  expect(createHash('sha256').update(JSON.stringify([restarted.getDurableConfigurationIncarnation(), catalogBefore])).digest('hex')).not.toBe(before);
});

test('same-name source replacement revokes even when its scope union is unchanged', () => {
  const f = fixture(); const before = f.capture(); const scopes = f.owner.current().scopes;
  f.catalog.register({ ...method(), pluginId: 'replacement-plugin' }, handler, { replace: true });
  expect(f.owner.current().scopes).toEqual(scopes); expect(f.revision()).not.toBe(before);
});

test('old registration teardown cannot remove or invalidate a successor with the same source metadata', () => {
  const f = fixture(); f.capture(); const removeSuccessor = f.catalog.register(method(), handler, { replace: true });
  const current = f.revision(); f.remove();
  expect(f.catalog.get('synthetic.write')).not.toBeNull(); expect(f.revision()).toBe(current);
  removeSuccessor(); expect(f.catalog.get('synthetic.write')).toBeNull(); expect(f.revision()).not.toBe(current);
});

test('plugin cleanup owns method and event scope removal in one pre-effect transition', () => {
  const f = fixture();
  f.catalog.registerEvent({ id: 'synthetic.event', title: 'Fixture', description: 'Fixture', category: 'fixture', source: 'plugin',
    pluginId: 'synthetic-plugin', transport: ['ws'], scopes: ['read:synthetic-event'] });
  f.capture(); const before = f.config.getConfigurationIncarnation();
  f.catalog.clearPluginMethods('synthetic-plugin');
  expect(f.config.getConfigurationIncarnation()).toBe(before + 1);
  expect(f.catalog.get('synthetic.write')).toBeNull(); expect(f.catalog.getEvent('synthetic.event')).toBeNull();
  expect(f.owner.current().scopes).not.toContain('write:synthetic'); expect(f.owner.current().scopes).not.toContain('read:synthetic-event');
});

test('returned descriptors and borrowed input arrays cannot bypass scope mutation ownership', () => {
  const f = fixture(); const scopes = ['write:one']; const input = method('synthetic.mutable', scopes);
  f.catalog.register(input, handler); const before = f.capture(); scopes.push('write:unrequested');
  expect(() => (f.catalog.get(input.id)!.scopes as string[]).push('write:forged')).toThrow();
  expect(() => { (f.catalog.get(input.id)! as { access: string }).access = 'public'; }).toThrow();
  expect(() => { (f.catalog.get(input.id)!.http! as { path: string }).path = '/unowned'; }).toThrow();
  expect(f.revision()).toBe(before); expect(f.owner.current().scopes).not.toContain('write:unrequested');
});

test('clean retirement preserves durable history and older graph teardown cannot invalidate a successor graph', () => {
  const f = fixture(); f.capture(); const before = f.config.getDurableConfigurationIncarnation();
  const successorCatalog = new GatewayMethodCatalog({ includeBuiltins: false }); successorCatalog.register(method(), handler);
  const successor = successorCatalog.attachScopePolicyOwner(() => f.config.invalidateExternalPolicy());
  f.owner.close(); f.remove(); f.owner.close();
  expect(() => f.owner.current()).toThrow(); expect(f.config.getDurableConfigurationIncarnation()).toBe(before);
  expect(() => f.catalog.attachScopePolicyOwner(() => f.config.invalidateExternalPolicy())).toThrow('retired');
  expect(successor.current().scopes).toContain('write:synthetic');
  expect(new ConfigManager(f.options).getDurableConfigurationIncarnation()).toBe(before);
});

test('failed durable scope mutation never changes the registered source or allows stale live ownership', () => {
  const f = fixture(); f.capture();
  const write = spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(() => { throw new Error('synthetic scope persistence failure'); });
  try { expect(() => f.catalog.unregister('synthetic.write')).toThrow(); } finally { write.mockRestore(); }
  expect(f.catalog.get('synthetic.write')).not.toBeNull(); expect(() => f.config.getDurableConfigurationIncarnation()).toThrow();
});

test('ambiguous owner lock prevents scope mutation before effects', () => {
  const f = fixture(); f.capture(); mkdirSync(`${f.config.getConfigPath()}.policy-epoch.json.owner-lock`);
  expect(() => f.catalog.register(method('synthetic.other'), handler)).toThrow();
  expect(f.catalog.get('synthetic.other')).toBeNull();
});

test('async and reentrant mutation preconditions cannot change scope state', () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register(method(), handler);
  const owner = catalog.attachScopePolicyOwner(() => { catalog.unregister('synthetic.write'); });
  expect(() => catalog.register(method('synthetic.other'), handler)).toThrow('reentrant');
  expect(catalog.get('synthetic.write')).not.toBeNull(); expect(catalog.get('synthetic.other')).toBeNull();
  expect(() => owner.current()).not.toThrow();
  const asyncCatalog = new GatewayMethodCatalog({ includeBuiltins: false });
  asyncCatalog.attachScopePolicyOwner((async () => {}) as () => void);
  expect(() => asyncCatalog.register(method(), handler)).toThrow('synchronous'); expect(asyncCatalog.get('synthetic.write')).toBeNull();
});

test('ordinary catalog behavior needs no durable configuration and granted-scope utility preserves transport ceiling', () => {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false }); catalog.register(method(), handler);
  expect(grantedGatewayScopes(catalog, false)).toEqual(['read:control-plane', 'read:events', 'read:telemetry']);
  expect(grantedGatewayScopes(catalog, true)).toEqual(['read:control-plane', 'read:events', 'read:telemetry', 'read:telemetry-sensitive', 'write:control-plane', 'write:synthetic']);
  expect(catalog.unregister('synthetic.write')).toBe(true);
});
