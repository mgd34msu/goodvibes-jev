import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.ts';
import { InboundPoller } from '../sdk/src/platform/intake/poller.ts';
import { aggregateInbox } from '../sdk/src/platform/intake/aggregator.ts';
import * as publicIntake from '../sdk/src/platform/intake/index.ts';
import type { AdapterContext, ProviderPollOptions, ProviderPollResult } from '../sdk/src/platform/intake/provider-adapter.ts';
import { createSlackInboxAdapter, type SlackInboxHttp, type SlackInboxMapper, type SlackInboxPorts } from '../sdk/src/platform/intake/providers/slack.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const TOKEN = 'xoxb-synthetic-slack-inbox-fixture';
const RAW = 'Private synthetic text from UPRIVATE';
const NOW = 2_000_000;
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
// This fixture is an explicit host admission result, not a production redactor.
const mapper: SlackInboxMapper = input => ({ fromDigest: digest(input.senderId),
  subjectPreview: 'Mapped fixture subject', bodyPreview: 'Mapped fixture body' });
type Request = { method: string; params: URLSearchParams; request: Parameters<SlackInboxHttp>[1] };
type Reply = { ok: boolean; body: unknown };
const ok = (body: Record<string, unknown>): Reply => ({ ok: true, body: { ok: true, ...body } });
function message(ts: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ts, user: 'UOTHER', text: RAW, ...extra };
}
function fixture(options: {
  reply?: (request: Request) => Reply | Promise<Reply>;
  credential?: AdapterContext['credentials']['resolveConfigSecret'];
  mapItem?: SlackInboxMapper;
  resolveRouteId?: AdapterContext['resolveRouteId'];
  now?: () => number;
} = {}) {
  const calls: Request[] = [];
  const keys: string[] = [];
  const logs: unknown[] = [];
  const ctx: AdapterContext = {
    credentials: { resolveRef: async () => { throw new Error('Unexpected resolveRef'); }, resolveConfigSecret: async key => {
      keys.push(key); return options.credential ? options.credential(key) : TOKEN;
    } },
    logger: { info: (...args) => { logs.push(args); }, warn: (...args) => { logs.push(args); }, error: (...args) => { logs.push(args); } },
    ...(options.resolveRouteId ? { resolveRouteId: options.resolveRouteId } : {}),
  };
  const ports: SlackInboxPorts = {
    now: options.now ?? (() => NOW), mapItem: options.mapItem ?? mapper,
    http: async (url, request) => {
      expect(url.origin).toBe('https://slack.com');
      expect(request.method).toBe('GET');
      const call = { method: url.pathname.slice('/api/'.length), params: url.searchParams, request };
      calls.push(call);
      if (options.reply) return options.reply(call);
      if (call.method === 'auth.test') return ok({ user_id: 'USELF' });
      if (call.method === 'conversations.list') return ok({ channels: [{ id: 'D1', user: 'UPARTNER' }] });
      return ok({ messages: [message('1000.000000')] });
    },
  };
  return { adapter: createSlackInboxAdapter(ctx, ports), calls, keys, logs, ctx, ports };
}
function historyFixture(history: (request: Request) => Reply | Promise<Reply>, channels = [{ id: 'D1' }]) {
  return (request: Request) => request.method === 'auth.test' ? ok({ user_id: 'USELF' })
    : request.method === 'conversations.list' ? ok({ channels }) : history(request);
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
  const dir = makeProjectTempDir('slack-inbox');
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const store = new InboxCursorStore(dir, undefined, { now: () => 0, sweepIntervalMs: 0 });
  await store.init();
  cleanups.push(() => store.close());
  const poller = new InboundPoller({ adapters: new Map([['slack', f.adapter]]), store, logger: f.ctx.logger, perProviderLimit: limit });
  cleanups.push(() => poller.stop());
  return { store, poller };
}
function expectUnavailable(result: ProviderPollResult, configured: boolean | undefined) {
  expect(result.state).toBe('unavailable');
  expect(result.items).toEqual([]);
  expect(result.error).toBeTruthy();
  expect(result.configured).toBe(configured);
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(JSON.stringify(result)).not.toContain(RAW);
}

