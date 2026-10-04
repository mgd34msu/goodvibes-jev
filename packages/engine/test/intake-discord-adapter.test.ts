import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.ts';
import { InboundPoller } from '../sdk/src/platform/intake/poller.ts';
import { aggregateInbox } from '../sdk/src/platform/intake/aggregator.ts';
import * as publicIntake from '../sdk/src/platform/intake/index.ts';
import type { AdapterContext, ProviderPollOptions, ProviderPollResult } from '../sdk/src/platform/intake/provider-adapter.ts';
import { createDiscordInboxAdapter, type DiscordInboxHttp, type DiscordInboxMapper,
  type DiscordInboxCatalog, type DiscordInboxPorts } from '../sdk/src/platform/intake/providers/discord.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const EPOCH = 1_420_070_400_000;
const BASE = EPOCH + 1_000_000;
const NOW = BASE + 100_000;
const TOKEN = 'synthetic-discord-credential';
const RAW = 'Private synthetic body marker';
const SELF = '111';
const OTHER = '222';
const CHANNEL = '333';
const CHANNEL2 = '444';
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
// This is a synthetic host admission decision, not a production redactor.
const mapper: DiscordInboxMapper = input => ({ fromDigest: digest(input.senderId),
  subjectPreview: 'Mapped subject', bodyPreview: 'Mapped body' });
const snowflake = (ms: number, sequence = 0) => ((BigInt(ms - EPOCH) << 22n) + BigInt(sequence)).toString();
function message(ms: number, extra: Record<string, unknown> = {}, sequence = 0): Record<string, unknown> {
  return { id: snowflake(ms, sequence), author: { id: OTHER }, content: RAW, ...extra };
}
type Request = { path: string; params: URLSearchParams; request: Parameters<DiscordInboxHttp>[1] };
type Reply = Awaited<ReturnType<DiscordInboxHttp>>;
const ok = (body: unknown): Reply => ({ ok: true, body });
const catalog = (ids = [CHANNEL]) => ({ complete: true, accountId: SELF, channels: ids.map(id => ({ id, type: 1 as const })) });
function fixture(options: {
  reply?: (request: Request) => Reply | Promise<Reply>;
  listDmChannels?: DiscordInboxCatalog;
  credential?: AdapterContext['credentials']['resolveConfigSecret'];
  mapItem?: DiscordInboxMapper;
  resolveRouteId?: AdapterContext['resolveRouteId'];
  now?: () => number;
} = {}) {
  const calls: Request[] = [];
  const keys: string[] = [];
  const logs: unknown[] = [];
  const catalogs: Parameters<DiscordInboxCatalog>[0][] = [];
  const ctx: AdapterContext = {
    credentials: { resolveRef: async () => { throw new Error('Unexpected resolveRef'); }, resolveConfigSecret: async key => {
      keys.push(key); return options.credential ? options.credential(key) : TOKEN;
    } },
    logger: { info: (...args) => { logs.push(args); }, warn: (...args) => { logs.push(args); }, error: (...args) => { logs.push(args); } },
    ...(options.resolveRouteId ? { resolveRouteId: options.resolveRouteId } : {}),
  };
  const ports: DiscordInboxPorts = {
    now: options.now ?? (() => NOW), mapItem: options.mapItem ?? mapper,
    listDmChannels: async input => { catalogs.push(input); return options.listDmChannels ? options.listDmChannels(input) : catalog(); },
    http: async (url, request) => {
      expect(url.origin).toBe('https://discord.com');
      expect(request.method).toBe('GET');
      expect(url.pathname).not.toBe('/api/v10/users/@me/channels');
      const call = { path: url.pathname.slice('/api/v10'.length), params: url.searchParams, request };
      calls.push(call);
      if (options.reply) return options.reply(call);
      return ok(call.path === '/users/@me' ? { id: SELF } : [message(BASE)]);
    },
  };
  return { adapter: createDiscordInboxAdapter(ctx, ports), calls, keys, logs, catalogs, ctx, ports };
}
const historyFixture = (history: (request: Request) => Reply | Promise<Reply>) =>
  (request: Request) => request.path === '/users/@me' ? ok({ id: SELF }) : history(request);
