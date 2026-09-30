import { describe, expect, test } from 'bun:test';
import type { DaemonFetch, RemoteDaemonTarget } from '../terminal-shell/src/cluster-remote-daemon-target.ts';
import { callDaemonRoute } from '../terminal-shell/src/raw-reply-route.ts';

const TARGET: RemoteDaemonTarget = { baseUrl: 'http://127.0.0.1:3421', token: 'op-token', isLocal: true };

function answering(body: unknown, status = 200): DaemonFetch {
  return async () => new Response(JSON.stringify(body), { status });
}

/**
 * A daemon answers in two shapes, and reading one as the other is not subtle.
 *
 * `/api/cluster/*` wraps: `{ ok: true, data }`. `/status`, `/api/health` and
 * `/api/channels/status` answer with the payload itself and use the HTTP status
 * for the verdict. Against a live daemon the wrapped reader called a perfectly
 * healthy 200 from `/status` "the daemon refused the request", because a raw
 * payload has no `ok` field to be true.
 */
describe('reply envelopes', () => {
  test('wrapped is the default, and unwraps data', async () => {
    const outcome = await callDaemonRoute<{ membership: string }>(
      TARGET, '/api/cluster/status', { method: 'GET' }, answering({ ok: true, data: { membership: 'member' } }),
    );
    expect(outcome).toEqual({ ok: true, data: { membership: 'member' } });
  });

  test('wrapped carries the daemon\'s own error and fix through', async () => {
    const outcome = await callDaemonRoute(
      TARGET, '/api/cluster/join', { method: 'POST' },
      answering({ ok: false, error: 'no such group', fix: 'run cluster groups' }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('no such group');
    expect(outcome.fix).toBe('run cluster groups');
  });

  test('raw returns the body itself on a 2xx', async () => {
    const payload = { status: 'running', version: '1.28.0', cluster: { role: 'master' } };
    const outcome = await callDaemonRoute<typeof payload>(
      TARGET, '/status', { method: 'GET', envelope: 'raw' }, answering(payload),
    );
    expect(outcome).toEqual({ ok: true, data: payload });
  });

  test('a raw payload with no `ok` field is NOT read as a refusal', async () => {
    // This is the exact live failure: `{ overall: 'healthy', ... }` has no
    // `ok`, and the wrapped reader turned it into "refused the request".
    const payload = { overall: 'healthy', degradedDomains: [] };
    const wrapped = await callDaemonRoute(TARGET, '/api/health', { method: 'GET' }, answering(payload));
    expect(wrapped.ok).toBe(false);

    const raw = await callDaemonRoute(TARGET, '/api/health', { method: 'GET', envelope: 'raw' }, answering(payload));
    expect(raw.ok).toBe(true);
  });

  test('raw uses the HTTP status for the verdict', async () => {
    const outcome = await callDaemonRoute(
      TARGET, '/api/health', { method: 'GET', envelope: 'raw' }, answering({ error: 'nope' }, 500),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('nope');
  });

  test('raw with an unhelpful error body still names the status and the path', async () => {
    const outcome = await callDaemonRoute(
      TARGET, '/api/health', { method: 'GET', envelope: 'raw' }, answering({}, 503),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('503');
    expect(outcome.error).toContain('/api/health');
  });

  test('null and scalar JSON error payloads produce an HTTP refusal without throwing', async () => {
    for (const payload of [null, false, 42, 'unavailable']) {
      const outcome = await callDaemonRoute(TARGET, '/api/health', { method: 'GET', envelope: 'raw' }, answering(payload, 503));
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('expected a refusal');
      expect(outcome.error).toContain('503');
      expect(outcome.error).toContain('/api/health');
    }
  });

  test('a 401 is a token problem under either envelope', async () => {
    for (const envelope of ['wrapped', 'raw'] as const) {
      const outcome = await callDaemonRoute(
        TARGET, '/status', { method: 'GET', envelope }, answering({}, 401),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toContain('refused the operator token');
    }
  });
});