describe('private Slack adapter admission and credentials', () => {
  test('has no default registration or public subpath; requires both ports', () => {
    const f = fixture();
    expect(publicIntake).not.toHaveProperty('createSlackInboxAdapter');
    expect(publicIntake.buildAdapters(f.ctx, ['slack']).size).toBe(0);
    const consumer = fileURLToPath(new URL('../../../products/daemon', import.meta.url));
    expect(Bun.resolveSync('@goodvibes-jev/engine/sdk/platform/intake', consumer)).toBe(fileURLToPath(new URL('../sdk/src/platform/intake/index.ts', import.meta.url)));
    expect(() => Bun.resolveSync('@goodvibes-jev/engine/sdk/platform/intake/providers/slack', consumer)).toThrow();
    expect(() => createSlackInboxAdapter(f.ctx, { http: f.ports.http } as SlackInboxPorts)).toThrow('explicit item mapper');
    expect(() => createSlackInboxAdapter(f.ctx, { mapItem: mapper } as SlackInboxPorts)).toThrow('HTTP');
    expect(f.calls).toEqual([]);
    expect(f.keys).toEqual([]);
    expect(f.adapter.pollIntervalMs).toBe(30_000);
  });
  test.each([null, '', '  ', 'not-a-slack-token'])('missing or unusable token %p is unconfigured', async token => {
    const f = fixture({ credential: async () => token });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), false);
    expect(f.keys).toEqual(['surfaces.slack.botToken']);
    expect(f.calls).toEqual([]);
  });
  test('lookup errors leave configured unknown and never echo secrets', async () => {
    const f = fixture({ credential: async () => { throw new Error(`${TOKEN} ${RAW}`); } });
    const result = await f.adapter.poll({ limit: 50 });
    expectUnavailable(result, undefined);
    expect(result).not.toHaveProperty('configured');
    expect(f.calls).toEqual([]);
    expect(f.logs).toEqual([]);
  });
  test('re-resolves rotated bot/user credentials and self identity on every poll', async () => {
    let round = 0;
    const tokens = [TOKEN, 'xoxp-synthetic-rotated-fixture'];
    const f = fixture({ credential: async () => tokens[round++]!, reply: request => {
      if (request.method === 'auth.test') return ok({ user_id: round === 1 ? 'USELF' : 'UNEWSELF' });
      if (request.method === 'conversations.list') return ok({ channels: [{ id: 'D1' }] });
      return ok({ messages: [message('1000.000000', { text: '<@UNEWSELF>' })] });
    } });
    expect((await f.adapter.poll({ limit: 2 })).items[0]!.kind).toBe('dm');
    expect((await f.adapter.poll({ limit: 2 })).items[0]!.kind).toBe('mention');
    expect(f.keys).toHaveLength(2);
    expect(f.calls.map(c => c.request.headers.Authorization)).toEqual([
      ...Array(3).fill(`Bearer ${TOKEN}`), ...Array(3).fill(`Bearer ${tokens[1]}`),
    ]);
  });
  test.each([0, -1, 1.5, Infinity, 1001])('rejects invalid item bound %p without IO', async limit => {
    const f = fixture();
    expectUnavailable(await f.adapter.poll({ limit }), undefined);
    expect(f.keys).toEqual([]);
  });
});