function historyServer(data: Record<string, Record<string, unknown>[]>) {
  return historyFixture(request => {
    const channel = request.path.split('/')[2]!;
    const before = BigInt(request.params.get('before')!);
    const messages = (data[channel] ?? []).filter(row => BigInt(String(row.id)) < before)
      .sort((a, b) => BigInt(String(a.id)) > BigInt(String(b.id)) ? -1 : 1)
      .slice(0, Number(request.params.get('limit')));
    return ok(messages);
  });
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function integrated(f: ReturnType<typeof fixture>, limit = 50) {
  const dir = makeProjectTempDir('discord-inbox');
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new InboxCursorStore(dir, undefined, { now: () => 0, sweepIntervalMs: 0 });
  await store.init();
  cleanups.push(() => store.close());
  const poller = new InboundPoller({ adapters: new Map([['discord', f.adapter]]), store, logger: f.ctx.logger, perProviderLimit: limit });
  cleanups.push(() => poller.stop());
  return { dir, store, poller };
}
function expectUnavailable(result: ProviderPollResult, configured: boolean | undefined) {
  expect(result.state).toBe('unavailable');
  expect(result.items).toEqual([]);
  expect(result.error).toBeTruthy();
  expect(result.configured).toBe(configured);
  if (configured === undefined) expect(result).not.toHaveProperty('configured');
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(JSON.stringify(result)).not.toContain(RAW);
}

describe('private Discord adapter admission and catalog', () => {
  test('no registration or public subpath; requires all three ports without side effects', () => {
    const f = fixture();
    expect(publicIntake).not.toHaveProperty('createDiscordInboxAdapter');
    expect(publicIntake.buildAdapters(f.ctx, ['discord']).size).toBe(0);
    const consumer = fileURLToPath(new URL('../../../products/daemon', import.meta.url));
    expect(Bun.resolveSync('@goodvibes-jev/engine/sdk/platform/intake', consumer)).toBe(fileURLToPath(new URL('../sdk/src/platform/intake/index.ts', import.meta.url)));
    expect(() => Bun.resolveSync('@goodvibes-jev/engine/sdk/platform/intake/providers/discord', consumer)).toThrow();
    for (const missing of ['http', 'mapItem', 'listDmChannels'] as const) {
      expect(() => createDiscordInboxAdapter(f.ctx, { ...f.ports, [missing]: undefined } as unknown as DiscordInboxPorts)).toThrow('requires HTTP');
    }
    expect(f.calls).toEqual([]); expect(f.keys).toEqual([]); expect(f.catalogs).toEqual([]);
    expect(f.adapter.pollIntervalMs).toBe(30_000);
  });
  test.each([null, '', '   '])('missing credential %p is unconfigured', async token => {
    const f = fixture({ credential: async () => token });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), false);
    expect(f.keys).toEqual(['surfaces.discord.botToken']); expect(f.calls).toEqual([]); expect(f.catalogs).toEqual([]);
  });
  test('credential error is unknown and does not echo exception data', async () => {
    const f = fixture({ credential: async () => { throw new Error(`${TOKEN} ${RAW}`); } });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), undefined);
    expect(f.calls).toEqual([]); expect(f.logs).toEqual([]);
  });
  test('rotation re-resolves credentials and self identity each poll', async () => {
    let round = 0;
    const tokens = [TOKEN, 'rotated-synthetic-token'];
    const f = fixture({ credential: async () => tokens[round++]! });
    await f.adapter.poll({ limit: 50 }); await f.adapter.poll({ limit: 50 });
    expect(f.keys).toHaveLength(2);
    expect(f.calls.map(call => call.request.headers.Authorization)).toEqual([`Bot ${tokens[0]}`, `Bot ${tokens[0]}`, `Bot ${tokens[1]}`, `Bot ${tokens[1]}`]);
  });
  test('requires self identity; cannot silently downgrade mention classification', async () => {
    const f = fixture({ reply: () => ok({}) });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true);
    expect(f.catalogs).toEqual([]);
  });
  test.each([
    { ...catalog(), complete: false }, { ...catalog(), accountId: OTHER },
    { ...catalog(), channels: [{ id: CHANNEL, type: 0 }] },
    { ...catalog(), channels: [{ id: 'not-a-channel', type: 1 }] },
    { ...catalog(), channels: Array.from({ length: 201 }, (_, i) => ({ id: String(i + 1), type: 1 })) },
    null,
  ])('refuses incomplete, wrong-account or invalid catalog %p', async value => {
    const f = fixture({ listDmChannels: async () => value as Awaited<ReturnType<DiscordInboxCatalog>> });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true);
    expect(f.calls).toHaveLength(1);
  });
  test('catalog gets self/horizon/signal but no credential; duplicate DMs scanned once', async () => {
    const controller = new AbortController();
    const f = fixture({ listDmChannels: async () => ({ ...catalog(), channels: [{ id: CHANNEL, type: 1 }, { id: CHANNEL, type: 3 }] }) });
    expect((await f.adapter.poll({ limit: 50, signal: controller.signal })).state).toBe('ready');
    expect(f.catalogs).toEqual([{ selfId: SELF, beforeMs: NOW, signal: controller.signal }]);
    expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(f.catalogs)).not.toContain(TOKEN);
  });
  test('complete empty catalog is configured empty', async () => {
    const f = fixture({ listDmChannels: async () => catalog([]) });
    expect(await f.adapter.poll({ limit: 50 })).toEqual({ items: [], state: 'empty', configured: true });
    expect(f.calls).toHaveLength(1);
  });
  test.each([0, -1, 0.5, 1001, Number.NaN])('rejects invalid item budget %p before credentials', async limit => {
    const f = fixture(); expectUnavailable(await f.adapter.poll({ limit }), undefined); expect(f.keys).toEqual([]);
  });
  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid watermark %p', async since => {
    const f = fixture(); expectUnavailable(await f.adapter.poll({ limit: 50, since }), undefined); expect(f.keys).toEqual([]);
  });
  test.each([0, EPOCH, Number.NaN, Number.MAX_SAFE_INTEGER])('rejects invalid horizon %p', async now => {
    const f = fixture({ now: () => now }); expectUnavailable(await f.adapter.poll({ limit: 50 }), undefined); expect(f.keys).toEqual([]);
  });
});

