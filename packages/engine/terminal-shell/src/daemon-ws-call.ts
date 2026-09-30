/**
 * daemon-ws-call.ts, invoking a verb that has no REST binding.
 *
 * Most control-plane verbs answer on a plain HTTP path and `callDaemonVerb` in
 * @goodvibes-jev/engine/terminal-shell is all a subcommand needs. Some do not: the
 * `sessions.hosted.*` family is declared ws-only in the method catalog (no
 * `http` binding at all), because a hosted session's whole point is the event
 * stream that comes with it. A GET against a path they do not have returns 404,
 * which reads exactly like an out-of-date daemon.
 *
 * So this is the second half of the SAME convention: the target is resolved by
 * `resolveRemoteDaemonTarget` (the --host/--port/--token flags, defaulting to
 * this machine), the credential is the same operator token, and only the
 * transport differs. Nothing here knows what any verb MEANS.
 *
 * The frames are the ones the operator contract declares for
 * `/api/control-plane/ws`:
 *   -> {"type":"auth","token":"…"}          <- {"type":"auth","ok":true,…}
 *   -> {"type":"call","id":"…","methodId":"…","body":{…}}
 *                                            <- {"type":"response","id":"…","ok":…,"status":…,"body":…}
 *
 * The Authorization header is sent on the upgrade as well as in the auth frame.
 * The daemon requires it on the upgrade (an unauthenticated upgrade is a 401
 * before any frame is read) and re-reads it from the frame; sending both is
 * what makes one connection work for both checks.
 */
import type { DaemonVerbOutcome, RemoteDaemonTarget } from './cluster-remote-daemon-target.js';

/** How long a single verb call may take, upgrade included. */
export const DAEMON_WS_TIMEOUT_MS = 15_000;

/**
 * The socket shape this module uses.
 *
 * Narrower than the platform `WebSocket` on purpose: a test double has no
 * business implementing `binaryType`, `extensions` or the EventTarget surface,
 * and requiring them would push every test into a cast.
 */
export interface DaemonWebSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type DaemonWebSocketFactory = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => DaemonWebSocket;

/** The real one. Bun's WebSocket takes headers on the constructor; browsers' does not. */
const realWebSocketFactory: DaemonWebSocketFactory = (url, init) =>
  new WebSocket(url, init as unknown as string[]) as unknown as DaemonWebSocket;

export interface CallDaemonWsVerbOptions {
  readonly body?: unknown;
  readonly timeoutMs?: number | undefined;
  /** Injected in tests so nothing opens a socket. */
  readonly socketFactory?: DaemonWebSocketFactory | undefined;
}

