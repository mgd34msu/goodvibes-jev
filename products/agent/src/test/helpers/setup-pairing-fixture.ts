/** Owned loopback peer for tests of the Agent's real pairing core and store. */
import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from './project-temp.ts';

export async function untilPairing(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(2);
  }
}

export function setupPairingFixture(options: { holdAuth?: number; holdMigration?: boolean } = {}) {
  const environmentKeys = ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN'] as const;
  const saved = environmentKeys.map(key => process.env[key]);
  for (const key of environmentKeys) delete process.env[key];
  const homeDirectory = makeProjectTempDir('interactive-pairing');
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: join(homeDirectory, '.goodvibes', 'agent'), workingDir: homeDirectory, homeDir: homeDirectory });
  const bootstrap = 'synthetic-interactive-pairing-bootstrap';
  const minted = 'gvp_' + 'e'.repeat(32);
  const id = 'pair-12345678-1234-1234-1234-123456789abc';
  const tokenPath = join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  const legacy = JSON.stringify({ token: bootstrap });
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(tokenPath, legacy);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let authCalls = 0;
  let migrations = 0;
  let held = false;
  let returned = 0;
  const names: string[] = [];
  const unexpected: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const authorization = request.headers.get('authorization');
    if (path === '/api/control-plane/auth') {
      authCalls++;
      if (options.holdAuth === authCalls) { held = true; await gate; }
      const isPaired = authorization === `Bearer ${minted}`;
      returned++;
      return Response.json({ authenticated: authorization === `Bearer ${bootstrap}` || isPaired,
        authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
        principalId: isPaired ? `pairing:${id}` : 'shared-token', principalKind: 'token', admin: true, scopes: ['*'], roles: [] });
    }
    if (path === '/api/control-plane/methods/pairing.tokens.migrate/invoke' && request.method === 'POST') {
      if (authorization !== `Bearer ${bootstrap}`) { unexpected.push('invalid migration authority'); return new Response('unauthorized', { status: 401 }); }
      const body = await request.json() as { body: { name: string } };
      names.push(body.body.name); migrations++;
      if (options.holdMigration) { held = true; await gate; }
      returned++;
      return Response.json({ token: { token: minted, id, name: body.body.name, createdAt: Date.now() } });
    }
    unexpected.push(`${request.method} ${path}`);
    return new Response('Unexpected fixture request', { status: 404 });
  } });
  configManager.set('controlPlane.host', '127.0.0.1');
  configManager.set('controlPlane.port', server.port!);
  configManager.set('daemon.connectedHost.enabled', true);
  return {
    homeDirectory, configManager, host: server.url.origin, release,
    options: { homeDirectory, configManager },
    migrations: () => migrations, authCalls: () => authCalls, names: () => names,
    held: () => held, returned: () => returned,
    assertPrivateOutput(output: string) {
      expect(output).not.toContain(bootstrap);
      expect(output).not.toContain(minted);
      expect(output).not.toContain('gvp_');
      expect(readFileSync(tokenPath, 'utf8')).toBe(legacy);
    },
    async stop() {
      release();
      await server.stop(true);
      for (const [index, key] of environmentKeys.entries()) {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      }
      expect(unexpected).toEqual([]);
    },
  };
}
