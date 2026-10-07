import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { SecretsManager } from '../../config/secrets.js';
import { createSendStack } from '../../daemon/send/composition.js';
import { runSendCommand } from '../../daemon/send/command.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
function fixture() {
  const root = makeOwnedTempDir('daemon-send-stack');
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'tree'); const work = join(root, 'work');
  mkdirSync(home, { recursive: true }); mkdirSync(work, { recursive: true });
  const configuration = createDaemonCliConfiguration({ daemonHome: undefined, workingDir: undefined },
    { HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: join(root, 'owned-daemon') }, work);
  for (const key of ['controlPlane.gateway', 'integrations.routeBinding', 'integrations.deliveryTracking', 'service.enabled', 'surfaces.ntfy.enabled'] as const) {
    configuration.config.setDynamic(key, true);
  }
  configuration.config.setDynamic('surfaces.ntfy.baseUrl', 'http://127.0.0.1:1');
  configuration.config.setDynamic('surfaces.ntfy.topic', `synthetic-private-topic-${root.split('/').at(-1)}`);
  configuration.config.setDynamic('surfaces.ntfy.token', 'goodvibes://secrets/goodvibes/SYNTHETIC_SEND_TOKEN');
  const stack = createSendStack(configuration);
  return { configuration, send: () => runSendCommand(['--channel', 'ntfy', '--title', 'Synthetic title', 'synthetic private body'], {
    configManager: configuration.config, deliver: stack.deliver, stdinIsTty: true,
    readStdin: async () => { throw new Error('argument sends cannot read stdin'); },
  }) };
}
function mockFetch(respond: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(respond, {
    preconnect() { throw new Error('unexpected preconnect'); },
  }));
  cleanup.push(() => fetch.mockRestore());
  return fetch;
}
function mockSecret(get: () => Promise<string | null>) {
  const secret = spyOn(SecretsManager.prototype, 'get').mockImplementation(get);
  cleanup.push(() => secret.mockRestore());
  return secret;
}

describe('standalone send awaits the real ntfy delivery owner', () => {
  test('held credential resolution, fetch and successful response-body retirement each keep the result pending', async () => {
    const credential = deferred<string | null>(); const response = deferred<Response>(); const retirement = deferred<void>();
    let credentialEntered = false; let fetchEntered = false; let bodyRetired = false; let settled = false;
    mockSecret(async () => { credentialEntered = true; return credential.promise; });
    mockFetch(async (_input, init) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-owned-token');
      expect(init?.body).toBe('synthetic private body'); fetchEntered = true; return response.promise;
    });
    const body = new ReadableStream<Uint8Array>({ cancel() { bodyRetired = true; return retirement.promise; } });
    const running = fixture().send().finally(() => { settled = true; });
    try {
      await turn(); expect(credentialEntered).toBe(true); expect(fetchEntered).toBe(false); expect(settled).toBe(false);
      credential.resolve('synthetic-owned-token');
      await turn(); expect(fetchEntered).toBe(true); expect(settled).toBe(false);
      response.resolve(new Response(body));
      await turn(); expect(bodyRetired).toBe(true); expect(settled).toBe(false);
      retirement.resolve();
      const result = await running;
      expect(result.exitCode).toBe(0); expect(result.lines.join('\n')).not.toContain('synthetic');
    } finally { credential.resolve('synthetic-owned-token'); response.resolve(new Response(null)); retirement.resolve(); await running; }
  });

  test('a held rejected response body cannot report success or failure before the owner finishes reading it', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>; let settled = false;
    mockSecret(async () => 'synthetic-owned-token');
    const fetch = mockFetch(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { status: 503 }));
    const running = fixture().send().finally(() => { settled = true; });
    try {
      await turn(); expect(fetch).toHaveBeenCalledTimes(1); expect(settled).toBe(false);
      stream.enqueue(new TextEncoder().encode('synthetic private provider body with arbitrary prose'));
      await turn(); expect(settled).toBe(false);
      stream.close();
      const result = await running;
      expect(result.exitCode).toBe(1); expect(result.lines.join('\n')).toContain('HTTP 503');
      expect(result.lines.join('\n')).not.toContain('synthetic'); expect(fetch).toHaveBeenCalledTimes(1);
    } finally { if (!settled) { try { stream?.close(); } catch {} } await running; }
  });

  test('an acknowledged HTTP send remains successful after awaited response cleanup rejects', async () => {
    const retirement = deferred<void>(); let cancellationEntered = false; let settled = false;
    mockSecret(async () => 'synthetic-owned-token');
    const fetch = mockFetch(async () => new Response(new ReadableStream<Uint8Array>({
      async cancel() {
        cancellationEntered = true;
        await retirement.promise;
        throw new TypeError('synthetic private response cleanup failure');
      },
    })));
    const running = fixture().send().finally(() => { settled = true; });
    try {
      await turn(); expect(cancellationEntered).toBe(true); expect(settled).toBe(false);
      retirement.resolve();
      const result = await running;
      expect(result.exitCode).toBe(0); expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.lines.join('\n')).toContain('send request accepted');
      expect(result.lines.join('\n')).not.toContain('synthetic');
    } finally { retirement.resolve(); await running; }
  });

  for (const firstFails of [false, true]) {
    test(`two explicit identical sends both dispatch${firstFails ? ', even after the first fails' : ''}`, async () => {
      mockSecret(async () => 'synthetic-owned-token');
      const calls: string[] = [];
      const fetch = mockFetch(async (_input, init) => {
        calls.push(String(init?.body));
        return firstFails && calls.length === 1 ? new Response('synthetic private failure', { status: 503 }) : new Response(null);
      });
      const owned = fixture();
      const first = await owned.send();
      expect(first.exitCode).toBe(firstFails ? 1 : 0); expect(fetch).toHaveBeenCalledTimes(1);
      const second = await owned.send();
      expect(second.exitCode).toBe(0); expect(fetch).toHaveBeenCalledTimes(2);
      expect(calls).toEqual(['synthetic private body', 'synthetic private body']);
      expect([...first.lines, ...second.lines].join('\n')).not.toContain('synthetic');
    });
  }
});