describe('Discord structured mapping and privacy boundary', () => {
  test('preserves exact IDs, structured kind precedence, bot exclusion and sender fallback', async () => {
    const f = fixture({ reply: historyFixture(() => ok([
      message(BASE, { author: { id: SELF }, mentions: [{ id: SELF }], reactions: [{}], referenced_message: {} }),
      message(BASE + 1, { mentions: [{ id: SELF }], referenced_message: {} }),
      message(BASE + 2, { referenced_message: {} }),
      message(BASE + 3, { reactions: [{}], content: 'urgent spam priority <@111>' }),
      message(BASE + 4, { author: { id: SELF, bot: true }, reactions: [{}] }),
      message(BASE + 5, { author: undefined, referenced_message: null }),
    ])) });
    const result = await f.adapter.poll({ limit: 50 });
    expect(result.items.map(item => item.kind)).toEqual(['reaction', 'mention', 'thread', 'dm', 'dm']);
    expect(result.items.map(item => item.id)).toEqual([0, 1, 2, 3, 5].map(i => `discord:${CHANNEL}:${snowflake(BASE + i)}`));
    expect(result.items.at(-1)?.fromDigest).toBe(digest(CHANNEL));
    expect(result.items[0]).toMatchObject({ provider: 'discord', unread: true, fromDigest: digest(SELF), bodyPreview: 'Mapped body' });
    expect(JSON.stringify(result)).not.toContain(RAW);
  });
  test('sender fallback is not evidence of own-message authorship', async () => {
    const f = fixture({ listDmChannels: async () => catalog([SELF]),
      reply: historyFixture(() => ok([message(BASE, { author: undefined, reactions: [{}] })])) });
    const result = await f.adapter.poll({ limit: 50 });
    expect(result.items[0]?.kind).toBe('dm'); expect(result.items[0]?.fromDigest).toBe(digest(SELF));
  });
  test('snowflake is canonical watermark even if optional timestamp is absent, malformed or inconsistent', async () => {
    const f = fixture({ reply: historyFixture(() => ok([
      message(BASE), message(BASE + 1, { timestamp: 'not-iso' }),
      message(BASE + 2, { timestamp: '2017-07-11T17:27:07.299000+00:00' }),
    ])) });
    expect((await f.adapter.poll({ limit: 50 })).items.map(item => item.receivedAt)).toEqual([BASE, BASE + 1, BASE + 2]);
  });
  test('accepts canonical unsigned-64 boundary IDs with finite creation milliseconds', async () => {
    const maximum = ((1n << 64n) - 1n).toString();
    const cutoff = Number(((1n << 64n) - 1n) >> 22n) + EPOCH;
    const f = fixture({ now: () => cutoff,
      reply: historyFixture(() => ok([message(cutoff - 1, { author: { id: maximum } }, 4_194_303)])) });
    const result = await f.adapter.poll({ limit: 50, since: 0 });
    expect(result.state).toBe('ready'); expect(result.items[0]?.receivedAt).toBe(cutoff - 1);
    expect(Number.isSafeInteger(result.items[0]?.receivedAt)).toBe(true);
    expect(result.items[0]?.fromDigest).toBe(digest(maximum));
  });
  test.each(['0', '-1', '01', '1.2', '1e2', '18446744073709551616', '999999999999999999999', 123, null])('rejects malformed message snowflake %p', async id => {
    const f = fixture({ reply: historyFixture(() => ok([message(BASE, { id })])) });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true);
  });
  test.each([
    { author: { id: OTHER, bot: 'false' } }, { author: null }, { author: { id: 'bad' } },
    { mentions: {} }, { mentions: [{ id: 'bad' }] }, { reactions: {} }, { referenced_message: false },
    { content: 123 }, { content: 'x'.repeat(40_001) }, { channel_id: CHANNEL2 },
  ])('malformed protocol data withholds entire poll %p', async extra => {
    const f = fixture({ reply: historyFixture(() => ok([message(BASE), message(BASE + 1, extra)])) });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true);
  });
  test.each([null, undefined, { fromDigest: 111 }, { fromDigest: ['a'.repeat(16)] },
    { fromDigest: { toString: () => 'a'.repeat(16) } }, { fromDigest: 'a'.repeat(15) },
    { subjectPreview: 'x'.repeat(201) }, { bodyPreview: 'x'.repeat(501) }, { bodyPreview: 0 },
  ])('rejects withheld or malformed mapping %p', async change => {
    const f = fixture({ mapItem: async input => change == null ? change
      : { ...(await mapper(input)), ...change } as Awaited<ReturnType<DiscordInboxMapper>> });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true);
  });
  test('mapper receives raw fields and only admitted projected primitives leave adapter', async () => {
    const inputs: unknown[] = [];
    const f = fixture({ mapItem: input => { inputs.push(input); return {
      fromDigest: digest(input.senderId), subjectPreview: 'Approved', bodyPreview: 'Safe', raw: RAW, senderId: OTHER,
    }; } });
    const { store, poller } = await integrated(f);
    await poller.pollOnce();
    expect(inputs).toEqual([{ senderId: OTHER, channelId: CHANNEL, subject: 'Direct message', text: RAW }]);
    expect(store.listItems({ limit: 50 })).toHaveLength(1);
    const aggregate = aggregateInbox({ store, poller }, { limit: 50 });
    expect(aggregate.items[0]).toMatchObject({ from: digest(OTHER), bodyPreview: 'Safe' });
    expect(JSON.stringify([aggregate, f.logs])).not.toContain(RAW);
  });
  test('reads each mapper primitive exactly once for both validation and projection', async () => {
    const reads = { fromDigest: 0, subjectPreview: 0, bodyPreview: 0 };
    const f = fixture({ mapItem: () => ({
      get fromDigest() { return ++reads.fromDigest === 1 ? digest(OTHER) : RAW; },
      get subjectPreview() { return ++reads.subjectPreview === 1 ? 'Safe' : RAW; },
      get bodyPreview() { return ++reads.bodyPreview === 1 ? 'Safe' : RAW; },
    }) });
    const result = await f.adapter.poll({ limit: 50 });
    expect(result.state).toBe('ready'); expect(reads).toEqual({ fromDigest: 1, subjectPreview: 1, bodyPreview: 1 });
    expect(JSON.stringify(result)).not.toContain(RAW);
  });
  test('optional route receives only digest; route failure and async logger rejection stay contained', async () => {
    const routes: unknown[] = [];
    const f = fixture({ resolveRouteId: async input => { routes.push(input); throw new Error(`${TOKEN} ${RAW}`); } });
    f.ctx.logger.warn = async (...args) => { f.logs.push(args); throw new Error(RAW); };
    const result = await f.adapter.poll({ limit: 50 });
    expect(result.state).toBe('ready'); expect(result.items[0]).not.toHaveProperty('routeId');
    expect(routes).toEqual([{ provider: 'discord', fromDigest: digest(OTHER), kind: 'dm' }]);
    expect(f.logs).toEqual([['Discord route resolution failed']]);
  });
  test('resolved route is retained', async () => {
    const f = fixture({ resolveRouteId: async () => 'profile-fixture' });
    expect((await f.adapter.poll({ limit: 50 })).items[0]?.routeId).toBe('profile-fixture');
  });
});

