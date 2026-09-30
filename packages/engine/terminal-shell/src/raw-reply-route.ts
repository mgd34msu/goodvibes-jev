/**
 * raw-reply-route.ts, invoking a route that answers with its payload itself.
 *
 * `callDaemonVerb` in @goodvibes-jev/engine/terminal-shell reads the wrapped
 * convention every `/api/cluster/*` route follows: `{ ok: true, data }` on
 * success, `{ ok: false, error, fix }` on a refusal. Three routes this daemon
 * serves do not, `/status`, `/api/health` and `/api/channels/status` answer
 * with the payload ITSELF and put the verdict in the HTTP status. Reading one
 * as the other is not a subtle failure: a raw payload has no `ok` field, so the
 * wrapped reader called a perfectly healthy 200 "the daemon refused the
 * request".
 *
 * So this is the second half of the SAME convention, next to daemon-ws-call.ts:
 * the target is resolved by `resolveRemoteDaemonTarget`, the credential is the
 * same operator token, the reachability / stale-credential / unreadable-reply
 * refusals are the shared reader's, only the shape of a successful body
 * differs. `rawReplyReader` restates a raw reply in the wrapped convention
 * before the shared reader sees it, so there is one request path rather than
 * two.
 *
 * Which routes are raw is stated per call, never sniffed: a payload is free to
 * contain a field called `ok` and no sniffing rule could be honest about that.
 */
import { callDaemonVerb, type DaemonFetch, type DaemonVerbOutcome, type RemoteDaemonTarget } from './cluster-remote-daemon-target.js';

/** How a route's reply is shaped. */
export type DaemonReplyEnvelope = 'wrapped' | 'raw';

/**
 * The status a restated reply carries.
 *
 * The shared reader looks at the status for exactly three verdicts, 401, 403
 * and 404, and those are passed through untouched below, before any body is
 * read. Everything else it decides from the body, so a restated reply names a
 * status that is legal to attach a body to (a 204 or a 304 is not) rather than
 * echoing one that would make `new Response` throw.
 */
const RESTATED_OK = 200;
const RESTATED_REFUSAL = 500;

/**
 * Wrap a fetch so a raw-answering route reads as a wrapped one.
 *
 * A reply the shared reader short-circuits on (a credential refusal, an
 * unknown path) is handed back exactly as it arrived. A body that is not JSON
 * is handed back unparsed, so the shared reader produces its own
 * "reply this build could not read" refusal rather than a second wording for
 * the same thing.
 */
export function rawReplyReader(target: RemoteDaemonTarget, fetchImpl: DaemonFetch = fetch): DaemonFetch {
  const where = target.isLocal ? 'the daemon on this machine' : `the daemon at ${target.baseUrl}`;
  return async (input, init) => {
    const response = await fetchImpl(input, init);
    if (response.status === 401 || response.status === 403 || response.status === 404) return response;

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      return new Response(text, { status: RESTATED_OK });
    }

    if (response.ok) {
      return new Response(JSON.stringify({ ok: true, data: payload }), { status: RESTATED_OK });
    }
    const body = payload !== null && typeof payload === 'object'
      ? payload as { error?: unknown; fix?: unknown }
      : {};
    return new Response(JSON.stringify({
      ok: false,
      error: typeof body.error === 'string'
        ? body.error
        : `${where} answered ${response.status} for ${pathOf(input)}`,
      fix: typeof body.fix === 'string'
        ? body.fix
        : 'run `goodvibes-daemon status` to see what that daemon is doing',
    }), { status: RESTATED_REFUSAL });
  };
}

/** The path portion of a request URL, for a refusal that names what was asked for. */
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Call a daemon route, saying which envelope it answers in.
 *
 * `wrapped` is the shared reader unchanged. `raw` is the shared reader with the
 * restating fetch above in front of it, so both envelopes reach the same
 * refusals in the same words.
 */
export function callDaemonRoute<T>(
  target: RemoteDaemonTarget,
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown; envelope?: DaemonReplyEnvelope } = { method: 'GET' },
  fetchImpl: DaemonFetch = fetch,
): Promise<DaemonVerbOutcome<T>> {
  const request = init.body === undefined
    ? { method: init.method }
    : { method: init.method, body: init.body };
  return callDaemonVerb<T>(
    target,
    path,
    request,
    (init.envelope ?? 'wrapped') === 'raw' ? rawReplyReader(target, fetchImpl) : fetchImpl,
  );
}
