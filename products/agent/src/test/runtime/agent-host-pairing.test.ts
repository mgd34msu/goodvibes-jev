import { resolveDaemonOperatorConnection } from '../../agent/daemon-operator-client.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { previewAgentHostPairing } from '../../runtime/agent-host-pairing.ts';
import { readAgentHostPairing, beginAgentHostPairing } from '../../runtime/connected-host-pairing-store.ts';
import { readConnectedHostOperatorToken } from '../../runtime/connected-host-auth.ts';
import { resolveAgentConnectedHostConnection } from '../../agent/routine-schedule-promotion.ts';
import { createSpineConnectionResolver } from '../../runtime/session-spine-rest-transport.ts';
import { resolveConnectedHostConnection } from '../../runtime/client/daemon-verbs.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const shared = 'gv_synthetic_legacy_secret';
const minted = 'gvp_' + 's'.repeat(32);
const tokenId = 'pair-12345678-1234-1234-1234-123456789abc';
const envNames = ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN'] as const;
let savedEnv: (string | undefined)[] = [];
afterEach(() => { for (const [i, key] of envNames.entries()) { if (savedEnv[i] === undefined) delete process.env[key]; else process.env[key] = savedEnv[i]; } });

function fixture(options: { mutate?: () => void; migrationResponse?: () => Response | Promise<Response>; authStatus?: 'shared' | 'paired' | 'non-admin'; rejectMintedAuth?: boolean; } = {}) {
  savedEnv = envNames.map(key => process.env[key]); for (const key of envNames) delete process.env[key];
  const homeDirectory = makeProjectTempDir('agent-pairing');
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: join(homeDirectory, '.goodvibes', 'agent'), workingDir: homeDirectory, homeDir: homeDirectory });
  let authStatus = options.authStatus ?? 'shared'; let migrations = 0; const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname; requests.push(path);
    const token = request.headers.get('authorization')?.replace('Bearer ', '');
    if (path === '/api/control-plane/auth') return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false,
      principalId: token === minted || authStatus === 'paired' ? `pairing:${tokenId}` : 'shared-token', principalKind: 'token', admin: authStatus !== 'non-admin' && !(options.rejectMintedAuth && token === minted), scopes: ['*'], roles: [] });
    if (path === '/api/control-plane/methods/pairing.tokens.migrate/invoke' && request.method === 'POST') {
      migrations++; expect(token).toBe(shared);
      const body = await request.json() as { body: { name: string } };
      options.mutate?.();
      return options.migrationResponse?.() ?? Response.json({ token: { token: minted, id: tokenId, name: body.body.name, createdAt: Date.now() } });
    }
    return new Response('No fixture route', { status: 404 });
  } });
  configManager.set('controlPlane.host', '127.0.0.1'); configManager.set('controlPlane.port', server.port!); configManager.set('daemon.connectedHost.enabled', true);
  const tokenPath = join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'); mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: shared }));
  return { configManager, homeDirectory, tokenPath, server, host: server.url.origin, requests, get migrations() { return migrations; }, set authStatus(value: typeof authStatus) { authStatus = value; }, close: () => server.stop(true) };
}

async function confirm(f: ReturnType<typeof fixture>, name?: string) {
  const preview = await previewAgentHostPairing(f, name);
  expect(preview.result.status).toBe('preview');
  return preview.confirm!(preview.result.confirmation!);
}

