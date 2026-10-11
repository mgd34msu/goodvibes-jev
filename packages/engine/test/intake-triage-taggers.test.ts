import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createTriageTagger } from '../sdk/src/platform/intake/triage/tagger/index.ts';
import { captureTags } from '../sdk/src/platform/intake/triage/tagger/shared.ts';
import { applySlackTags } from '../sdk/src/platform/intake/triage/tagger/slack.ts';
import { applyDiscordTags } from '../sdk/src/platform/intake/triage/tagger/discord.ts';
import { imapStoreFlagOverTls, makeRetryingImapStoreFlag, ImapStoreError, type ImapStoreArgs, type ImapSocketLike } from '../sdk/src/platform/intake/triage/tagger/imap.ts';
const guard = () => ({ signal: new AbortController().signal, assertCurrent() {} });
function http(responses: Array<Response | (() => Response)>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); const response = responses.shift(); if (!response) throw new Error('unexpected call'); return typeof response === 'function' ? response() : response; }) as typeof fetch;
  return { calls, fetcher };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
test('fixed canonical labels refuse heuristic substrings and arbitrary flags', () => {
  expect(captureTags(['GoodVibes/Spam', 'GoodVibes/Spam'])).toEqual(['GoodVibes/Spam']);
  for (const tag of ['spam', 'NotSpam', 'GoodVibes/spam', '\\Seen', 'GoodVibes/Priority ']) expect(() => captureTags([tag])).toThrow();
});
test('Slack reactions.add exact target, idempotence and no redirects', async () => {
  const f = http([response({ ok: false, error: 'already_reacted' })]);
  await applySlackTags({ channel: 'C123', timestamp: '123.456' }, ['GoodVibes/Priority'], 'synthetic', guard(), f.fetcher);
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.init.redirect).toBe('error');
  expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ channel: 'C123', timestamp: '123.456', name: 'rotating_light' });
});
test.each([response({ ok: false, error: 'missing_scope' }), response({ ok: true }, 403)])('Slack hard refusals do not continue', async failed => {
  const f = http([failed]);
  await expect(applySlackTags({ channel: 'C123', timestamp: '123.456' }, ['GoodVibes/Spam', 'GoodVibes/Normal'], 'synthetic', guard(), f.fetcher)).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});
