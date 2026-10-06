import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/sdk/contracts';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { readConnectedHostOperatorToken } from '../../runtime/connected-host-auth.ts';
import { readConnectedHostReadiness } from '../../runtime/connected-host-readiness.ts';
import { isNativePairedPrincipal } from '../../runtime/native-paired-principal.ts';
import { createNativeConversationIntakeBinding } from '../../runtime/native-conversation-intake-host.ts';
import { buildCliServicePosture } from '../../cli/service-posture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const paired: OperatorMethodOutput<'control.auth.current'> = {
  authenticated: true, authMode: 'shared-token', tokenPresent: true,
  authorizationHeaderPresent: true, sessionCookiePresent: false,
  principalId: 'synthetic-paired-owner', principalKind: 'token', admin: true,
  scopes: ['read:work-ledger', 'write:work-ledger'], roles: [],
};
const envNames = ['GOODVIBES_CONNECTED_HOST_TOKEN', 'GOODVIBES_DAEMON_TOKEN'] as const;
const originalEnv = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
afterEach(() => { for (const key of envNames) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; } });

function fixture(port: number) {
  for (const key of envNames) delete process.env[key];
  const homeDirectory = makeProjectTempDir('live-readiness');
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: join(homeDirectory, '.goodvibes', 'agent'), workingDir: homeDirectory, homeDir: homeDirectory });
  configManager.set('controlPlane.host', '127.0.0.1');
  configManager.set('controlPlane.port', port);
  configManager.set('controlPlane.enabled', true);
  configManager.set('daemon.connectedHost.enabled', true);
  const tokenPath = join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json');
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: 'synthetic-file-token' }));
  return { configManager, homeDirectory, tokenPath };
}