describe('structured classification and explicit mapping', () => {
  test('reaction outranks mention/thread; mentions are exact self markup; roots and other users reactions remain DMs', async () => {
    const input = [
      message('1000.001000', { user: 'USELF', reactions: [{}], text: '<@USELF>', thread_ts: '1.000000' }),
      message('1000.002000', { text: '<@USELF>', thread_ts: '1.000000' }),
      message('1000.003000', { thread_ts: '1.000000' }),
      message('1000.004000', { thread_ts: '1000.004000', reactions: [{}] }),
      message('1000.005000', { text: '<@OTHER> @USELF' }),
      message('1000.006000', { user: 'USELF', reactions: [] }),
      message('1000.007000', { subtype: 'bot_message' }), message('1000.008000', { bot_id: 'B1' }),
    ];
    const seen: unknown[] = [];
    const f = fixture({ reply: historyFixture(() => ok({ messages: input })), mapItem: input => {
      seen.push(input);
      const mapped = mapper(input) as NonNullable<Awaited<ReturnType<SlackInboxMapper>>>;
      return { ...mapped, rawSender: input.senderId, rawText: input.text };
    }, resolveRouteId: input => { expect(input).not.toHaveProperty('senderId'); return 'route-fixture'; } });
    const result = await f.adapter.poll({ limit: 50 });
    expect(result.items.map(i => i.kind)).toEqual(['reaction', 'mention', 'thread', 'dm', 'dm', 'dm']);
    expect(result.items.every(i => i.routeId === 'route-fixture')).toBe(true);
    expect(result.items[0]!.id).toBe('slack:D1:1000.001000');
    expect(result.items[0]!.fromDigest).toBe(digest('USELF'));
    expect(seen).toHaveLength(6);
    const serialized = JSON.stringify(result);
    for (const raw of [TOKEN, RAW, 'USELF', 'UOTHER', 'rawSender', 'rawText']) expect(serialized).not.toContain(raw);
  });
  test('fallback sender input is explicit; absent text is empty but still mapped', async () => {
    const seen: string[] = [];
    const f = fixture({ reply: historyFixture(() => ok({ messages: [message('1000.000000', { user: undefined, text: undefined })] }), [{ id: 'D1' }]),
      mapItem: input => { seen.push(input.senderId); expect(input.text).toBe(''); return mapper(input); } });
    expect((await f.adapter.poll({ limit: 1 })).state).toBe('ready');
    expect(seen).toEqual(['D1']);
  });
  test.each(['withheld', 'undefined', 'digest', 'numeric-digest', 'array-digest', 'coercible-digest', 'subject', 'body', 'throw', 'reject'] as const)('mapper %s prevents all persistence and advancement', async mode => {
    let calls = 0;
    const f = fixture({ reply: historyFixture(() => ok({ messages: [message('1000.001000'), message('1000.002000')] })), mapItem: input => {
      if (++calls === 1) return mapper(input);
      const mapped = mapper(input) as NonNullable<Awaited<ReturnType<SlackInboxMapper>>>;
      if (mode === 'withheld') return null;
      if (mode === 'undefined') return undefined;
      if (mode === 'throw') throw new Error(`${TOKEN} ${RAW}`);
      if (mode === 'reject') return Promise.reject(new Error(`${TOKEN} ${RAW}`));
      if (mode === 'numeric-digest') return { ...mapped, fromDigest: 1234567890123456 } as unknown as typeof mapped;
      if (mode === 'array-digest') return { ...mapped, fromDigest: ['0123456789abcdef'] } as unknown as typeof mapped;
      if (mode === 'coercible-digest') return { ...mapped, fromDigest: { toString() { throw new Error(`${TOKEN} ${RAW}`); } } } as unknown as typeof mapped;
      return { ...mapped, ...(mode === 'digest' ? { fromDigest: 'U_RAW_SENDER' } : mode === 'subject' ? { subjectPreview: 'x'.repeat(201) } : { bodyPreview: 'x'.repeat(501) }) };
    } });
    const { store, poller } = await integrated(f);
    await poller.pollOnce();
    expect(store.countItems()).toBe(0);
    expect(store.getCursor('slack')).toBe(0);
    expect(poller.snapshotStatuses()[0]!.state).toBe('unavailable');
    expect(JSON.stringify(poller.snapshotStatuses())).not.toContain(RAW);
    expect(f.logs).toEqual([]);
  });
  test.each(['late-raw', 'late-throw'] as const)('mapper snapshots validated primitives once: %s', async mode => {
    const reads: Array<{ fromDigest: number; subjectPreview: number; bodyPreview: number }> = [];
    const routeDigests: string[] = [];
    const fields = { fromDigest: digest('UOTHER'), subjectPreview: 'Mapped fixture subject', bodyPreview: 'Mapped fixture body' };
    const f = fixture({ mapItem: () => {
      const count = { fromDigest: 0, subjectPreview: 0, bodyPreview: 0 };
      reads.push(count);
      const read = (key: keyof typeof fields): string => {
        count[key] += 1;
        if (mode === 'late-throw' && count[key] > 1) throw new Error(`${TOKEN} ${RAW}`);
        return count[key] > 2 ? RAW : fields[key];
      };
      return { get fromDigest() { return read('fromDigest'); }, get subjectPreview() { return read('subjectPreview'); },
        get bodyPreview() { return read('bodyPreview'); } };
    }, resolveRouteId: input => { routeDigests.push(input.fromDigest); return 'fixture-route'; } });
    const direct = await f.adapter.poll({ limit: 1 });
    expect(direct.state).toBe('ready');
    expect(direct.items[0]).toMatchObject(fields);
    const { store, poller } = await integrated(f);
    await poller.pollOnce();
    expect(store.listItems({ limit: 1 })[0]).toMatchObject(fields);
    expect(store.getCursor('slack')).toBe(1_000_000);
    expect(reads).toEqual(Array(2).fill({ fromDigest: 1, subjectPreview: 1, bodyPreview: 1 }));
    expect(routeDigests).toEqual([fields.fromDigest, fields.fromDigest]);
    expect(JSON.stringify([direct, store.listItems({ limit: 1 }), f.logs])).not.toContain(RAW);
  });
  test('optional routing errors and logger errors reveal no external exception', async () => {
    const f = fixture({ resolveRouteId: () => { throw new Error(`${TOKEN} ${RAW}`); } });
    f.ctx.logger.warn = () => { throw new Error('logger failed'); };
    const result = await f.adapter.poll({ limit: 1 });
    expect(result.state).toBe('ready');
    expect(result.items[0]).not.toHaveProperty('routeId');
    expect(JSON.stringify(result)).not.toContain(RAW);
  });
});