test('Discord real observed forum tags merge, preserving unrelated applied_tags', async () => {
  const f = http([response({ id: '123', type: 11, parent_id: '456', applied_tags: ['789'] }), response({ id: '456', type: 15 }), response({})]);
  await applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Spam'], 'synthetic', guard(), { 'GoodVibes/Spam': '890' }, f.fetcher);
  expect(f.calls.map(call => call.init.method ?? 'GET')).toEqual(['GET', 'GET', 'PATCH']);
  expect(JSON.parse(String(f.calls[2]!.init.body))).toEqual({ applied_tags: ['789', '890'] });
});
test.each([response({}, 403), response({ id: '123', type: 11, parent_id: '456' }), response({ id: 'wrong', type: 11 })])('Discord failed or malformed observations never PATCH', async first => {
  const f = http([first, response({ id: '456', type: 15 })]);
  await expect(applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Spam'], 'synthetic', guard(), { 'GoodVibes/Spam': '890' }, f.fetcher)).rejects.toThrow();
  expect(f.calls.some(call => call.init.method === 'PATCH')).toBe(false);
});
test('Discord DM with a forum mapping remains a reaction', async () => {
  const f = http([response({ id: '123', type: 1 }), new Response(null, { status: 204 })]);
  await applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Normal'], 'synthetic', guard(), { 'GoodVibes/Normal': '890' }, f.fetcher);
  expect(f.calls[1]!.init.method).toBe('PUT'); expect(f.calls[1]!.url).toContain('/messages/234/reactions/');
});
test('Discord revocation after GET prevents PATCH', async () => {
  const abort = new AbortController(); const f = http([response({ id: '123', type: 11, parent_id: '456', applied_tags: [] }), () => { abort.abort(); return response({ id: '456', type: 15 }); }]);
  await expect(applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Spam'], 'synthetic', { signal: abort.signal, assertCurrent() {} }, { 'GoodVibes/Spam': '890' }, f.fetcher)).rejects.toThrow();
  expect(f.calls).toHaveLength(2);
});
function imap(validity = 7, rejected = false) {
  const events = new EventEmitter(); const writes: string[] = [];
  const socket = { setEncoding() {}, setTimeout() {}, on: events.on.bind(events), destroy() {}, write(line: string) {
    writes.push(line); const tag = line.split(' ')[0];
    queueMicrotask(() => { if (line.includes('SELECT')) events.emit('data', `* OK [UIDVALIDITY ${validity}] current\r\n`); events.emit('data', `${tag} ${rejected ? 'NO' : 'OK'} done\r\n`); });
  } } as ImapSocketLike;
  const connect = () => { queueMicrotask(() => events.emit('data', '* OK ready\r\n')); return socket; };
  return { writes, connect };
}
const args = (): ImapStoreArgs => ({ host: 'imap.invalid', port: 993, user: 'a"b', password: 'c\\d', mailbox: 'Inbox', uid: '42', flag: 'GoodVibes_Spam', uidValidity: 7, ...guard() });
test('IMAP quoted login, SELECT UIDVALIDITY then UID STORE and tagged logout', async () => {
  const f = imap(); await imapStoreFlagOverTls(args(), f.connect);
  expect(f.writes).toEqual(['A1 LOGIN "a\\"b" "c\\\\d"\r\n', 'A2 SELECT "Inbox"\r\n', 'A3 UID STORE 42 +FLAGS (GoodVibes_Spam)\r\n', 'A4 LOGOUT\r\n']);
});
test('IMAP mailbox generation mismatch prevents STORE', async () => {
  const f = imap(8); await expect(imapStoreFlagOverTls(args(), f.connect)).rejects.toThrow('UIDVALIDITY');
  expect(f.writes.some(line => line.includes('STORE'))).toBe(false);
});
test.each(['\r', '\n', '\x00', '\x7f'])('IMAP controls refuse before connection', async byte => {
  let calls = 0; await expect(imapStoreFlagOverTls({ ...args(), password: `x${byte}` }, () => { calls++; throw new Error(); })).rejects.toThrow(); expect(calls).toBe(0);
});
test('IMAP NO/BAD never retries; transient retry bounded and revoked retry refused', async () => {
  let calls = 0;
  await expect(makeRetryingImapStoreFlag(async () => { calls++; throw new ImapStoreError('NO', false); }, { sleep: async () => {} })(args())).rejects.toThrow(); expect(calls).toBe(1);
  calls = 0; await expect(makeRetryingImapStoreFlag(async () => { calls++; throw new ImapStoreError('network', true); }, { sleep: async () => {} })(args())).rejects.toThrow(); expect(calls).toBe(3);
});

// A prior command's response code is not evidence for this SELECT mailbox.
test('IMAP greeting or LOGIN UIDVALIDITY cannot authorize a SELECT with no generation', async () => {
  for (const phase of ['greeting', 'login']) {
    const events = new EventEmitter(); const writes: string[] = [];
    const socket = { setEncoding() {}, setTimeout() {}, on: events.on.bind(events), destroy() {}, write(line: string) {
      writes.push(line); const tag = line.split(' ')[0];
      queueMicrotask(() => {
        if (phase === 'login' && line.includes('LOGIN')) events.emit('data', '* OK [UIDVALIDITY 7] prior command\r\n');
        events.emit('data', `${tag} OK completed\r\n`);
      });
    } } as ImapSocketLike;
    await expect(imapStoreFlagOverTls(args(), () => {
      queueMicrotask(() => events.emit('data', phase === 'greeting' ? '* OK [UIDVALIDITY 7] greeting\r\n' : '* OK ready\r\n'));
      return socket;
    })).rejects.toThrow('UIDVALIDITY');
    expect(writes.some(line => line.includes('STORE'))).toBe(false);
  }
});

test('unsupported provider never falls through to an email writer or resolves credentials', () => {
  let reads = 0;
  expect(() => createTriageTagger({ provider: 'unsupported' as never, accountScopeId: 'account', credentialKey: 'synthetic', credentials: { resolveRef: async () => null, resolveConfigSecret: async () => { reads++; return 'synthetic'; } }, captureCredential() { throw new Error('No credential capture'); }, ...guard() })).toThrow('supported provider');
  expect(reads).toBe(0);
});

test('Discord without a forum mapping uses exactly one reaction request and no channel PATCH', async () => {
  const f = http([new Response(null, { status: 204 })]);
  await applyDiscordTags({ channel: '123', message: '234' }, ['GoodVibes/Spam'], 'synthetic', guard(), {}, f.fetcher);
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.init.method).toBe('PUT'); expect(f.calls[0]!.url).toContain('/reactions/');
});
