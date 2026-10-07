import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSecretInput } from '../sdk/src/platform/config/secret-refs.js';
import { ServiceRegistry } from '../sdk/src/platform/config/service-registry.js';
import { SecretsManager } from '../sdk/src/platform/config/secrets.js';
import { SubscriptionManager } from '../sdk/src/platform/config/subscriptions.js';
import { logger } from '../sdk/src/platform/utils/logger.js';

const sentinel = 'OWNED_PRIVATE_PROVIDER_SOURCE_7D6EA2';
const roots: string[] = [];
const undo: Array<() => void> = [];
afterEach(() => { for (const restore of undo.splice(0)) restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'delivery-credential-diagnostics-')); roots.push(root);
  const file = join(root, 'owned-reference.json');
  writeFileSync(file, `{"token": ${sentinel}}`);
  const ref = { source: 'file' as const, path: file, selector: 'token' };
  const logs: unknown[][] = [];
  for (const level of ['info', 'warn', 'error'] as const) {
    const mocked = spyOn(logger, level).mockImplementation((...args) => { logs.push(args); });
    undo.push(() => mocked.mockRestore());
  }
  return { root, ref, logs };
}
function secrets(root: string, diagnosticMode: 'default' | 'structural') {
  return new SecretsManager({ projectRoot: root, globalHome: root, daemonHome: join(root, 'daemon'),
    surfaceRoot: 'daemon', diagnosticMode });
}
for (const mode of ['default', 'structural'] as const) {
  test(`direct resolver ${mode} diagnostics retain resolution behavior`, async () => {
    const { root, ref, logs } = fixture();
    expect(await resolveSecretInput(ref, { homeDirectory: root, diagnosticMode: mode })).toBeNull();
    const published = JSON.stringify(logs);
    if (mode === 'structural') {
      expect(published).not.toContain(sentinel);
      expect(published).not.toContain('owned-reference.json');
      expect(published).toContain('resolution-failed');
    } else expect(published).toContain(sentinel);
  });
  test(`registry ${mode} diagnostics preserve null resolution without a raw provider error`, async () => {
    const { root, ref, logs } = fixture();
    const file = join(root, 'services.json');
    writeFileSync(file, JSON.stringify({ ntfy: { authType: 'bearer', tokenRef: ref } }));
    const registry = new ServiceRegistry(file, { secretsManager: secrets(root, mode),
      subscriptionManager: new SubscriptionManager(join(root, 'subscriptions.json')), diagnosticMode: mode });
    expect(await registry.resolveSecret('ntfy', 'primary')).toBeNull();
    const published = JSON.stringify(logs);
    if (mode === 'structural') { expect(published).not.toContain(sentinel); expect(published).toContain('resolution-failed'); }
    else expect(published).toContain(sentinel);
  });
  test(`secret store ${mode} diagnostics keep unvalidated envelope text private`, async () => {
    const { root, logs } = fixture();
    const file = join(root, 'owned-unreadable-store.json');
    writeFileSync(file, JSON.stringify({ version: sentinel, iv: 'owned', tag: 'owned', data: 'owned' }));
    const manager = new SecretsManager({ projectRoot: root, globalHome: root, daemonHome: join(root, 'daemon'),
      surfaceRoot: 'daemon', secureDaemonFilePath: file, diagnosticMode: mode });
    expect(await manager.get('owned-missing-key')).toBeNull();
    const published = JSON.stringify(logs);
    if (mode === 'structural') { expect(published).not.toContain(sentinel); expect(published).toContain('secret store could not be read'); }
    else expect(published).toContain(sentinel);
  });
}
test('nested secret references use the same structural read owner', async () => {
  const { root, ref, logs } = fixture();
  const file = join(root, 'owned-plain-store.json');
  writeFileSync(file, JSON.stringify({ 'owned-nested-key': `secretref:${JSON.stringify(ref)}` }));
  const manager = new SecretsManager({ projectRoot: root, globalHome: root, daemonHome: join(root, 'daemon'),
    surfaceRoot: 'daemon', plaintextDaemonFilePath: file, diagnosticMode: 'structural' });
  expect(await manager.get('owned-nested-key')).toBeNull();
  expect(JSON.stringify(logs)).not.toContain(sentinel);
  expect(JSON.stringify(logs)).toContain('resolution-failed');
});
test('malformed reference diagnostics withhold a borrowed hostname', async () => {
  const { logs } = fixture();
  expect(await resolveSecretInput(`goodvibes://${sentinel}/`, { diagnosticMode: 'structural' })).toBeNull();
  expect(JSON.stringify(logs)).not.toContain(sentinel);
  expect(JSON.stringify(logs)).toContain('unparseable secret reference');
});
