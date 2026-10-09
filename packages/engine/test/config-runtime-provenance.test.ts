import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { createDaemonSystemRouteHandlers } from '../daemon-sdk/src/system-routes.ts';
import { buildPermissionProvenance } from '../sdk/src/platform/gate/policy/permissions-provenance.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-provenance-')); roots.push(root);
  return new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon.json') });
}

test('a successful config route write reports persisted origin after retiring invocation authority', async () => {
  const config = fixture();
  config.setRuntimeOverride('surfaces.email.host', 'cli.example.test');
  const handlers = createDaemonSystemRouteHandlers({
    configManager: config, requireAdmin: () => null, isValidConfigKey: () => true,
    parseJsonBody: async () => ({ key: 'surfaces.email.host', value: 'disk.example.test' }),
  } as never);
  const response = await handlers.postConfig(new Request('http://127.0.0.1/config', { method: 'POST' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, value: 'disk.example.test', tier: 'daemon', effectiveOrigin: 'daemon', daemonOwned: true, persistedTo: config.getDaemonTierPath() });
  config.load(); expect(config.get('surfaces.email.host')).toBe('disk.example.test');
});

test('permission provenance uses the accepted source after a failed load rather than mislabeling disk changes', () => {
  const config = fixture();
  config.set('permissions.mode', 'plan');
  mkdirSync(dirname(config.getConfigPath()), { recursive: true });
  writeFileSync(config.getConfigPath(), JSON.stringify({ permissions: { mode: 'allow-all' } }));
  writeFileSync(config.getDaemonTierPath()!, '{invalid');
  expect(() => config.load()).toThrow();
  const row = buildPermissionProvenance(config).rows.find(entry => entry.key === 'permissions.mode')!;
  expect(row).toMatchObject({ value: 'plan', origin: 'global config file', recorded: true, overridden: false, recordedValue: 'plan' });
  config.setRuntimeOverride('permissions.mode', 'plan');
  expect(buildPermissionProvenance(config).rows.find(entry => entry.key === 'permissions.mode')).toMatchObject({ value: 'plan', recorded: false, overridden: true });
});