describe('Discord complete-window pagination and durable cursor', () => {
  test('newest-first pages and later channels cannot skip older rows over poller/store restart', async () => {
    const data = { [CHANNEL]: Array.from({ length: 75 }, (_, i) => message(BASE + 100 + i)),
      [CHANNEL2]: Array.from({ length: 25 }, (_, i) => message(BASE + i)) };
    const f = fixture({ reply: historyServer(data), listDmChannels: async () => catalog([CHANNEL, CHANNEL2]) });
    const first = await integrated(f, 30);
    await first.poller.pollOnce();
    expect(first.store.getCursor('discord')).toBe(BASE + 104);
    expect(first.store.countItems()).toBe(30);
    await first.poller.stop(); await first.store.close();
    const store = new InboxCursorStore(first.dir, undefined, { now: () => 0, sweepIntervalMs: 0 });
    await store.init(); cleanups.push(() => store.close());
    const poller = new InboundPoller({ adapters: new Map([['discord', f.adapter]]), store, logger: f.ctx.logger, perProviderLimit: 30 });
    cleanups.push(() => poller.stop());
    for (let i = 0; i < 4; i += 1) await poller.pollOnce();
    expect(store.countItems()).toBe(100); expect(store.getCursor('discord')).toBe(BASE + 174);
    expect(new Set(store.listItems({ limit: 500 }).map(item => item.id)).size).toBe(100);
    for (const call of f.calls.filter(call => call.path !== '/users/@me')) {
      expect(call.params.get('limit')).toBe('50'); expect(call.params.has('before')).toBe(true);
      expect(call.params.has('after')).toBe(false); expect(call.params.has('around')).toBe(false);
    }
  });
  test('cross-channel timestamp group is wholly withheld at boundary then fully persisted', async () => {
    const data = { [CHANNEL]: [message(BASE), message(BASE + 1, {}, 1)],
      [CHANNEL2]: [message(BASE + 1, {}, 2), message(BASE + 2)] };
    const f = fixture({ reply: historyServer(data), listDmChannels: async () => catalog([CHANNEL, CHANNEL2]) });
    const { store, poller } = await integrated(f, 2);
    await poller.pollOnce(); expect(store.countItems()).toBe(1); expect(store.getCursor('discord')).toBe(BASE);
    await poller.pollOnce(); expect(store.countItems()).toBe(3); expect(store.getCursor('discord')).toBe(BASE + 1);
    await poller.pollOnce(); expect(store.countItems()).toBe(4); expect(store.getCursor('discord')).toBe(BASE + 2);
  });
  test('oversized oldest timestamp bucket is explicitly unavailable and cannot advance cursor', async () => {
    const f = fixture({ reply: historyFixture(() => ok([message(BASE, {}, 1), message(BASE, {}, 2), message(BASE, {}, 3)])) });
    const { store, poller } = await integrated(f, 2);
    await poller.pollOnce(); expect(store.countItems()).toBe(0); expect(store.getCursor('discord')).toBe(0);
    expect(poller.snapshotStatuses()[0]).toMatchObject({ state: 'unavailable', configured: true, error: 'Discord item budget cannot cover timestamp group' });
  });
  test('duplicate rows do not consume candidate budget', async () => {
    const rows = [message(BASE + 1), message(BASE), message(BASE), message(BASE + 2)];
    const f = fixture({ reply: historyFixture(() => ok(rows)) });
    expect((await f.adapter.poll({ limit: 2 })).items.map(item => item.receivedAt)).toEqual([BASE, BASE + 1]);
  });
  test('freezes exclusive horizon before credential/catalog waits and defers its entire ms bucket', async () => {
    let now = BASE + 2;
    const data = { [CHANNEL]: [message(BASE), message(BASE + 2, {}, 1)],
      [CHANNEL2]: [message(BASE + 1), message(BASE + 2, {}, 2)] };
    let clocks = 0;
    const f = fixture({ now: () => { clocks += 1; return now; }, credential: async () => { now += 10; return TOKEN; },
      listDmChannels: async () => catalog([CHANNEL, CHANNEL2]), reply: historyServer(data) });
    const result = await f.adapter.poll({ limit: 50 });
    expect(clocks).toBe(1); expect(result.items.map(item => item.receivedAt)).toEqual([BASE, BASE + 1]);
    expect(f.calls.filter(call => call.path !== '/users/@me').map(call => call.params.get('before'))).toEqual([snowflake(BASE + 2), snowflake(BASE + 2)]);
    const next = await f.adapter.poll({ limit: 50, since: BASE + 1 });
    expect(next.items.map(item => item.receivedAt)).toEqual([BASE + 2, BASE + 2]);
  });
  test('raw minimum snowflake advances even when full first page is all bots and unordered', async () => {
    const bots = Array.from({ length: 50 }, (_, i) => message(BASE + 1 + i, { author: { id: OTHER, bot: true } })).reverse();
    const f = fixture({ reply: historyFixture(request => request.params.get('before') === snowflake(NOW) ? ok(bots.reverse()) : ok([message(BASE)])) });
    expect((await f.adapter.poll({ limit: 50 })).items.map(item => item.receivedAt)).toEqual([BASE]);
    expect(f.calls.at(-1)?.params.get('before')).toBe(snowflake(BASE + 1));
  });
  test('exact final full page that crosses since is complete without an unnecessary request', async () => {
    const data = { [CHANNEL]: Array.from({ length: 1_000 }, (_, i) => message(BASE + i)) };
    const f = fixture({ reply: historyServer(data) });
    const result = await f.adapter.poll({ limit: 50, since: BASE });
    expect(result.state).toBe('ready'); expect(result.items).toHaveLength(50); expect(f.calls).toHaveLength(21);
  });
  test('20 full pages without completion are unavailable instead of truncating history', async () => {
    const data = { [CHANNEL]: Array.from({ length: 1_000 }, (_, i) => message(BASE + i)) };
    const f = fixture({ reply: historyServer(data) });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true); expect(f.calls).toHaveLength(21);
  });
  test('short page completing at exact per-channel cap succeeds', async () => {
    const data = { [CHANNEL]: Array.from({ length: 999 }, (_, i) => message(BASE + i)) };
    const f = fixture({ reply: historyServer(data) });
    expect((await f.adapter.poll({ limit: 50 })).state).toBe('ready'); expect(f.calls).toHaveLength(21);
  });
  test('global page cap refuses remaining channels, including empty ones', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => String(i + 1_000));
    const data = { [ids[0]!]: Array.from({ length: 50 }, (_, i) => message(BASE + i)) };
    const f = fixture({ listDmChannels: async () => catalog(ids), reply: historyServer(data) });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true); expect(f.calls).toHaveLength(201);
  });
  test('complete exactly 200 single-page channels succeeds', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => String(i + 1_000));
    const f = fixture({ listDmChannels: async () => catalog(ids), reply: historyServer({}) });
    expect((await f.adapter.poll({ limit: 50 })).state).toBe('empty'); expect(f.calls).toHaveLength(201);
  });
  test('repeated/non-decreasing cursor and horizon violations withhold poll', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => message(BASE + i));
    const f = fixture({ reply: historyFixture(() => ok(rows)) });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true); expect(f.calls).toHaveLength(3);
    const future = fixture({ reply: historyFixture(() => ok([message(NOW)])) });
    expectUnavailable(await future.adapter.poll({ limit: 50 }), true);
  });
});