describe('bounded complete scans and real poller continuity', () => {
  test('empty/short list and history pages follow cursors; oldest prefix catches up across channels and restart', async () => {
    const f = fixture({ reply: request => {
      if (request.method === 'auth.test') return ok({ user_id: 'USELF' });
      const cursor = request.params.get('cursor');
      if (request.method === 'conversations.list') return cursor === 'list2'
        ? ok({ channels: [{ id: 'D1' }, { id: 'D2' }] }) : ok({ channels: [], response_metadata: { next_cursor: 'list2' } });
      if (request.params.get('channel') === 'D2') return ok({ messages: [message('1000.002000')] });
      return cursor === 'history2' ? ok({ messages: [message('1000.004000'), message('1000.001000'), message('1000.001000')] })
        : ok({ messages: [message('1000.005000')], has_more: false, response_metadata: { next_cursor: 'history2' } });
    } });
    const { store, poller } = await integrated(f, 2);
    await poller.pollOnce();
    expect(store.getCursor('slack')).toBe(1_000_002);
    expect(store.listItems({ limit: 10 }).map(i => i.receivedAt)).toEqual([1_000_002, 1_000_001]);
    await poller.stop();
    const restarted = new InboundPoller({ adapters: new Map([['slack', f.adapter]]), store, logger: f.ctx.logger, perProviderLimit: 2 });
    cleanups.push(() => restarted.stop());
    await restarted.pollOnce();
    expect(store.getCursor('slack')).toBe(1_000_005);
    expect(store.countItems()).toBe(4);
    await restarted.pollOnce();
    expect(restarted.snapshotStatuses()[0]!.state).toBe('empty');
    expect(f.calls.filter(c => c.method === 'conversations.history').some(c => c.params.get('oldest') === '1000.002000')).toBe(true);
    expect(f.calls.filter(c => c.method === 'conversations.history').every(c => c.params.get('limit') === '50')).toBe(true);
  });
  test('does not split same-ms groups across channels at an item-budget boundary', async () => {
    const f = fixture({ reply: historyFixture(request => ok({ messages: request.params.get('channel') === 'D1'
      ? [message('1000.002100'), message('1000.001000')] : [message('1000.002400')] }), [{ id: 'D1' }, { id: 'D2' }]) });
    const { store, poller } = await integrated(f, 2);
    await poller.pollOnce();
    expect(store.getCursor('slack')).toBe(1_000_001);
    expect(store.countItems()).toBe(1);
    await poller.pollOnce();
    expect(store.getCursor('slack')).toBe(1_000_002);
    expect(store.countItems()).toBe(3);
  });
  test('an over-budget oldest timestamp group is unavailable rather than silently lost', async () => {
    const f = fixture({ reply: historyFixture(() => ok({ messages: [message('1000.001100'), message('1000.001200'), message('1000.001300')] })) });
    const { store, poller } = await integrated(f, 2);
    await poller.pollOnce();
    expect(store.getCursor('slack')).toBe(0);
    expect(store.countItems()).toBe(0);
    expect(poller.snapshotStatuses()[0]!.error).toContain('timestamp group');
  });
  test('fixed horizon closes rounded buckets and preserves arrivals after an earlier channel scan', async () => {
    let clock = 1_000_001;
    let round = 0;
    const f = fixture({ now: () => clock, reply: request => {
      if (request.method === 'auth.test') { round += 1; return ok({ user_id: 'USELF' }); }
      if (request.method === 'conversations.list') return ok({ channels: [{ id: 'D1' }, { id: 'D2' }] });
      expect(request.params.get('latest')).toBe(round === 1 ? '1000.001000' : '1000.010000');
      if (request.params.get('channel') === 'D1') {
        clock = 1_000_010; // Wall clock advances while the scan is in flight.
        return ok({ messages: round === 1 ? [message('1000.000800'), message('1000.000000')]
          : [message('1000.001200'), message('1000.000800'), message('1000.000000')] });
      }
      return ok({ messages: [message('1000.004000')] }); // Injected response even ignores latest.
    } });
    const { store, poller } = await integrated(f);
    await poller.pollOnce();
    expect(store.getCursor('slack')).toBe(1_000_000);
    expect(store.countItems()).toBe(1);
    await poller.pollOnce();
    expect(store.countItems()).toBe(4);
    expect(store.listItems({ limit: 10 }).filter(i => i.receivedAt === 1_000_001)).toHaveLength(2);
    expect(store.getCursor('slack')).toBe(1_000_004);
  });
  test.each(['list-repeat', 'history-repeat', 'missing-cursor', 'list-bound', 'history-bound', 'total-bound', 'limited'] as const)(
    '%s leaves cursor and items untouched through the actual poller', async mode => {
      let lists = 0; let histories = 0;
      const f = fixture({ reply: request => {
        if (request.method === 'auth.test') return ok({ user_id: 'USELF' });
        if (request.method === 'conversations.list') {
          lists += 1;
          if (mode === 'list-repeat' || mode === 'list-bound') return ok({ channels: [], response_metadata: { next_cursor: mode === 'list-repeat' ? 'repeat' : `list-${lists}` } });
          if (mode === 'total-bound') return ok({ channels: Array.from({ length: lists < 3 ? 100 : 1 }, (_, i) => ({ id: `D${(lists - 1) * 100 + i}` })),
            ...(lists < 3 ? { response_metadata: { next_cursor: `list-${lists}` } } : {}) });
          return ok({ channels: [{ id: 'D1' }] });
        }
        histories += 1;
        if (mode === 'limited') return ok({ messages: [], is_limited: true });
        if (mode === 'total-bound') return ok({ messages: [message('1000.001000')] });
        return ok({ messages: [message('1000.001000')], has_more: true,
          ...(mode === 'missing-cursor' ? {} : { response_metadata: { next_cursor: mode === 'history-repeat' ? 'repeat' : `history-${histories}` } }) });
      } });
      const { store, poller } = await integrated(f);
      await poller.pollOnce();
      expect(store.getCursor('slack')).toBe(0); expect(store.countItems()).toBe(0);
      expect(poller.snapshotStatuses()[0]!.state).toBe('unavailable');
      expect(lists).toBeLessThanOrEqual(50); expect(histories).toBeLessThanOrEqual(200);
      if (mode === 'list-bound') expect(lists).toBe(50);
      if (mode === 'history-bound') expect(histories).toBe(20);
      if (mode === 'total-bound') expect(histories).toBe(200);
    });
  test('null cursors end list and history pagination without an invented extra page', async () => {
    const f = fixture({ reply: request => {
      if (request.method === 'auth.test') return ok({ user_id: 'USELF' });
      return request.method === 'conversations.list'
        ? ok({ channels: [{ id: 'D1' }], response_metadata: { next_cursor: null } })
        : ok({ messages: [message('1000.000000')], response_metadata: { next_cursor: null } });
    } });
    const result = await f.adapter.poll({ limit: 1 });
    expect(result.state).toBe('ready'); expect(f.calls).toHaveLength(3);
    expect(result.items[0]!.id).toBe('slack:D1:1000.000000');
  });
  test('exact final history page at its bound can complete', async () => {
    let count = 0;
    const f = fixture({ reply: historyFixture(() => { count += 1; return ok({ messages: [message(`1000.${String(count * 1000).padStart(6, '0')}`)],
      ...(count < 20 ? { response_metadata: { next_cursor: String(count) } } : {}) }); }) });
    const result = await f.adapter.poll({ limit: 50 });
    expect(result.state).toBe('ready'); expect(result.items).toHaveLength(20); expect(count).toBe(20);
  });
});