function wsUrlFor(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/api/control-plane/ws`;
}

interface ParsedFrame {
  readonly type?: unknown;
  readonly ok?: unknown;
  readonly id?: unknown;
  readonly status?: unknown;
  readonly body?: unknown;
  readonly error?: unknown;
}

function parseFrame(data: unknown): ParsedFrame | null {
  const text = typeof data === 'string'
    ? data
    : data instanceof Uint8Array
      ? new TextDecoder().decode(data)
      : null;
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as ParsedFrame) : null;
  } catch {
    return null;
  }
}

/**
 * Call one ws-only verb and close.
 *
 * One connection per call. A CLI command asks one question and exits, so a
 * pooled connection would only be a lifetime to get wrong; the cost is one
 * upgrade against a daemon that is, in the default case, on this machine.
 *
 * Every failure shape becomes an `error`/`fix` pair in the same vocabulary
 * `callDaemonVerb` produces, so a caller renders both the same way.
 */
export async function callDaemonWsVerb<T>(
  target: RemoteDaemonTarget,
  methodId: string,
  options: CallDaemonWsVerbOptions = {},
): Promise<DaemonVerbOutcome<T>> {
  const where = target.isLocal ? 'the daemon on this machine' : `the daemon at ${target.baseUrl}`;
  const factory = options.socketFactory ?? realWebSocketFactory;
  const timeoutMs = options.timeoutMs ?? DAEMON_WS_TIMEOUT_MS;
  const callId = `cli-${methodId}-${Date.now()}`;

  let socket: DaemonWebSocket;
  try {
    socket = factory(wsUrlFor(target.baseUrl), {
      headers: { Authorization: `Bearer ${target.token}` },
    });
  } catch (error) {
    return {
      ok: false,
      error: `could not reach ${where}`,
      fix: target.isLocal
        ? 'check the daemon is running: goodvibes-daemon service-status'
        : `check that machine is reachable and its daemon is listening on ${target.baseUrl} `
          + `(${error instanceof Error ? error.message : 'no further detail'})`,
    };
  }

  return new Promise<DaemonVerbOutcome<T>>((resolve) => {
    let settled = false;
    let authSent = false;
    let callSent = false;
    const timer = setTimeout(() => {
      finish({
        ok: false,
        error: `${where} did not answer within ${Math.round(timeoutMs / 1000)}s`,
        fix: target.isLocal
          ? 'check the daemon is running and not wedged: goodvibes-daemon status'
          : 'check that machine is reachable and its daemon is not overloaded',
      });
    }, timeoutMs);

    const finish = (outcome: DaemonVerbOutcome<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // A socket that is already gone is exactly the state we wanted.
      }
      resolve(outcome);
    };

    const send = (frame: unknown): void => {
      if (settled) return;
      try { socket.send(JSON.stringify(frame)); }
      catch {
        finish({
          ok: false,
          error: `could not send the request to ${where}`,
          fix: target.isLocal
            ? 'check the daemon is running: goodvibes-daemon service-status'
            : `check that machine is reachable and its daemon is listening on ${target.baseUrl}`,
        });
      }
    };

    socket.onopen = (): void => {
      if (settled || authSent) return;
      authSent = true;
      send({ type: 'auth', token: target.token });
    };

    socket.onmessage = (event): void => {
      if (settled) return;
      const frame = parseFrame(event.data);
      if (!frame) return;

      if (frame.type === 'auth') {
        if (!authSent) return;
        if (frame.ok === true) {
          if (callSent) return;
          callSent = true;
          send({
            type: 'call',
            id: callId,
            methodId,
            ...(options.body === undefined ? {} : { body: options.body }),
          });
          return;
        }
        finish({
          ok: false,
          error: `${where} refused the operator token`,
          fix: target.isLocal
            ? 'the token may be stale; restart the daemon, or pass --token'
            : 'pass --token with the operator token from that machine (its <daemon home>/operator-tokens.json)',
        });
        return;
      }

      if (frame.type === 'error') {
        finish({
          ok: false,
          error: typeof frame.error === 'string' ? frame.error : `${where} refused the request`,
          fix: 'run `goodvibes-daemon status` to see what that daemon is doing',
        });
        return;
      }

      if (frame.type !== 'response' || !callSent || frame.id !== callId) return;

      if (frame.ok === true) {
        finish({ ok: true, data: frame.body as T });
        return;
      }
      const body = (frame.body ?? {}) as { error?: unknown; fix?: unknown };
      if (frame.status === 404) {
        finish({
          ok: false,
          error: `${where} does not know the verb ${methodId}`,
          fix: 'that daemon is running a build without this capability; update it, then try again',
        });
        return;
      }
      finish({
        ok: false,
        error: typeof body.error === 'string' ? body.error : `${where} refused ${methodId}`,
        fix: typeof body.fix === 'string'
          ? body.fix
          : 'run `goodvibes-daemon status` to see what that daemon is doing',
      });
    };

    socket.onerror = (): void => {
      finish({
        ok: false,
        error: `could not reach ${where}`,
        fix: target.isLocal
          ? 'check the daemon is running: goodvibes-daemon service-status'
          : `check that machine is switched on and its daemon is listening on ${target.baseUrl}`,
      });
    };

    socket.onclose = (): void => {
      // A close before an answer is a refusal too, most often the upgrade
      // itself was rejected, which happens before any frame is sent.
      finish({
        ok: false,
        error: `${where} closed the connection before answering`,
        fix: target.isLocal
          ? 'check the daemon is running: goodvibes-daemon service-status'
          : 'check the operator token for that machine; an upgrade with no valid token is closed immediately',
      });
    };
  });
}
