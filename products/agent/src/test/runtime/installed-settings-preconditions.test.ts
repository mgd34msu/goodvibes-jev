/** Real installed-client and loopback transport; synthetic server owner and credentials only. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createSettingsPreconditionHandler, createDaemonSystemRouteHandlers } from '@goodvibes-jev/engine/daemon-sdk';
import { createDaemonConfigClient } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { launchSettingsHttpHost } from '../helpers/settings-http-host.ts';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function fixture() {
  const home = makeProjectTempDir('installed-settings'); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  for (const name of ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN']) {
    const previous = process.env[name]; delete process.env[name]; cleanup.push(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const token = 'synthetic-installed-settings'; const tokenPath = connectedHostOperatorTokenPath(home);
  mkdirSync(dirname(tokenPath), { recursive: true }); writeFileSync(tokenPath, JSON.stringify({ token }));
  let lifetime: object | null = {}; let incarnation = 0; let effects = 0; let current: unknown = 1; let deny = false;
  const service = createSettingsPreconditionHandler({ lifetime: () => lifetime, captureAuthority: () => token,
    withAuthority: (_req, captured, operation) => { const assertCurrent = () => { if (deny || captured !== token) throw new Error('denied'); }; assertCurrent(); return operation(assertCurrent); },
    owner: {
      prepare: request => ({ ...request, value: request.operation === 'reset-default' ? 3421 : Number(request.value), incarnation }),
      inspect: prepared => ({ ...prepared, destinations: [{ path: '/synthetic/settings.json', operation: 'set' as const, tier: 'daemon' }] }),
      assert: prepared => { if (prepared.incarnation !== incarnation) throw new Error('stale'); },
      begin: () => ++incarnation,
      assertTransition: (_prepared, transition) => { if (transition !== incarnation) throw new Error('stale'); },
      finish: prepared => { current = prepared.value; effects++; return { status: 'committed' as const, completedPaths: ['/synthetic/settings.json'], verifiedInOwningStore: true }; },
    } });
  const handlers = createDaemonSystemRouteHandlers({ settingsPrecondition: service,
    requireAdmin: (req: Request) => deny || req.headers.get('authorization') !== `Bearer ${token}` ? new Response('', { status: 403 }) : null,
    parseJsonBody: (req: Request) => req.json(), configManager: {}, isValidConfigKey: () => true } as never);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => new URL(req.url).pathname === '/config' ? await handlers.postConfig(req) : new Response('', { status: 404 }) });
  cleanup.push(() => { server.stop(true); });
  const manager = new ConfigManager({ configDir: join(home, 'config'), daemonTierPath: join(home, 'client-daemon.json') });
  manager.setDynamic('controlPlane.host', '127.0.0.1'); manager.setDynamic('controlPlane.port', server.port!);
  let calls = 0; let responseHook = () => {}; const urls: string[] = [];
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => { calls++; urls.push(String(args[0])); const result = await fetch(...args); responseHook(); return result; }) as typeof fetch;
  const verbs = createAgentDaemonVerbCaller({ configManager: manager, homeDirectory: home, fetchImpl });
  const client = createDaemonConfigClient(verbs);
  return { manager, tokenPath, client, verbs, capability: client.preparedSettings!, calls: () => calls, urls, effects: () => effects, current: () => current,
    deny: () => { deny = true; }, restart: () => { lifetime = {}; }, onResponse: (hook: () => void) => { responseHook = hook; } };
}
for (const operation of ['set', 'reset-default'] as const) test(`installed prepared ${operation} uses exact connection and one owner reference`, async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation, key: 'controlPlane.port', ...(operation === 'set' ? { value: '4567' } : {}) });
  expect(f.capability.inspect(prepared).value).toBe(operation === 'set' ? 4567 : 3421);
  expect((await f.capability.apply(prepared)).status).toBe('committed');
  expect(f.current()).toBe(operation === 'set' ? 4567 : 3421); expect(f.urls.every(url => url.endsWith('/config'))).toBe(true);
  await expect(f.capability.apply(prepared)).rejects.toThrow(); expect(f.effects()).toBe(1); expect(f.calls()).toBe(2);
});
for (const change of ['configABA', 'tokenFileABA', 'disable', 'restart', 'deny'] as const) test(`installed ${change} refuses before persistence`, async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation: 'set', key: 'controlPlane.port', value: 4567 });
  if (change === 'configABA') { const old = f.manager.get('controlPlane.port'); f.manager.setDynamic('controlPlane.port', 4321); f.manager.setDynamic('controlPlane.port', old); }
  else if (change === 'tokenFileABA') { const raw = readFileSync(f.tokenPath, 'utf8'); writeFileSync(`${f.tokenPath}.replacement`, raw); renameSync(`${f.tokenPath}.replacement`, f.tokenPath); }
  else if (change === 'disable') f.manager.setDynamic('daemon.connectedHost.enabled', false);
  else f[change]();
  if (change === 'restart' || change === 'deny') expect((await f.capability.apply(prepared)).status).toBe('unknown');
  else { await expect(f.capability.apply(prepared)).rejects.toThrow(); expect(f.calls()).toBe(1); }
  expect(f.effects()).toBe(0);
});
test('capture response cannot install a handle after connection replacement', async () => {
  const f = fixture(); f.onResponse(() => { const port = f.manager.get('controlPlane.port'); f.manager.setDynamic('controlPlane.port', 4567); f.manager.setDynamic('controlPlane.port', port); });
  await expect(f.capability.capture({ operation: 'set', key: 'controlPlane.port', value: 4567 })).rejects.toThrow();
  expect(f.calls()).toBe(1); expect(f.effects()).toBe(0);
});
test('expired installed capture does not send an apply or change destination', async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation: 'set', key: 'controlPlane.port', value: 4567 });
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001); cleanup.push(() => clock.mockRestore());
  await expect(f.capability.apply(prepared)).rejects.toThrow(); expect(f.calls()).toBe(1); expect(f.effects()).toBe(0);
  clock.mockRestore();
  await expect(f.capability.apply(prepared)).rejects.toThrow(); expect(f.calls()).toBe(1);
});
test('response loss reports unknown after one effect, never retries', async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation: 'set', key: 'controlPlane.port', value: 4567 });
  f.onResponse(() => { throw new Error('synthetic response lost'); });
  expect((await f.capability.apply(prepared)).status).toBe('unknown'); await expect(f.capability.apply(prepared)).rejects.toThrow();
  expect(f.effects()).toBe(1); expect(f.calls()).toBe(2);
});
test('client capabilities cannot exchange handles or fall back to legacy transport', async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation: 'set', key: 'controlPlane.port', value: 4567 });
  const other = createDaemonConfigClient(f.verbs).preparedSettings!;
  expect(() => other.assertCurrent(prepared)).toThrow(); expect(() => f.capability.assertCurrent({ ...prepared })).toThrow();
  expect(createDaemonConfigClient({ probe: () => ({ available: true }), invoke: async () => { throw new Error('never'); } }).preparedSettings).toBeUndefined();
  expect(f.calls()).toBe(1); expect(f.effects()).toBe(0);
});


test('actual Agent connection reaches the separate real serving ConfigManager through the same precondition protocol', async () => {
  const root = makeProjectTempDir('installed-real-settings'); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  for (const name of ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN']) {
    const previous = process.env[name]; delete process.env[name]; cleanup.push(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const child = launchSettingsHttpHost(root, 'normal'); cleanup.push(() => child.stop());
  const serving = await child.ready(); const endpoint = new URL(serving.baseUrl);
  const path = connectedHostOperatorTokenPath(home); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ token: serving.token }), { mode: 0o600 });
  const manager = new ConfigManager({ configDir: join(root, 'client'), daemonTierPath: join(root, 'client-daemon.json') });
  manager.setDynamic('controlPlane.host', endpoint.hostname); manager.setDynamic('controlPlane.port', Number(endpoint.port));
  const capability = createDaemonConfigClient(createAgentDaemonVerbCaller({ configManager: manager, homeDirectory: home })).preparedSettings!;
  const prepared = await capability.capture({ operation: 'set', key: 'controlPlane.port', value: 4567 });
  expect(capability.inspect(prepared).value).toBe(4567);
  expect((await capability.apply(prepared)).status).toBe('committed'); expect(serving.config.get('controlPlane.port')).toBe(4567);
  const reset = await capability.capture({ operation: 'reset-default', key: 'controlPlane.port' });
  expect((await capability.apply(reset)).status).toBe('committed');
  expect(serving.config.get('controlPlane.port')).toBe(serving.config.getSchema()[0]!.default);
  expect(manager.get('controlPlane.port')).toBe(Number(endpoint.port));
  expect(await serving.counts()).toEqual({ captures: 2, applies: 2 });
});
