import { afterEach, expect, spyOn, test } from 'bun:test';
import { Client } from 'undici/index.js';
import * as directClient from '../sdk/src/platform/security/source-screening/direct-client.ts';
import { createSlackInboxOwner } from '../sdk/src/platform/intake/providers/slack-owner.ts';
import { createSlackInboxHttpOwner } from '../sdk/src/platform/intake/providers/slack-http.ts';
import type { ProtectedSourceOwnerOptions } from '../sdk/src/platform/security/source-screening/types.ts';

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const account = { workspaceId: 'T-SYNTHETIC-FENCING', userId: 'U-SYNTHETIC-OWNER' };
const auth = () => new URL('https://slack.com/api/auth.test');
const request = { method: 'GET' as const, headers: { Authorization: 'Bearer xoxb-synthetic-fencing', Accept: 'application/json' as const } };

function endpoint() {
  let status = 200;
  let body: unknown = { ok: true, team_id: account.workspaceId, user_id: account.userId };
  let calls = 0;
  let hasMessage = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(incoming) {
    const path = new URL(incoming.url).pathname;
    if (path === '/api/auth.test') {
      calls++;
      return Response.json(body, { status });
    }
    if (path === '/api/conversations.list') return Response.json({ ok: true,
      channels: hasMessage ? [{ id: 'D-SYNTHETIC', user: 'U-SYNTHETIC-SENDER' }] : [] });
    return Response.json({ ok: true, messages: [{
      ts: `${Math.floor((Date.now() - 2_000) / 1_000)}.000000`, user: 'U-SYNTHETIC-SENDER',
      text: 'Contact person@example.test, keep the build notes.',
    }] });
  } });
  cleanups.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, get calls() { return calls; },
    withMessage() { hasMessage = true; },
    respond(nextBody: unknown, nextStatus = 200) { body = nextBody; status = nextStatus; } };
}

/** Keep the real client and its retirement, observing only its cancellation signal. */
function clientFactory(base: string, onAbort?: () => void, entered?: () => void) {
  return (_origin: 'https://slack.com', options: Client.Options): Client => {
    const client = new Client(base, options);
    if (!onAbort) return client;
    const compose = client.compose.bind(client);
    client.compose = (...args) => {
      const dispatcher = compose(args.flat());
      const actual = dispatcher.request.bind(dispatcher);
      dispatcher.request = ((...input: Parameters<typeof actual>) => {
        const signal = input[0].signal;
        if (signal instanceof AbortSignal) signal.addEventListener('abort', onAbort, { once: true });
        entered?.();
        return actual(...input);
      }) as typeof dispatcher.request;
      return dispatcher;
    };
    return client;
  };
}

async function owner(base: string, onAbort?: () => void, entered?: () => void, screening?: ProtectedSourceOwnerOptions) {
  const owned = await createSlackInboxOwner({ logger: { info() {}, warn() {}, error() {} },
    credentials: { resolveRef: async () => null, resolveConfigSecret: async () => 'xoxb-synthetic-fencing' },
  }, { account, assertCurrent() {}, screening: screening ?? {
    authority: { ownerId: 'synthetic-local-authority', revision: '1', retention: 'ephemeral-no-log',
      signal: new AbortController().signal, assertCurrent() {} },
    // An empty inbox does not submit source content to either service.
    proposal: { endpoint: 'http://127.0.0.1:1', model: 'synthetic-proposer' },
    judgment: { endpoint: 'http://127.0.0.1:1', model: 'jev-1.13.0' },
  } }, { createHttpClient: clientFactory(base, onAbort, entered) });
  cleanups.push(() => owned.close());
  return owned;
}

test.each(['token_revoked', 'invalid_auth', 'account_inactive'])(
  'an explicit auth.test %s denial retires previously verified credential proof', async error => {
    const remote = endpoint();
    const owned = await owner(remote.base);
    expect((await owned.adapter.poll({ limit: 10 })).state).toBe('empty');
    remote.respond({ ok: false, error });
    expect((await owned.adapter.poll({ limit: 10 })).state).toBe('unavailable');
    expect(remote.calls).toBe(2);
    await expect(owned.assertReadCurrent()).rejects.toThrow('scope is unavailable');
    expect(remote.calls).toBe(3);
  },
);

test('a transport HTTP 503 outage preserves unchanged previously verified credential proof', async () => {
  const remote = endpoint();
  const owned = await owner(remote.base);
  expect((await owned.adapter.poll({ limit: 10 })).state).toBe('empty');
  remote.respond({ synthetic: 'unavailable' }, 503);
  expect((await owned.adapter.poll({ limit: 10 })).state).toBe('unavailable');
  const calls = remote.calls;
  await owned.assertReadCurrent();
  expect(remote.calls).toBe(calls);
});