describe('honest failures and owned cancellation', () => {
  test.each(['auth', 'http', 'throw', 'list', 'history', 'shape', 'timestamp'] as const)('%s failure is sanitized and never advances a partial scan', async mode => {
    const f = fixture({ reply: request => {
      if (request.method === 'auth.test') return mode === 'auth' ? ok({ error: `${TOKEN} ${RAW}` }) : ok({ user_id: 'USELF' });
      if (request.method === 'conversations.list') return mode === 'list' ? { ok: true, body: { ok: false, error: `${TOKEN} ${RAW}` } }
        : ok({ channels: [{ id: 'D1' }, { id: 'D2' }] });
      if (request.params.get('channel') === 'D1') return ok({ messages: [message('1000.001000')] });
      if (mode === 'http') return { ok: false, body: `${TOKEN} ${RAW}` };
      if (mode === 'throw') throw new Error(`${TOKEN} ${RAW}`);
      if (mode === 'shape') return ok({ messages: `${TOKEN} ${RAW}` });
      if (mode === 'timestamp') return ok({ messages: [message('1000.000000junk')] });
      return { ok: true, body: { ok: false, error: `${TOKEN} ${RAW}` } };
    } });
    const { store, poller } = await integrated(f);
    await poller.pollOnce();
    expect(store.countItems()).toBe(0); expect(store.getCursor('slack')).toBe(0);
    expect(poller.snapshotStatuses()[0]!.configured).toBe(true);
    expect(poller.snapshotStatuses()[0]!.state).toBe('unavailable');
    expect(JSON.stringify(poller.snapshotStatuses())).not.toContain(RAW);
    expect(JSON.stringify(poller.snapshotStatuses())).not.toContain(TOKEN);
  });
  test.each(['credential', 'http', 'mapper', 'route', 'logger'] as const)('stop drains a late %s result without persistence or further work', async stage => {
    const entered = deferred<void>(); const release = deferred<void>();
    let mapping = 0; let routing = 0;
    const hold = async () => { entered.resolve(); await release.promise; };
    const f = fixture({
      credential: async () => { if (stage === 'credential') await hold(); return TOKEN; },
      reply: async request => {
        if (stage === 'http' && request.method === 'conversations.history') await hold();
        return historyFixture(() => ok({ messages: [message('1000.000000')] }))(request);
      },
      mapItem: async input => { mapping += 1; if (stage === 'mapper') await hold(); return mapper(input); },
      resolveRouteId: async () => { routing += 1; if (stage === 'logger') throw new Error(RAW); if (stage === 'route') await hold(); return 'fixture-route'; },
    });
    if (stage === 'logger') f.ctx.logger.warn = async () => { await hold(); };
    const { store, poller } = await integrated(f);
    const pending = poller.pollOnce();
    await entered.promise;
    let stopped = false;
    const stopping = poller.stopProvider('slack').then(() => { stopped = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(stopped).toBe(false);
    if (f.calls.length) expect(f.calls.at(-1)!.request.signal!.aborted).toBe(true);
    const before = f.calls.length;
    release.resolve(); await Promise.all([pending, stopping]);
    expect(stopped).toBe(true); expect(f.calls).toHaveLength(before);
    expect(store.countItems()).toBe(0); expect(store.getCursor('slack')).toBe(0);
    expect(poller.snapshotStatuses()[0]!.polled).toBe(false);
    if (stage === 'credential' || stage === 'http') expect(mapping).toBe(0);
    if (stage !== 'route' && stage !== 'logger') expect(routing).toBe(0);
  });
  test('aggregate distinguishes unconfigured, unknown, configured-empty and partial failure with prior mirror preserved', async () => {
    let mode: 'ready' | 'partial' | 'empty' | 'missing' | 'lookup' = 'ready';
    const f = fixture({ credential: async () => {
      if (mode === 'lookup') throw new Error(`${TOKEN} ${RAW}`);
      return mode === 'missing' ? null : TOKEN;
    }, reply: historyFixture(request => {
      if (mode === 'empty') return ok({ messages: [] });
      if (mode === 'partial' && request.params.get('channel') === 'D2') return { ok: true, body: { ok: false, error: RAW } };
      return ok({ messages: mode === 'ready' ? [message('1000.000000')] : [message('1000.001000')] });
    }, [{ id: 'D1' }, { id: 'D2' }]) });
    const { store, poller } = await integrated(f);
    await poller.pollOnce();
    expect(store.countItems()).toBe(2);
    mode = 'partial'; await poller.pollOnce();
    const partial = aggregateInbox({ store, poller }, { limit: 50 });
    expect(partial.partial).toBe(true); expect(partial.items).toHaveLength(2);
    expect(partial.providers[0]!.state).toBe('error'); expect(partial.providers[0]!.configured).toBe(true);
    expect(store.getCursor('slack')).toBe(1_000_000);
    mode = 'missing'; await poller.pollOnce();
    const missing = aggregateInbox({ store, poller }, { limit: 50 });
    expect(missing.partial).toBe(false); expect(missing.providers[0]!.state).toBe('unconfigured');
    mode = 'lookup'; await poller.pollOnce();
    const unknown = aggregateInbox({ store, poller }, { limit: 50 });
    expect(unknown.partial).toBe(true); expect(unknown.providers[0]).not.toHaveProperty('configured');
    mode = 'empty'; await poller.pollOnce();
    expect(poller.snapshotStatuses()[0]!.state).toBe('empty');
    expect(aggregateInbox({ store, poller }, { limit: 50 }).partial).toBe(false);
    expect(store.countItems()).toBe(2);
  });
  test.each([
    { messages: null }, { messages: Array(51).fill(message('1000.000000')) },
    { messages: [message('1000.000000', { text: 'x'.repeat(40_001) })] },
    { messages: [message('1000.000000', { reactions: 'bad' })] },
    { messages: [message('1000.000000', { thread_ts: 1 })] },
    { messages: [message('bad')] }, { messages: [message('0.000000')] },
    { messages: [message('9999999999999.999999')] },
    { messages: [], response_metadata: null }, { messages: [], response_metadata: { next_cursor: 1 } },
    { messages: [], has_more: 'yes' }, { messages: [], is_limited: 'yes' },
  ].map((body, index) => [index, body] as const))('malformed wire data case %i is unavailable', async (_index, body) => {
    const f = fixture({ reply: historyFixture(() => ok(body)) });
    expectUnavailable(await f.adapter.poll({ limit: 50 }), true);
    expect(f.logs).toEqual([]);
  });
  test.each(['credential', 'http', 'mapper', 'route'] as const)('hostile %s rejection is never inspected, leaked or rethrown', async stage => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error(`${TOKEN} ${RAW}`); },
      get() { throw new Error(`${TOKEN} ${RAW}`); } });
    const f = fixture({
      credential: async () => { if (stage === 'credential') throw hostile; return TOKEN; },
      reply: historyFixture(() => { if (stage === 'http') throw hostile; return ok({ messages: [message('1000.000000')] }); }),
      mapItem: input => { if (stage === 'mapper') throw hostile; return mapper(input); },
      resolveRouteId: () => { if (stage === 'route') throw hostile; return undefined; },
    });
    const result = await f.adapter.poll({ limit: 1 });
    if (stage === 'route') expect(result.state).toBe('ready');
    else expectUnavailable(result, stage === 'credential' ? undefined : true);
    const { store, poller } = await integrated(f);
    await poller.pollOnce();
    expect(store.countItems()).toBe(stage === 'route' ? 1 : 0);
    expect(JSON.stringify([result, f.logs, poller.snapshotStatuses()])).not.toContain(RAW);
    expect(JSON.stringify([result, f.logs, poller.snapshotStatuses()])).not.toContain(TOKEN);
  });
  test('optional async logger rejection is awaited and contained', async () => {
    const f = fixture({ resolveRouteId: async () => { throw new Error(RAW); } });
    f.ctx.logger.warn = async () => { throw new Error(`${TOKEN} ${RAW}`); };
    const { store, poller } = await integrated(f);
    await poller.pollOnce();
    expect(store.countItems()).toBe(1);
    expect(poller.snapshotStatuses()[0]!.state).toBe('ready');
    expect(store.listItems({ limit: 1 })[0]).not.toHaveProperty('routeId');
    expect(JSON.stringify(poller.snapshotStatuses())).not.toContain(RAW);
  });
  test.each([
    ['options-signal', 'direct'], ['signal-aborted', 'direct'],
    ['options-signal', 'poller'], ['signal-aborted', 'poller'],
  ] as const)('throwing %s getter stays contained through %s', async (mode, path) => {
    const f = fixture();
    const hostileOptions = (opts: ProviderPollOptions): ProviderPollOptions => {
      const throwing = { get() { throw new Error(`${TOKEN} ${RAW}`); } };
      if (mode === 'options-signal') return Object.defineProperty({ ...opts }, 'signal', throwing);
      return { ...opts, signal: Object.defineProperty({}, 'aborted', throwing) as AbortSignal };
    };
    if (path === 'direct') {
      expectUnavailable(await f.adapter.poll(hostileOptions({ limit: 1 })), undefined);
    } else {
      const adapter = f.adapter;
      f.adapter = { ...adapter, poll: opts => adapter.poll(hostileOptions(opts)) };
      const { store, poller } = await integrated(f);
      await poller.pollOnce();
      expect(store.countItems()).toBe(0);
      expect(store.getCursor('slack')).toBe(0);
      expect(poller.snapshotStatuses()[0]!.state).toBe('unavailable');
      expect(poller.snapshotStatuses()[0]).not.toHaveProperty('configured');
      expect(JSON.stringify([poller.snapshotStatuses(), f.logs])).not.toContain(RAW);
      expect(JSON.stringify([poller.snapshotStatuses(), f.logs])).not.toContain(TOKEN);
    }
    expect(f.keys).toEqual([]); expect(f.calls).toEqual([]); expect(f.logs).toEqual([]);
  });
  test('poll option accessors are sampled once before owned work', async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    const reads = { signal: 0, limit: 0, since: 0 };
    const opts = {
      get signal() { if (++reads.signal > 1) throw new Error(`${TOKEN} ${RAW}`); return signal; },
      get limit() { reads.limit += 1; return reads.limit === 1 ? 1 : NaN; },
      get since() { reads.since += 1; return reads.since === 1 ? 0 : NOW; },
    };
    const result = await f.adapter.poll(opts);
    expect(result.state).toBe('ready'); expect(result.items).toHaveLength(1);
    expect(reads).toEqual({ signal: 1, limit: 1, since: 1 });
    expect(f.calls.every(call => call.request.signal === signal)).toBe(true);
    expect(f.calls.find(call => call.method === 'conversations.history')!.params.get('oldest')).toBe('0.000000');
  });
  test('pre-aborted poll performs no credential or HTTP work', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expectUnavailable(await f.adapter.poll({ limit: 1, signal: controller.signal }), undefined);
    expect(f.keys).toEqual([]); expect(f.calls).toEqual([]);
  });
  test('aborted direct poll resolves unavailable; late rejection is owned and sanitized', async () => {
    const entered = deferred<void>(); const release = deferred<string | null>();
    const f = fixture({ credential: () => { entered.resolve(); return release.promise; } });
    const controller = new AbortController();
    const pending = f.adapter.poll({ limit: 1, signal: controller.signal });
    await entered.promise; controller.abort(); release.reject(new Error(`${TOKEN} ${RAW}`));
    expectUnavailable(await pending, undefined); expect(f.calls).toEqual([]);
  });
});
