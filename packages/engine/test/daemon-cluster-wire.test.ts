import { expect, test } from 'bun:test';
import { callDaemonWsVerb } from '../terminal-shell/src/daemon-ws-call.ts';
import { callDaemonRoute } from '../terminal-shell/src/raw-reply-route.ts';

test('default cluster transports carry upgrade/auth credentials and raw HTTP payloads over a real loopback wire', async () => {
  const frames: string[] = [];
  let upgradedWithToken = false;
  const server = Bun.serve<{ authenticated: boolean }>({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      if (request.headers.get('authorization') !== 'Bearer fixture-token') return new Response('unauthorized', { status: 401 });
      if (new URL(request.url).pathname === '/api/control-plane/ws') {
        upgradedWithToken = true;
        if (server.upgrade(request, { data: { authenticated: false } })) return;
        return new Response('upgrade failed', { status: 400 });
      }
      return Response.json({ status: 'running', source: 'loopback fixture' });
    },
    websocket: {
      message(socket, message) {
        const frame = JSON.parse(String(message)) as { type: string; token?: string; id?: string; methodId?: string };
        frames.push(frame.type);
        if (frame.type === 'auth') {
          socket.data.authenticated = frame.token === 'fixture-token';
          socket.send(JSON.stringify({ type: 'auth', ok: socket.data.authenticated }));
        } else if (frame.type === 'call' && socket.data.authenticated) {
          socket.send(JSON.stringify({ type: 'response', id: frame.id, ok: true, status: 200, body: { method: frame.methodId } }));
        }
      },
    },
  });
  try {
    const target = { baseUrl: `http://127.0.0.1:${server.port}`, token: 'fixture-token', isLocal: true };
    expect(await callDaemonWsVerb(target, 'sessions.hosted.list', { timeoutMs: 2000 })).toEqual({ ok: true, data: { method: 'sessions.hosted.list' } });
    expect(upgradedWithToken).toBe(true);
    expect(frames).toEqual(['auth', 'call']);
    expect(await callDaemonRoute(target, '/status', { method: 'GET', envelope: 'raw' })).toEqual({ ok: true, data: { status: 'running', source: 'loopback fixture' } });
  } finally { server.stop(true); }
});