test.each([401, 403])('an auth.test HTTP %s denial retires previously verified credential proof', async status => {
  const remote = endpoint();
  const owned = await owner(remote.base);
  expect((await owned.adapter.poll({ limit: 10 })).state).toBe('empty');
  remote.respond({ synthetic: 'private-denial-body' }, status);
  expect((await owned.adapter.poll({ limit: 10 })).state).toBe('unavailable');
  expect(remote.calls).toBe(2);
  await expect(owned.assertReadCurrent()).rejects.toThrow('scope is unavailable');
  expect(remote.calls).toBe(3);
});

test('a received HTTP 401 invalidates old read eligibility while owned body retirement is still pending', async () => {
  const remote = endpoint();
  const owned = await owner(remote.base);
  expect((await owned.adapter.poll({ limit: 10 })).state).toBe('empty');
  remote.respond({ synthetic: 'private-denial-body' }, 401);
  const cancelling = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const actual = directClient.responseStream;
  const replacement = spyOn(directClient, 'responseStream').mockImplementation(body => {
    // The genuine owned response is retired before synthetic delay begins.
    const retired = actual(body).cancel();
    return new ReadableStream<Uint8Array>({ async cancel() {
      await retired;
      cancelling.resolve();
      await finish.promise;
    } });
  });
  cleanups.push(() => replacement.mockRestore(), () => finish.resolve());
  const polling = owned.adapter.poll({ limit: 10 });
  await cancelling.promise;
  const state: { read: 'pending' | 'accepted' | 'rejected' } = { read: 'pending' };
  const reading = owned.assertReadCurrent().then(() => { state.read = 'accepted'; }, () => { state.read = 'rejected'; });
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(state.read).toBe('pending');
  } finally { finish.resolve(); await Promise.all([polling, reading]); }
  expect(state.read).toBe('rejected');
  expect(remote.calls).toBe(3);
});

test('an older held mapping cannot restore credential proof after a concurrent authentication denial', async () => {
  const remote = endpoint();
  remote.withMessage();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(incoming) {
    if (new URL(incoming.url).pathname === '/v1/chat/completions') {
      const body = await incoming.json() as { messages: Array<{ content: string }> };
      const source = JSON.parse(body.messages[1]!.content) as { revision: string };
      entered.resolve();
      await finish.promise;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({
        revision: source.revision, spans: [{ part: 1, start: 8, end: 27 }, { part: 3, start: 8, end: 27 }],
      }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } },
      usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  cleanups.push(() => local.stop(true));
  const owned = await owner(remote.base, undefined, undefined, {
    authority: { ownerId: 'synthetic-local-authority', revision: '1', retention: 'ephemeral-no-log',
      signal: new AbortController().signal, assertCurrent() {} },
    proposal: { endpoint: `http://127.0.0.1:${local.port}`, model: 'synthetic-proposer' },
    judgment: { endpoint: `http://127.0.0.1:${local.port}`, model: 'jev-1.13.0' },
  });
  cleanups.push(() => finish.resolve());
  const pending = owned.adapter.poll({ limit: 10 });
  await entered.promise;
  remote.respond({ ok: false, error: 'token_revoked' });
  await expect(owned.assertReadCurrent()).rejects.toThrow('scope is unavailable');
  finish.resolve();
  expect(await pending).toMatchObject({ state: 'unavailable', items: [] });
  await expect(owned.assertReadCurrent()).rejects.toThrow('scope is unavailable');
  expect(remote.calls).toBe(3);
});

test('Slack account close publishes one retirement promise before synchronous cancellation callbacks', async () => {
  const remote = endpoint();
  const entered = Promise.withResolvers<void>();
  let reentrant: Promise<void> | undefined;
  const owned = await owner(remote.base, () => { reentrant = owned.close(); }, entered.resolve);
  const pending = owned.assertReadCurrent();
  void pending.catch(() => {});
  await entered.promise;
  const closing = owned.close();
  expect(reentrant).toBe(closing);
  await Promise.all([closing, pending.catch(() => {})]);
});

test('Slack HTTP close publishes one retirement promise before synchronous cancellation callbacks', async () => {
  const remote = endpoint();
  const entered = Promise.withResolvers<void>();
  let reentrant: Promise<void> | undefined;
  const owned = createSlackInboxHttpOwner({ signal: new AbortController().signal, assertCurrent() {},
    createClient: clientFactory(remote.base, () => { reentrant = owned.close(); }, entered.resolve),
  });
  cleanups.push(() => owned.close());
  const pending = owned.http(auth(), request);
  void pending.catch(() => {});
  await entered.promise;
  const closing = owned.close();
  expect(reentrant).toBe(closing);
  await Promise.all([closing, pending.catch(() => {})]);
});