describe('Discord failures and owned cancellation', () => {
  test.each(['self', 'catalog', 'history', 'mapper'] as const)('hostile Proxy rejection at %s cannot escape or leak', async stage => {
    const hostile = new Proxy({}, { get() { throw RAW; }, getPrototypeOf() { throw RAW; } });
    const f = fixture({
      reply: request => { if (stage === 'self' || (stage === 'history' && request.path !== '/users/@me')) throw hostile;
        return ok(request.path === '/users/@me' ? { id: SELF } : [message(BASE)]); },
      listDmChannels: async () => { if (stage === 'catalog') throw hostile; return catalog(); },
      mapItem: input => { if (stage === 'mapper') throw hostile; return mapper(input); },
    });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true); expect(f.logs).toEqual([]);
  });
  test.each([false, null, {}, 'private-response', Array.from({ length: 51 }, () => message(BASE))])('invalid history response %p fails closed', async body => {
    const f = fixture({ reply: historyFixture(() => ok(body)) });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true);
  });
  test('failure in later channel preserves mirror/cursor and reports aggregate partial', async () => {
    let fail = false;
    const f = fixture({ listDmChannels: async () => catalog([CHANNEL, CHANNEL2]), reply: historyFixture(request => {
      if (fail && request.path.includes(CHANNEL2)) return { ok: false, body: { error: TOKEN, message: RAW } };
      return ok([message(fail ? BASE + 1 : BASE)]);
    }) });
    const { store, poller } = await integrated(f);
    await poller.pollOnce(); expect(store.countItems()).toBe(2); expect(store.getCursor('discord')).toBe(BASE);
    fail = true; await poller.pollOnce();
    expect(store.countItems()).toBe(2); expect(store.getCursor('discord')).toBe(BASE);
    const aggregate = aggregateInbox({ store, poller }, { limit: 50 });
    expect(aggregate.partial).toBe(true); expect(aggregate.providers[0]).toMatchObject({ configured: true, state: 'error', storedCount: 2 });
    expect(JSON.stringify(aggregate)).not.toContain(RAW); expect(f.logs).toEqual([]);
  });
  test('mapper withholding after one selected row cannot partially persist', async () => {
    let mapped = 0;
    const f = fixture({ reply: historyFixture(() => ok([message(BASE), message(BASE + 1)])),
      mapItem: input => ++mapped === 1 ? mapper(input) : null });
    const { store, poller } = await integrated(f); await poller.pollOnce();
    expect(store.countItems()).toBe(0); expect(store.getCursor('discord')).toBe(0);
    expect(poller.snapshotStatuses()[0]?.state).toBe('unavailable');
  });
  test('throwing option/signal accessors cannot reject and options are read once', async () => {
    const f = fixture();
    const badOptions = Object.defineProperty({ limit: 50 }, 'signal', { get() { throw new Error(RAW); } }) as ProviderPollOptions;
    expectUnavailable(await f.adapter.poll(badOptions), undefined);
    const badSignal = Object.defineProperty({}, 'aborted', { get() { throw new Error(RAW); } }) as AbortSignal;
    expectUnavailable(await f.adapter.poll({ limit: 50, signal: badSignal }), undefined);
    const reads = { limit: 0, since: 0, signal: 0 };
    expect((await f.adapter.poll({
      get limit() { reads.limit += 1; return reads.limit === 1 ? 50 : 0; },
      get since() { reads.since += 1; return BASE - 1; },
      get signal() { reads.signal += 1; return new AbortController().signal; },
    })).state).toBe('ready');
    expect(reads).toEqual({ limit: 1, since: 1, signal: 1 });
  });
  test('empty mapping object is unavailable', async () => {
    const f = fixture({ mapItem: () => ({}) as Awaited<ReturnType<DiscordInboxMapper>> });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true);
  });
  test('pre-aborted signal does no credential/transport/catalog work', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expectUnavailable(await f.adapter.poll({ limit: 50, signal: controller.signal }), undefined);
    expect(f.keys).toEqual([]); expect(f.calls).toEqual([]); expect(f.catalogs).toEqual([]);
  });
  test.each(['credential', 'self', 'catalog', 'history', 'mapper', 'route', 'logger'] as const)(
    'stop drains late %s work and suppresses all persistence and continuation', async stage => {
      const entered = deferred<void>(); const release = deferred<void>();
      const wait = async () => { entered.resolve(); await release.promise; };
      const f = fixture({ credential: async () => { if (stage === 'credential') await wait(); return TOKEN; },
        listDmChannels: async () => { if (stage === 'catalog') await wait(); return catalog(); },
        reply: async request => {
          if (stage === (request.path === '/users/@me' ? 'self' : 'history')) await wait();
          return ok(request.path === '/users/@me' ? { id: SELF } : [message(BASE)]);
        }, mapItem: async input => { if (stage === 'mapper') await wait(); return mapper(input); },
        resolveRouteId: async () => { if (stage === 'route') await wait(); if (stage === 'logger') throw new Error(RAW); return 'route'; },
      });
      if (stage === 'logger') f.ctx.logger.warn = async () => { await wait(); throw new Error(RAW); };
      const { store, poller } = await integrated(f);
      const polling = poller.pollOnce(); await entered.promise;
      const callsAtStop = f.calls.length; const catalogsAtStop = f.catalogs.length;
      let stopped = false; const stopping = poller.stopProvider('discord').then(() => { stopped = true; });
      await Promise.resolve(); await Promise.resolve(); expect(stopped).toBe(false);
      release.resolve(); await Promise.all([polling, stopping]);
      expect(stopped).toBe(true); expect(store.countItems()).toBe(0); expect(store.getCursor('discord')).toBe(0);
      expect(f.calls).toHaveLength(callsAtStop); expect(f.catalogs).toHaveLength(catalogsAtStop);
      expect(poller.snapshotStatuses()[0]?.polled).toBe(false);
      for (const call of f.calls) expect(call.request.signal?.aborted).toBe(true);
    },
  );
});