describe('explicit Agent host pairing', () => {
  test('preview and incorrect confirmation have no writes or migration; confirmed action is one-shot and host-bound', async () => {
    const f = fixture(); try {
      const original = readFileSync(f.tokenPath, 'utf8');
      const preview = await previewAgentHostPairing(f, '  Agent laptop  ');
      expect(preview.result.status).toBe('preview'); expect(preview.result.scopeDisclosure).toContain('administrative');
      expect(JSON.stringify(preview)).not.toContain(shared);
      expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('missing'); expect(f.migrations).toBe(0);
      expect((await preview.confirm!('yes')).status).toBe('cancelled'); expect(f.migrations).toBe(0);
      expect((await preview.confirm!(preview.result.confirmation!)).status).toBe('paired');
      expect((await preview.confirm!(preview.result.confirmation!)).status).toBe('cancelled');
      expect(f.migrations).toBe(1);
      expect(readFileSync(f.tokenPath, 'utf8')).toBe(original);
      expect(readConnectedHostOperatorToken(f.homeDirectory, f.host).token).toBe(minted);
      expect(readConnectedHostOperatorToken(f.homeDirectory, 'http://127.0.0.1:1').token).toBe(shared);
      expect(resolveConnectedHostConnection(f)).toMatchObject({ baseUrl: f.host, token: minted });
      expect(resolveAgentConnectedHostConnection(f.configManager, f.homeDirectory)).toMatchObject({ baseUrl: f.host, token: minted });
      expect(resolveDaemonOperatorConnection(f.configManager, f.homeDirectory)).toMatchObject({ baseUrl: f.host, token: minted });
      expect(createSpineConnectionResolver(f.configManager, f.homeDirectory)()).toMatchObject({ baseUrl: f.host, token: minted });
      expect((await previewAgentHostPairing(f)).result.status).toBe('already-paired'); expect(f.migrations).toBe(1);
    } finally { f.close(); }
  });

  for (const change of ['host', 'token', 'environment', 'store', 'revocation', 'disabled'] as const) {
    test(`confirmation refuses changed ${change} without migrating`, async () => {
      const f = fixture(); try {
        const p = await previewAgentHostPairing(f);
        if (change === 'host') f.configManager.set('controlPlane.port', 1);
        if (change === 'token') writeFileSync(f.tokenPath, JSON.stringify({ token: 'different' }));
        if (change === 'environment') process.env.GOODVIBES_CONNECTED_HOST_TOKEN = 'different';
        if (change === 'store') await beginAgentHostPairing(f.homeDirectory, f.host, { attemptId: 'other-attempt', name: 'Other', startedAt: Date.now() });
        if (change === 'revocation') f.authStatus = 'non-admin';
        if (change === 'disabled') f.configManager.set('daemon.connectedHost.enabled', false);
        expect((await p.confirm!(p.result.confirmation!)).status).toBe('changed'); expect(f.migrations).toBe(0);
      } finally { f.close(); }
    });
  }

  test('independent previews race to exactly one migration', async () => {
    const f = fixture(); try {
      const [a, b] = await Promise.all([previewAgentHostPairing(f), previewAgentHostPairing(f)]);
      const results = await Promise.all([a.confirm!(a.result.confirmation!), b.confirm!(b.result.confirmation!)]);
      expect(results.filter(result => result.status === 'paired')).toHaveLength(1); expect(f.migrations).toBe(1);
    } finally { f.close(); }
  });

  for (const response of ['lost', 'malformed', 'too-large'] as const) {
    test(`durable unknown survives ${response} outcome and blocks remint`, async () => {
      const f = fixture({ migrationResponse: () => response === 'lost' ? new Response(`remote-error-${shared}`, { status: 503 }) : response === 'malformed' ? Response.json({ token: shared }) : new Response('x'.repeat(17000)) });
      try {
        const result = await confirm(f);
        expect(result.status).toBe('unknown'); expect(JSON.stringify(result)).not.toContain(shared);
        expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('unknown');
        expect((await previewAgentHostPairing(f)).result.status).toBe('unknown');
        expect(readConnectedHostOperatorToken(f.homeDirectory, f.host).token).toBeNull();
        expect(resolveDaemonOperatorConnection(f.configManager, f.homeDirectory).token).toBeNull(); expect(f.migrations).toBe(1);
      } finally { f.close(); }
    });
  }

  test('environment precedence survives a successful stored migration and is disclosed', async () => {
    const f = fixture(); try {
      process.env.GOODVIBES_CONNECTED_HOST_TOKEN = shared;
      const result = await confirm(f);
      expect(result.status).toBe('paired-shadowed'); expect(result.message).toContain('environment');
      expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('paired');
      expect(readConnectedHostOperatorToken(f.homeDirectory, f.host).token).toBe(shared);
      delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
      expect(readConnectedHostOperatorToken(f.homeDirectory, f.host).token).toBe(minted);
    } finally { f.close(); }
  });

  test('an environment override cannot turn rejected minted authority into successful pairing', async () => {
    const f = fixture({ rejectMintedAuth: true }); try {
      process.env.GOODVIBES_CONNECTED_HOST_TOKEN = shared;
      const result = await confirm(f);
      expect(result.status).toBe('paired-unverified');
      expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('paired');
      expect((await previewAgentHostPairing(f)).result.status).toBe('already-paired'); expect(f.migrations).toBe(1);
    } finally { f.close(); }
  });

  test('changed selection after migration stores only for the original host and stays unverified', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture({ mutate: () => f.configManager.set('controlPlane.port', 1) });
    try {
      expect((await confirm(f)).status).toBe('paired-unverified');
      expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('paired');
      expect(readAgentHostPairing(f.homeDirectory, 'http://127.0.0.1:1').status).toBe('missing');
    } finally { f.close(); }
  });

  test('environment shadowing cannot hide a host change during migration', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture({ mutate: () => f.configManager.set('controlPlane.port', 1) });
    try {
      process.env.GOODVIBES_CONNECTED_HOST_TOKEN = shared;
      expect((await confirm(f)).status).toBe('paired-unverified');
      expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('paired'); expect(f.migrations).toBe(1);
    } finally { f.close(); }
  });

  test('cancellation after the one migration request leaves durable unknown and never retries', async () => {
    let started!: () => void; const requested = new Promise<void>(resolve => { started = resolve; });
    const f = fixture({ mutate: started, migrationResponse: () => new Promise<Response>(() => {}) });
    try {
      const preview = await previewAgentHostPairing(f); const controller = new AbortController();
      const result = preview.confirm!(preview.result.confirmation!, controller.signal);
      await requested; controller.abort();
      expect((await result).status).toBe('unknown'); expect(f.migrations).toBe(1);
      expect(readAgentHostPairing(f.homeDirectory, f.host).status).toBe('unknown');
      expect((await previewAgentHostPairing(f)).result.status).toBe('unknown');
    } finally { f.close(); }
  });

  test('abort before action and disabled preview never mutate', async () => {
    const f = fixture(); try {
      const p = await previewAgentHostPairing(f); const controller = new AbortController(); controller.abort();
      expect((await p.confirm!(p.result.confirmation!, controller.signal)).status).toBe('cancelled');
      f.configManager.set('daemon.connectedHost.enabled', false); const calls = f.requests.length;
      expect((await previewAgentHostPairing(f)).result.status).toBe('blocked'); expect(f.requests.length).toBe(calls); expect(f.migrations).toBe(0);
    } finally { f.close(); }
  });
});
