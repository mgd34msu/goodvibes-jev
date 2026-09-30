import { describe, expect, test } from 'bun:test';
import {
  callDaemonWsVerb,
  type DaemonWebSocket,
  type DaemonWebSocketFactory,
} from '../terminal-shell/src/daemon-ws-call.ts';
import type { RemoteDaemonTarget } from '../terminal-shell/src/cluster-remote-daemon-target.ts';

const LOCAL: RemoteDaemonTarget = { baseUrl: 'http://127.0.0.1:3421', token: 'op-token', isLocal: true };
const REMOTE: RemoteDaemonTarget = { baseUrl: 'http://10.0.0.7:3421', token: 'other', isLocal: false };

/** A socket that lets a test drive each side of the exchange by hand. */
function manualSocket(): { factory: DaemonWebSocketFactory; socket: () => DaemonWebSocket; sent: string[]; closed: () => number } {
  let made: DaemonWebSocket | null = null;
  const sent: string[] = [];
  let closes = 0;
  const factory: DaemonWebSocketFactory = () => {
    const socket: DaemonWebSocket = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data: string): void {
        sent.push(data);
      },
      close(): void {
        closes += 1;
      },
    };
    made = socket;
    return socket;
  };
  return { factory, socket: () => made as DaemonWebSocket, sent, closed: () => closes };
}

