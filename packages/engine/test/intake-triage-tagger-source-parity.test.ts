/** Original daemon254699bf tagger cases through the current composition facade. */
import { afterEach, expect, test } from 'bun:test';
import { createTriageTagger, type TriageTaggerOptions } from '../sdk/src/platform/intake/triage/tagger/index.js';
import type { ImapStoreArgs } from '../sdk/src/platform/intake/triage/tagger/imap.js';
import { triageCredentials } from './_helpers/intake-triage-credentials.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const credentialKey = 'synthetic-provider-key';
const token = 'synthetic-provider-value';
const guard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
function fixture(provider: TriageTaggerOptions['provider'], options: {
  credentials?: ReturnType<typeof triageCredentials>;
  responses?: Array<Response | Error>;
  imapStoreFlag?: TriageTaggerOptions['imapStoreFlag'];
  forumTagIds?: TriageTaggerOptions['forumTagIds'];
} = {}) {
  const credentials = options.credentials ?? triageCredentials({ [credentialKey]: token });
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stores: ImapStoreArgs[] = [];
  const responses = options.responses ?? [];
  const tagger = createTriageTagger({ provider, accountScopeId: 'account', credentialKey,
    credentials: credentials.credentials, captureCredential: () => credentials.capture(credentialKey), ...guard(),
    imap: { host: 'imap.example.test', port: 993, user: 'mailbot', mailbox: 'INBOX' },
    ...(options.forumTagIds ? { forumTagIds: options.forumTagIds } : {}),
    imapStoreFlag: options.imapStoreFlag ?? (async args => { stores.push(args); }),
    http: Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error('Unexpected synthetic provider call');
      return response;
    }, { preconnect: fetch.preconnect }),
  });
  cleanups.push(() => tagger.close());
  return { tagger, credentials, calls, stores };
}

test('original credential helper resolves both keys, supports setup writes, and fences ABA', async () => {
  const f = triageCredentials({ key: 'first' });
  expect(await f.credentials.resolveRef('key')).toBe('first');
  expect(await f.credentials.resolveConfigSecret('missing')).toBeNull();
  expect(await f.has('key')).toBe(true); expect(await f.has('missing')).toBe(false);
  const before = f.capture('key');
  await f.put('key', 'second'); await f.put('key', 'first');
  expect(await f.credentials.resolveConfigSecret('key')).toBe('first');
  expect(() => before.assertCurrent()).toThrow('changed');
});

test('email facade applies exact normalized keyword, resolved password and one concrete UID', async () => {
  const f = fixture('email');
  await f.tagger.applyTags('email:account:0000000007:0000000042', ['GoodVibes/Spam'], guard());
  expect(f.stores).toHaveLength(1);
  expect(f.stores[0]).toMatchObject({ host: 'imap.example.test', port: 993, user: 'mailbot', mailbox: 'INBOX',
    uid: '42', uidValidity: 7, flag: 'GoodVibes_Spam', password: token });
});

test.each(['email:account:7:', 'email:account:7:0', 'email:account:7:1:*', 'email:other:7:42'])('email missing or foreign target %s never calls STORE', async id => {
  const f = fixture('email');
  await expect(f.tagger.applyTags(id, ['GoodVibes/Spam'], guard())).rejects.toThrow();
  expect(f.stores).toEqual([]);
});

test.each(['email', 'slack', 'discord'] as const)('%s unresolved credential refuses without provider effects', async provider => {
  const f = fixture(provider, { credentials: triageCredentials() });
  const id = provider === 'email' ? 'email:account:7:42' : provider === 'slack' ? 'slack:C123:111.222' : 'discord:123:234';
  await expect(f.tagger.applyTags(id, ['GoodVibes/Normal'], guard())).rejects.toThrow('credential');
  expect(f.calls).toEqual([]); expect(f.stores).toEqual([]);
});

test('email facade retries two transient socket resets and stops at first success', async () => {
  let attempts = 0;
  const f = fixture('email', { imapStoreFlag: async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('synthetic reset'), { code: 'ECONNRESET' });
  } });
  await f.tagger.applyTags('email:account:7:9', ['GoodVibes/Priority'], guard());
  expect(attempts).toBe(3);
});

test('Slack facade resolves bearer token and preserves already_reacted idempotence', async () => {
  const f = fixture('slack', { responses: [Response.json({ ok: false, error: 'already_reacted' })] });
  await f.tagger.applyTags('slack:C123:111.222', ['GoodVibes/Spam'], guard());
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.url).toBe('https://slack.com/api/reactions.add');
  expect(f.calls[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ channel: 'C123', timestamp: '111.222', name: 'no_entry_sign' });
});

test('Slack facade retains a hard provider refusal', async () => {
  const f = fixture('slack', { responses: [Response.json({ ok: false, error: 'channel_not_found' })] });
  await expect(f.tagger.applyTags('slack:C123:111.222', ['GoodVibes/Spam'], guard())).rejects.toThrow('rejected');
  expect(f.calls).toHaveLength(1);
});

test('Discord facade without a forum mapping uses the exact priority reaction', async () => {
  const f = fixture('discord', { responses: [new Response(null, { status: 204 })] });
  await f.tagger.applyTags('discord:123:234', ['GoodVibes/Priority'], guard());
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.init).toMatchObject({ method: 'PUT', headers: { Authorization: `Bot ${token}` } });
  expect(f.calls[0]!.url).toBe(`https://discord.com/api/v10/channels/123/messages/234/reactions/${encodeURIComponent('🚨')}/@me`);
});

test('Discord facade merges the observed forum set and deduplicates existing target tags', async () => {
  const f = fixture('discord', { forumTagIds: { 'GoodVibes/Spam': '890', 'GoodVibes/Priority': '789' }, responses: [
    Response.json({ id: '123', type: 11, parent_id: '456', applied_tags: ['789'] }),
    Response.json({ id: '456', type: 15 }), new Response(null, { status: 204 }),
  ] });
  await f.tagger.applyTags('discord:123:234', ['GoodVibes/Spam', 'GoodVibes/Priority'], guard());
  expect(f.calls.map(call => call.init.method ?? 'GET')).toEqual(['GET', 'GET', 'PATCH']);
  expect(JSON.parse(String(f.calls[2]!.init.body))).toEqual({ applied_tags: ['789', '890'] });
});

test.each(['status', 'network'] as const)('Discord facade cannot PATCH after a failed %s observation', async failure => {
  const f = fixture('discord', { forumTagIds: { 'GoodVibes/Spam': '890' }, responses: [
    failure === 'status' ? new Response('synthetic unavailable', { status: 500 }) : new Error('synthetic network failure'),
  ] });
  await expect(f.tagger.applyTags('discord:123:234', ['GoodVibes/Spam'], guard())).rejects.toThrow();
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.init.method).toBeUndefined();
});
