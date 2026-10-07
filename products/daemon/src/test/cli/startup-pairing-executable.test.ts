import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableLoopbackPorts, companionCliFixture } from '../helpers/companion-cli-fixture.js';

function readyFrame(origin: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const BunWebSocket = WebSocket as typeof WebSocket & { new (url: string, options: Bun.WebSocketOptions): WebSocket };
    const socket = new BunWebSocket(`${origin.replace('http:', 'ws:')}/api/control-plane/ws?clientKind=web`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    let settled = false;
    const finish = (error?: Error, data?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve(data);
    };
    const timer = setTimeout(() => finish(new Error('WebSocket ready frame timed out')), 10_000);
    socket.onmessage = (message) => {
      try { finish(undefined, JSON.parse(String(message.data))); }
      catch { finish(new Error('WebSocket did not send JSON')); }
    };
    socket.onerror = () => finish(new Error('Authenticated WebSocket failed'));
    socket.onclose = () => finish(new Error('WebSocket closed before ready'));
  });
}

for (const mode of ['stored fallback', 'daemon override', 'headless'] as const) {
  test(`emitted launcher pairing opens its served WebUI and authenticates the existing host: ${mode}`, async () => {
    const f = companionCliFixture();
    const [port, intendedPort, httpPort] = await availableLoopbackPorts(3);
    const bundle = join(f.root, 'bundle'); mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'index.html'), '<!doctype html><title>Emitted pairing WebUI</title>');
    mkdirSync(f.daemonHome, { recursive: true });
    const settings = JSON.stringify({ cluster: { enabled: false }, relay: { enabled: false },
      danger: { httpListener: true }, httpListener: { hostMode: 'local', port: httpPort },
      controlPlane: { hostMode: 'local', port: intendedPort, webui: { serve: true, bundleDir: bundle } },
    });
    writeFileSync(join(f.daemonHome, 'settings.json'), settings);
    const identity = '{ "token": "synthetic-stored-token", "peerId": "original-peer", "createdAt": 123 }\n';
    writeFileSync(join(f.daemonHome, 'operator-tokens.json'), identity, { mode: 0o600 });
    const effective = mode === 'stored fallback' ? 'synthetic-stored-token' : 'synthetic-daemon-token';
    const env = { ...(mode === 'stored fallback' ? {} : { GOODVIBES_DAEMON_TOKEN: effective }),
      GOODVIBES_HTTP_TOKEN: 'synthetic-secondary-http-token' };
    const child = f.launch(['--daemon-home', 'selected-daemon', 'serve', '--port', String(port)], {
      composed: true, pairingOutput: mode !== 'headless', env,
    });
    try {
      await child.waitFor('host started');
      const output = child.output();
      expect(output.stderr).not.toContain(effective);
      if (mode === 'headless') {
        expect(output.stdout).not.toContain('/#pair='); expect(output.stdout).not.toContain(effective);
        expect(output.stdout).not.toContain('synthetic-stored-token');
      } else {
        const link = new URL(output.stdout.split('\n').find((line) => line.includes('/#pair='))!.trim());
        expect(link.origin).toBe(`http://127.0.0.1:${port}`);
        const token = new URLSearchParams(link.hash.slice(1)).get('pair')!;
        expect(token).toBe(effective);
        const shell = await fetch(link.origin);
        expect(shell.status).toBe(200); expect(await shell.text()).toContain('Emitted pairing WebUI');
        const inbox = await fetch(`${link.origin}/api/channels/inbox`, { headers: { Authorization: `Bearer ${token}` } });
        expect(inbox.status).toBe(200); expect(await inbox.text()).toContain('Synthetic subject');
        expect(await readyFrame(link.origin, token)).toMatchObject({ type: 'event', event: 'ready' });
        for (const wrong of mode === 'stored fallback' ? ['synthetic-secondary-http-token'] : ['synthetic-stored-token', 'synthetic-secondary-http-token']) {
          const response = await fetch(`${link.origin}/api/channels/inbox`, { headers: { Authorization: `Bearer ${wrong}` } });
          expect(response.status).toBe(401); await response.arrayBuffer();
          await expect(readyFrame(link.origin, wrong)).rejects.toThrow();
        }
        const pair = await f.oneShot(['--daemon-home', 'selected-daemon', 'pair', '--port', String(port), '--json'], env);
        expect(pair.code).toBe(0);
        expect(JSON.parse(pair.stdout).data.deepLink).toBe(link.href);
      }
      const health = await fetch(`http://127.0.0.1:${httpPort}/health`, { headers: { Authorization: 'Bearer synthetic-secondary-http-token' } });
      expect(health.status).toBe(200); await health.arrayBuffer();
      expect(readFileSync(join(f.daemonHome, 'operator-tokens.json'), 'utf8')).toBe(identity);
      expect(readFileSync(join(f.daemonHome, 'settings.json'), 'utf8')).toBe(settings);
      expect(await child.stop()).toBe(0);
      expect(readFileSync(join(f.daemonHome, 'operator-tokens.json'), 'utf8')).toBe(identity);
    } finally { await child.close(); }
  }, 45_000);
}