describe('the ws verb call', () => {
  test('sends the auth frame on open, then the call frame with the method id', async () => {
    const { factory, socket, sent } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', {
      body: { includeTerminated: true },
      socketFactory: factory,
    });

    socket().onopen?.({});
    expect(JSON.parse(sent[0] as string)).toEqual({ type: 'auth', token: 'op-token' });

    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    const call = JSON.parse(sent[1] as string) as { type: string; id: string; methodId: string; body: unknown };
    expect(call.type).toBe('call');
    expect(call.methodId).toBe('sessions.hosted.list');
    expect(call.body).toEqual({ includeTerminated: true });

    socket().onmessage?.({ data: JSON.stringify({ type: 'response', id: call.id, ok: true, status: 200, body: { sessions: [] } }) });
    await expect(pending).resolves.toEqual({ ok: true, data: { sessions: [] } });
  });

  test('the socket is closed once an answer arrives', async () => {
    const { factory, socket, sent, closed } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', { socketFactory: factory });
    socket().onopen?.({});
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    const call = JSON.parse(sent[1] as string) as { id: string };
    socket().onmessage?.({ data: JSON.stringify({ type: 'response', id: call.id, ok: true, body: {} }) });
    await pending;
    expect(closed()).toBe(1);
  });

  test('repeated open/auth frames send one auth and one call, and late frames cannot send after settlement', async () => {
    const { factory, socket, sent, closed } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', { socketFactory: factory });
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    expect(sent).toEqual([]);
    socket().onopen?.({}); socket().onopen?.({});
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    expect(sent).toHaveLength(2);
    const call = JSON.parse(sent[1]!) as { id: string };
    socket().onmessage?.({ data: JSON.stringify({ type: 'response', id: call.id, ok: true, body: {} }) });
    await pending;
    socket().onopen?.({});
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    expect(sent).toHaveLength(2);
    expect(closed()).toBe(1);
  });

  test('the operator token is on the upgrade and auth frame, with HTTPS mapped to WSS', async () => {
    const manual = manualSocket();
    let upgrade: { url: string; headers: Readonly<Record<string, string>> } | undefined;
    const pending = callDaemonWsVerb({ ...REMOTE, baseUrl: 'https://daemon.example.invalid' }, 'sessions.hosted.list', {
      socketFactory: (url, init) => { upgrade = { url, headers: init.headers }; return manual.factory(url, init); },
    });
    expect(upgrade).toEqual({ url: 'wss://daemon.example.invalid/api/control-plane/ws', headers: { Authorization: 'Bearer other' } });
    manual.socket().onopen?.({});
    expect(JSON.parse(manual.sent[0]!)).toEqual({ type: 'auth', token: 'other' });
    manual.socket().onclose?.({});
    await pending;
  });

  test('a send exception settles and closes rather than leaking a pending call', async () => {
    for (const when of ['auth', 'call']) {
      const { factory, socket, closed } = manualSocket();
      const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', { socketFactory: factory });
      if (when === 'call') socket().onopen?.({});
      socket().send = () => { throw new Error('socket is closed'); };
      if (when === 'auth') socket().onopen?.({});
      else socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.error).toContain('could not send');
      expect(closed()).toBe(1);
    }
  });

  test('a late open after timeout cannot transmit the operator token', async () => {
    const { factory, socket, sent } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', { socketFactory: factory, timeoutMs: 1 });
    await pending;
    socket().onopen?.({});
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    expect(sent).toEqual([]);
  });

  test('a response for a different call id is ignored', async () => {
    const { factory, socket, sent } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', { socketFactory: factory });
    socket().onopen?.({});
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    const call = JSON.parse(sent[1] as string) as { id: string };

    socket().onmessage?.({ data: JSON.stringify({ type: 'response', id: 'someone-else', ok: true, body: { wrong: true } }) });
    socket().onmessage?.({ data: JSON.stringify({ type: 'response', id: call.id, ok: true, body: { right: true } }) });

    await expect(pending).resolves.toEqual({ ok: true, data: { right: true } });
  });

  test('a rejected auth frame reads as a token problem, and the fix differs local vs remote', async () => {
    for (const [target, expected] of [[LOCAL, 'restart the daemon'], [REMOTE, 'from that machine']] as const) {
      const { factory, socket } = manualSocket();
      const pending = callDaemonWsVerb(target, 'sessions.hosted.list', { socketFactory: factory });
      socket().onopen?.({});
      socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: false, error: 'Unauthorized' }) });
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain('refused the operator token');
      expect(outcome.fix).toContain(expected);
    }
  });

  test('a 404 response names the verb and says the daemon is an older build', async () => {
    const { factory, socket, sent } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.kill', { socketFactory: factory });
    socket().onopen?.({});
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    const call = JSON.parse(sent[1] as string) as { id: string };
    socket().onmessage?.({ data: JSON.stringify({ type: 'response', id: call.id, ok: false, status: 404 }) });

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('does not know the verb sessions.hosted.kill');
    expect(outcome.fix).toContain('update it');
  });

  test("the daemon's own error and fix are passed through unchanged", async () => {
    const { factory, socket, sent } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.kill', { socketFactory: factory });
    socket().onopen?.({});
    socket().onmessage?.({ data: JSON.stringify({ type: 'auth', ok: true }) });
    const call = JSON.parse(sent[1] as string) as { id: string };
    socket().onmessage?.({
      data: JSON.stringify({ type: 'response', id: call.id, ok: false, status: 400, body: { error: 'no such session', fix: 'run sessions list' } }),
    });

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('no such session');
    expect(outcome.fix).toBe('run sessions list');
  });

  test('a close before any answer is reported as a refusal, not a hang', async () => {
    const { factory, socket } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', { socketFactory: factory });
    socket().onclose?.({});
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('closed the connection before answering');
  });

  test('a socket error is reported with the reachability fix', async () => {
    const { factory, socket } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', { socketFactory: factory });
    socket().onerror?.({});
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.fix).toContain('service-status');
  });

  test('a silent daemon times out rather than hanging the command forever', async () => {
    const { factory, socket } = manualSocket();
    const pending = callDaemonWsVerb(LOCAL, 'sessions.hosted.list', { socketFactory: factory, timeoutMs: 15 });
    socket().onopen?.({});
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('did not answer within');
  });

  test('a factory that throws is reported, not propagated', async () => {
    const outcome = await callDaemonWsVerb(REMOTE, 'sessions.hosted.list', {
      socketFactory: () => {
        throw new Error('no route to host');
      },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('could not reach');
    expect(outcome.fix).toContain('no route to host');
  });

  test('the ws URL is derived from the target base URL', async () => {
    const urls: string[] = [];
    const factory: DaemonWebSocketFactory = (url) => {
      urls.push(url);
      const socket: DaemonWebSocket = {
        onopen: null, onmessage: null, onerror: null, onclose: null,
        send(): void { /* nothing to record here */ },
        close(): void { /* nothing to release */ },
      };
      queueMicrotask(() => socket.onclose?.({}));
      return socket;
    };
    await callDaemonWsVerb(REMOTE, 'sessions.hosted.list', { socketFactory: factory });
    expect(urls[0]).toBe('ws://10.0.0.7:3421/api/control-plane/ws');
  });
});