describe('selected-host live readiness', () => {
  test('uses native intake authority and effective environment precedence on the selected host', async () => {
    const requests: { path: string; auth: string | null }[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      requests.push({ path: new URL(request.url).pathname, auth: request.headers.get('authorization') });
      return Response.json(paired);
    } });
    try {
      const options = fixture(server.port!);
      process.env.GOODVIBES_DAEMON_TOKEN = 'synthetic-legacy-env';
      process.env.GOODVIBES_CONNECTED_HOST_TOKEN = 'synthetic-effective-env';
      expect((await readConnectedHostReadiness(options)).status).toBe('ready');
      const binding = createNativeConversationIntakeBinding({ baseUrl: server.url.origin, token: 'synthetic-effective-env', workspace: options.homeDirectory }, 'synthetic-project');
      try { expect(await binding.readPrincipal(new AbortController().signal)).toBe('synthetic-paired-owner'); } finally { binding.dispose(); }
      expect(requests).toEqual(Array.from({ length: 2 }, () => ({ path: '/api/control-plane/auth', auth: 'Bearer synthetic-effective-env' })));
    } finally { server.stop(true); }
  });

  for (const [name, change] of [
    ['shared', { principalId: 'shared-token' }], ['anonymous', { authenticated: false }],
    ['non-admin', { admin: false }], ['session', { principalKind: 'user' }],
    ['missing-read', { scopes: ['write:work-ledger'] }], ['missing-write', { scopes: ['read:work-ledger'] }],
    ['empty-principal', { principalId: '' }], ['long-principal', { principalId: 'x'.repeat(201) }],
  ] as const) {
    test(`rejects ${name} authority even with a readable token`, async () => {
      const auth = { ...paired, ...change } as OperatorMethodOutput<'control.auth.current'>;
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json(auth) });
      try {
        expect(isNativePairedPrincipal(auth)).toBe(false);
        expect((await readConnectedHostReadiness(fixture(server.port!))).status).toBe('unsupported-principal');
      } finally { server.stop(true); }
    });
  }

  test('accepts wildcard scopes but never requires execution scope for intake readiness', () => {
    expect(isNativePairedPrincipal({ ...paired, scopes: ['*'] })).toBe(true);
    expect(isNativePairedPrincipal(paired)).toBe(true);
  });

  for (const change of ['host', 'port', 'token', 'environment-token', 'disabled'] as const) {
    test(`discards a successful response after ${change} changes`, async () => {
      let options: ReturnType<typeof fixture>;
      const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
        if (change === 'host') options.configManager.set('controlPlane.host', 'localhost');
        if (change === 'port') options.configManager.set('controlPlane.port', 1);
        if (change === 'environment-token') process.env.GOODVIBES_CONNECTED_HOST_TOKEN = 'synthetic-new-env';
        if (change === 'token') writeFileSync(options.tokenPath, JSON.stringify({ token: 'synthetic-replaced' }));
        if (change === 'disabled') options.configManager.set('daemon.connectedHost.enabled', false);
        return Response.json(paired);
      } });
      try { options = fixture(server.port!); expect((await readConnectedHostReadiness(options)).status).toBe('changed'); } finally { server.stop(true); }
    });
  }

  test('disabled dialing makes neither HTTP auth nor TCP service probes', async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json(paired); } });
    try {
      const options = fixture(server.port!);
      options.configManager.set('daemon.connectedHost.enabled', false);
      expect((await readConnectedHostReadiness(options)).status).toBe('disabled');
      const posture = await buildCliServicePosture({ ...options, workingDirectory: options.homeDirectory }, { probe: true });
      expect(posture.endpoints.every(endpoint => endpoint.reachable === undefined)).toBe(true);
      expect(requests).toBe(0);
    } finally { server.stop(true); }
  });

  test('missing credentials never request auth and malformed responses stay unavailable', async () => {
    const options = fixture(1);
    let requests = 0;
    const fetchImpl = (async () => { requests++; return Response.json({ authenticated: true, token: 'synthetic-response-secret' }); }) as unknown as typeof fetch;
    const malformed = await readConnectedHostReadiness({ ...options, fetchImpl });
    expect(malformed.status).toBe('unavailable');
    expect(JSON.stringify(malformed)).not.toContain('synthetic-response-secret');
    expect(requests).toBe(1);
    writeFileSync(options.tokenPath, '{}');
    expect((await readConnectedHostReadiness({ ...options, fetchImpl })).status).toBe('missing-credential');
    expect(requests).toBe(1);
  });

  test('bounds an unresponsive auth endpoint and discards raw timeout errors', async () => {
    const options = fixture(1);
    let calls = 0;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      calls++;
      init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-timeout-secret')), { once: true });
    })) as unknown as typeof fetch;
    const result = await readConnectedHostReadiness({ ...options, fetchImpl });
    expect(result.status).toBe('unavailable');
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain('synthetic-timeout-secret');
  });

  test('uses an injected transport exclusively', async () => {
    const options = fixture(1);
    let requests = 0;
    const fetchImpl = (async () => { requests++; return Response.json(paired); }) as unknown as typeof fetch;
    expect((await readConnectedHostReadiness({ ...options, fetchImpl })).status).toBe('ready');
    expect(requests).toBe(1);
  });

  for (const host of ['example.com', 'https://invalid.example/path']) {
    test(`sanitizes unsupported endpoint ${host} before any request`, async () => {
      const options = fixture(1);
      options.configManager.set('controlPlane.host', host);
      let requests = 0;
      const fetchImpl = (async () => { requests++; return Response.json(paired); }) as unknown as typeof fetch;
      expect((await readConnectedHostReadiness({ ...options, fetchImpl })).status).toBe('unavailable');
      expect(requests).toBe(0);
    });
  }

  test('does not leak credentials or remote error payloads and never caches success', async () => {
    let ready = true;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
      return ready ? Response.json(paired) : new Response('synthetic-file-token remote-secret-details', { status: 403 });
    } });
    try {
      const options = fixture(server.port!);
      expect((await readConnectedHostReadiness(options)).status).toBe('ready');
      ready = false;
      const result = await readConnectedHostReadiness(options);
      expect(result.status).toBe('unavailable');
      expect(JSON.stringify(result)).not.toContain('synthetic-file-token');
      expect(JSON.stringify(result)).not.toContain('remote-secret-details');
      writeFileSync(options.tokenPath, '{"token":"synthetic-malformed-secret');
      const missing = await readConnectedHostReadiness(options);
      expect(missing.status).toBe('missing-credential');
      expect(JSON.stringify(missing)).not.toContain('synthetic-malformed-secret');
      expect(JSON.stringify(readConnectedHostOperatorToken(options.homeDirectory))).not.toContain('synthetic-malformed-secret');
    } finally { server.stop(true); }
  });
});
