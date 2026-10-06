import { afterEach, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { createProtectedSourceOwner } from '../sdk/src/platform/security/source-screening/owner.js';
import type { ProtectedSourceOwner, ProtectedSourceOwnerOptions, SourceScreeningReceipt } from '../sdk/src/platform/security/source-screening/types.js';
import { createProtectedInboxMapper } from '../sdk/src/platform/intake/protected-preview.js';
import { createSlackInboxAdapter } from '../sdk/src/platform/intake/providers/slack.js';
import { registerInboxSurface } from '../sdk/src/platform/intake/registration.js';
import { InboxCursorStore } from '../sdk/src/platform/intake/cursor-store.js';
import { digestSender } from '../sdk/src/platform/intake/text-normalization.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
interface Proposal { readonly revision: string; readonly parts: readonly string[]; }
function fixture(options: {
  propose?: (source: Proposal) => unknown | Promise<unknown>;
  judge?: (body: Record<string, unknown>, count: number) => Response | Promise<Response>;
  authority?: () => void;
  onRetry?: ProtectedSourceOwnerOptions['onRetry'];
} = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let judgmentCalls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    const path = new URL(request.url).pathname; calls.push({ path, body });
    if (path === '/v1/chat/completions') {
      const messages = body['messages'] as { content: string }[];
      const source = JSON.parse(messages[1]!.content) as Proposal;
      const proposed = options.propose ? await options.propose(source) : { revision: source.revision, spans: [] };
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposed) } }] });
    }
    if (path !== '/v1/systemone') return new Response('', { status: 404 });
    judgmentCalls++;
    return options.judge ? options.judge(body, judgmentCalls) : reading(1, 1);
  } });
  const lifetime = new AbortController();
  const config: ProtectedSourceOwnerOptions = {
    authority: { ownerId: 'synthetic-owner', revision: '1', retention: 'ephemeral-no-log', signal: lifetime.signal, assertCurrent: options.authority ?? (() => {}) },
    proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'local-span-fixture' },
    judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' }, timeoutMs: 1_000,
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
  };
  const owner = createProtectedSourceOwner(config);
  cleanups.push(async () => { await owner.close(); await server.stop(true); });
  return { owner, calls, config, lifetime };
}
function reading(complete: number, precise: number, model = 'jev-1.13.0') {
  return Response.json({ model, answers: { complete: { type: 'noul', noul: complete }, precise: { type: 'noul', noul: precise } }, usage: { input_tokens: 10, output_tokens: 2 } });
}
async function projected(owner: ProtectedSourceOwner, parts: readonly string[]) {
  const result = await owner.screen(owner.capture(parts));
  expect(result.status).toBe('settled');
  if (result.status !== 'settled') throw new Error('Fixture did not settle');
  return { parts: owner.project(result.receipt), receipt: result.receipt };
}

test('actual local proposal and Jev preserve original content except verified exact spans', async () => {
  const text = 'Call person@example.test, then keep the build notes. 🙂';
  const { owner, calls } = fixture({ propose: source => ({ revision: source.revision, spans: [{ part: 1, start: 5, end: 24 }] }) });
  expect((await projected(owner, ['Direct message', text])).parts).toEqual(['Direct message', 'Call [redacted], then keep the build notes. 🙂']);
  expect(calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone']);
  expect(calls[1]!.body['state']).toMatchObject({ parts: ['Direct message', text], spans: [{ part: 1, start: 5, end: 24 }] });
});

test('source and configured routes are captured before asynchronous work, and repeated calls coalesce', async () => {
  const gate = deferred<void>(), started = deferred<void>();
  const f = fixture({ propose: async source => { started.resolve(); await gate.promise; return { revision: source.revision, spans: [] }; } });
  const parts = ['Original sentence.']; const handle = f.owner.capture(parts); parts[0] = 'Changed.';
  const pending = f.owner.screen(handle); expect(f.owner.screen(handle)).toBe(pending); await started.promise;
  (f.config.proposal as { endpoint: string }).endpoint = 'https://forbidden.example';
  gate.resolve(); const result = await pending; expect(result.status).toBe('settled');
  if (result.status === 'settled') expect(f.owner.project(result.receipt)).toEqual(['Original sentence.']);
  expect(f.calls).toHaveLength(2);
});

test.each([0.5, 0.97, 0])('semantic uncertainty or refusal %s releases no text and is not retried for a lucky answer', async probability => {
  const f = fixture({ judge: () => reading(probability, 1) }); const handle = f.owner.capture(['Keep this ordinary sentence.']);
  expect(await f.owner.screen(handle)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(await f.owner.screen(handle)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(f.calls).toHaveLength(2);
  expect(() => f.owner.project({} as SourceScreeningReceipt)).toThrow('handle is not current');
});

test('foreign/forged/released receipts cannot be used as privacy authority', async () => {
  const a = fixture(), b = fixture(); const handle = a.owner.capture(['Ordinary text.']);
  const result = await a.owner.screen(handle); expect(result.status).toBe('settled'); if (result.status !== 'settled') return;
  expect(() => b.owner.project(result.receipt)).toThrow(); expect(() => a.owner.project({ ...result.receipt })).toThrow();
  await a.owner.release(handle); expect(() => a.owner.project(result.receipt)).toThrow();
  expect(await a.owner.screen(handle)).toEqual({ status: 'held', reason: 'stale' });
});

test.each([
  { revision: 'stale', spans: [] }, { spans: [{ part: 0, start: 0, end: 100 }] },
  { spans: [{ part: 0, start: 0, end: 5 }, { part: 0, start: 4, end: 8 }] },
  { spans: [{ part: 0, start: 0, end: 1.5 }] }, { spans: [{ part: 8, start: 0, end: 1 }] },
  { spans: [], replacement: 'invented' },
])('bad proposal is withheld before Jev or projection: %j', async proposal => {
  const f = fixture({ propose: source => ({ revision: source.revision, ...proposal }) });
  expect((await f.owner.screen(f.owner.capture(['Original text.']))).status).toBe('held'); expect(f.calls).toHaveLength(1);
});

test('complete structural privacy preflight runs before clipping, hashing or route calls', () => {
  const f = fixture(); let reads = 0;
  const getter = Object.defineProperty([], '0', { get() { reads++; return 'private'; } }); getter.length = 1;
  for (const input of [getter, ['apiKey=private-fixture'], ['ordinary '.repeat(6_000), 'password=private-fixture'], ['ghp_' + 'X'.repeat(40)]]) expect(() => f.owner.capture(input)).toThrow();
  expect(reads).toBe(0); expect(f.calls).toHaveLength(0);
});

test('sparse and proxy sources refuse before any descriptor trap or request', () => {
  const f = fixture(); let traps = 0;
  const proxy = new Proxy(['ordinary'], { getOwnPropertyDescriptor() { traps++; throw new Error('private'); }, ownKeys() { traps++; throw new Error('private'); }, getPrototypeOf() { traps++; throw new Error('private'); } });
  expect(() => f.owner.capture(proxy)).toThrow(); expect(() => f.owner.capture([proxy] as unknown as string[])).toThrow();
  expect(() => f.owner.capture(new Array<string>(2))).toThrow(); expect(traps).toBe(0); expect(f.calls).toHaveLength(0);
});

test('exact generated revision is protocol provenance, not re-scanned raw card material', async () => {
  const f = fixture({ propose: source => {
    expect(source.revision).toBe('4eaef7926146fbf4a3c2452eefb2a1507274343998d070764ec9719873c0d662');
    return { revision: source.revision, spans: [] };
  } });
  expect((await projected(f.owner, ['Ordinary build note 222.'])).parts).toEqual(['Ordinary build note 222.']); expect(f.calls).toHaveLength(2);
});

test('releasing settled source A is independent of unrelated pending source B', async () => {
  const gate = deferred<void>(), started = deferred<void>();
  const f = fixture({ propose: async source => {
    if (source.parts[0] === 'Second source.') { started.resolve(); await gate.promise; }
    return { revision: source.revision, spans: [] };
  } });
  const a = f.owner.capture(['First source.']), b = f.owner.capture(['Second source.']);
  expect((await f.owner.screen(a)).status).toBe('settled'); const pendingB = f.owner.screen(b); await started.promise;
  try { await f.owner.release(a); expect(await f.owner.screen(a)).toEqual({ status: 'held', reason: 'stale' }); }
  finally { gate.resolve(); await pendingB; }
});

test('revocation between local proposal and judgment withholds and emits no late verification', async () => {
  let allowed = true;
  const f = fixture({ authority: () => { if (!allowed) throw new Error('private-revocation-reason'); }, propose: source => { allowed = false; return { revision: source.revision, spans: [] }; } });
  expect(await f.owner.screen(f.owner.capture(['Ordinary text.']))).toEqual({ status: 'held', reason: 'stale' }); expect(f.calls).toHaveLength(1);
});

test('canonical transient Jev retry stays pending, then returns one current receipt', async () => {
  let retries = 0;
  const f = fixture({ onRetry: progress => { retries++; expect(JSON.stringify(progress)).not.toContain('Ordinary text'); }, judge: (_body, count) => count === 1 ? new Response('private service echo', { status: 503 }) : reading(1, 1) });
  expect((await projected(f.owner, ['Ordinary text.'])).parts).toEqual(['Ordinary text.']);
  expect(retries).toBe(1); expect(f.calls.map(call => call.path)).toEqual(['/v1/chat/completions', '/v1/systemone', '/v1/systemone']);
}, 10_000);

test('cancellation during canonical backoff stops retries and retires genuine receipts', async () => {
  const retry = deferred<void>();
  const f = fixture({ judge: () => new Response('private', { status: 503 }), onRetry: () => retry.resolve() });
  const pending = f.owner.screen(f.owner.capture(['Ordinary text.'])); await retry.promise;
  const closing = f.owner.close(); expect(f.owner.close()).toBe(closing); await closing;
  expect(await pending).toEqual({ status: 'held', reason: 'cancelled' });
  expect(() => f.owner.capture(['late'])).toThrow(); expect(f.calls).toHaveLength(2);
}, 10_000);

test('different model response is operational unavailability, never a semantic result', async () => {
  const f = fixture({ judge: (_body, count) => reading(1, 1, count === 1 ? 'jev-9.0.0' : 'jev-1.13.0') });
  const source = f.owner.capture(['Ordinary text.']);
  expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'route-unavailable' });
  expect((await f.owner.screen(source)).status).toBe('settled');
});

test('synchronous authority failures never expose borrowed exception data', async () => {
  let allowed = true;
  const f = fixture({ authority: () => { if (!allowed) throw new Error('synthetic-private-authority-marker'); } });
  const settled = await projected(f.owner, ['Ordinary source.']); allowed = false;
  for (const call of [() => f.owner.capture(['New source.']), () => f.owner.project(settled.receipt), () => createProtectedSourceOwner(f.config)]) {
    try { call(); throw new Error('Expected refusal'); }
    catch (error) { expect(String(error)).toBe('Error: Protected source owner is unavailable or the handle is not current'); }
  }
});

test('canonical retry owns an asynchronously rejected progress observer', async () => {
  const f = fixture({ judge: (_body, count) => count === 1 ? new Response('', { status: 503 }) : reading(1, 1),
    onRetry: async () => { throw new Error('synthetic-observer-private-marker'); } });
  expect((await projected(f.owner, ['Ordinary source.'])).parts).toEqual(['Ordinary source.']); expect(f.calls).toHaveLength(3);
}, 10_000);

test('real protected mapper feeds Slack adapter, persisted inbox and wire projection without raw content', async () => {
  const f = fixture({ propose: source => ({ revision: source.revision, spans: [{ part: 1, start: 5, end: 24 }, { part: 3, start: 5, end: 24 }] }) });
  const mapper = createProtectedInboxMapper(f.owner), dir = makeProjectTempDir('protected-source-inbox');
  const catalog = new GatewayMethodCatalog(), logs: unknown[] = [];
  const logger = { info: (...args: unknown[]) => { logs.push(args); }, warn: (...args: unknown[]) => { logs.push(args); }, error: (...args: unknown[]) => { logs.push(args); } };
  const ts = `${Math.floor((Date.now() - 1_000) / 1_000)}.000000`;
  const adapter = createSlackInboxAdapter({ logger, credentials: { resolveRef: async () => null, resolveConfigSecret: async () => 'xoxb-synthetic-fixture' } }, {
    mapItem: mapper,
    http: async url => ({ ok: true, body: url.pathname.endsWith('auth.test') ? { ok: true, user_id: 'UOWNER' }
      : url.pathname.endsWith('conversations.list') ? { ok: true, channels: [{ id: 'DTEST' }] }
      : { ok: true, messages: [{ ts, user: 'USENDER', text: 'Call person@example.test, keep the build notes.' }] } }),
  });
  const ctx = { catalog, logger, workingDirectory: dir };
  const surface = registerInboxSurface(ctx, { adapters: new Map([['slack', adapter]]) });
  try {
    await surface.ready;
    const wire = await catalog.invoke('channels.inbox.list', { body: {}, context: {} });
    expect(wire).toMatchObject({ total: 1, items: [{ from: digestSender('USENDER'), bodyPreview: 'Call [redacted], keep the build notes.' }] });
    expect(JSON.stringify(wire)).not.toContain('person@example.test'); expect(JSON.stringify(logs)).not.toContain('person@example.test');
  } finally { await surface.close(); }
  expect((await readFile(new InboxCursorStore(dir).dbPath)).toString()).not.toContain('person@example.test');
  const reopened = registerInboxSurface(ctx, { adapters: new Map([['slack', adapter]]), skipInitialPoll: true });
  try {
    await reopened.ready;
    expect(await catalog.invoke('channels.inbox.list', { body: {}, context: {} })).toMatchObject({ total: 1, items: [{ bodyPreview: 'Call [redacted], keep the build notes.' }] });
    expect(f.calls).toHaveLength(2);
  } finally { await reopened.close(); }
});

test('mapper screens the full original and normalized candidate before display clipping', async () => {
  const f = fixture(), mapper = createProtectedInboxMapper(f.owner), text = '<p>' + 'ordinary '.repeat(80) + '</p>';
  const mapped = await mapper({ senderId: 'USENDER', channelId: 'DTEST', subject: 'Direct message', text });
  expect(mapped?.bodyPreview).toHaveLength(500); expect(mapped?.bodyPreview).not.toContain('<p>');
  expect(f.calls[1]!.body['state']).toMatchObject({ parts: ['Direct message', text, 'Direct message', 'ordinary '.repeat(80).trim()] });
});

test('numeric provider identifiers stay local protocol data while identical raw text stays protected', async () => {
  const identifier = '1556818270617600003'; // Synthetic 2026-10-06 Discord snowflake, sequence 3.
  const f = fixture(), mapper = createProtectedInboxMapper(f.owner);
  expect(await mapper({ senderId: identifier, channelId: identifier, subject: 'Direct message', text: 'Ordinary build note.' }))
    .toEqual({ fromDigest: digestSender(identifier), subjectPreview: 'Direct message', bodyPreview: 'Ordinary build note.' });
  expect(f.calls).toHaveLength(2); expect(JSON.stringify(f.calls)).not.toContain(identifier);
  const before = f.calls.length;
  expect(await mapper({ senderId: 'USENDER', channelId: 'DTEST', subject: 'Direct message', text: identifier })).toBeNull(); expect(f.calls).toHaveLength(before);
});

test('releasing and recapturing an unchanged uncertain source cannot retry for a lucky answer', async () => {
  const f = fixture({ judge: (_body, count) => reading(count === 1 ? 0.5 : 1, 1) }), mapper = createProtectedInboxMapper(f.owner);
  const original = { senderId: 'USENDER', channelId: 'DTEST', subject: 'Direct message', text: 'Ordinary unchanged source.' };
  expect(await mapper(original)).toBeNull(); expect(await mapper({ ...original })).toBeNull(); expect(f.calls).toHaveLength(2);
  expect(await mapper({ ...original, text: 'A genuinely changed source.' })).toMatchObject({ bodyPreview: 'A genuinely changed source.' }); expect(f.calls).toHaveLength(4);
});

test('active source retention has an explicit bound and release restores capacity', async () => {
  const f = fixture(), handles = Array.from({ length: 128 }, () => f.owner.capture(['Ordinary source.']));
  expect(() => f.owner.capture(['One more.'])).toThrow(); expect(f.calls).toHaveLength(0);
  await f.owner.release(handles[0]!); expect(f.owner.capture(['Capacity recovered.'])).toBeDefined();
});

test('distinct handles cannot concurrently sample the same uncertain revision', async () => {
  const gate = deferred<void>(), started = deferred<void>();
  const f = fixture({ propose: async source => { started.resolve(); await gate.promise; return { revision: source.revision, spans: [] }; }, judge: (_body, count) => reading(count === 1 ? 0.5 : 1, 1) });
  const a = f.owner.capture(['Same immutable source.']), b = f.owner.capture(['Same immutable source.']);
  const first = f.owner.screen(a); await started.promise;
  try {
    expect(await Promise.race([f.owner.screen(b), Promise.resolve('still-pending')])).toEqual({ status: 'held', reason: 'busy' }); expect(f.calls).toHaveLength(1);
  } finally { gate.resolve(); await first; }
  expect(await f.owner.screen(b)).toEqual({ status: 'held', reason: 'unsettled' }); expect(f.calls).toHaveLength(2);
});

test('unsettled capacity never evicts an earlier hold or sends overflowing work', async () => {
  const f = fixture({ judge: () => reading(0.5, 1) });
  for (let index = 0; index < 1_024; index++) {
    const source = f.owner.capture([`Ordinary held source ${index}.`]); const result = await f.owner.screen(source);
    if (result.status !== 'held' || result.reason !== 'unsettled') throw new Error('Expected a synthetic unsettled reading');
    await f.owner.release(source);
  }
  const calls = f.calls.length; expect(calls).toBe(2_048);
  expect(await f.owner.screen(f.owner.capture(['New source exceeds hold capacity.']))).toEqual({ status: 'held', reason: 'capacity' });
  expect(await f.owner.screen(f.owner.capture(['Ordinary held source 0.']))).toEqual({ status: 'held', reason: 'unsettled' }); expect(f.calls).toHaveLength(calls);
}, 60_000);

test('malformed proposal releases its reservation without manufacturing a semantic hold', async () => {
  let proposals = 0;
  const f = fixture({ propose: source => ({ revision: source.revision, spans: ++proposals === 1 ? [{ part: 0, start: 0, end: 99_999 }] : [] }) });
  const source = f.owner.capture(['Same original.']);
  expect(await f.owner.screen(source)).toEqual({ status: 'held', reason: 'malformed' });
  expect((await f.owner.screen(source)).status).toBe('settled'); expect(f.calls).toHaveLength(3);
});

test('new uncertainty retires older positive receipts for the same exact source revision', async () => {
  const f = fixture({ judge: (_body, count) => reading(count === 1 ? 1 : 0.5, 1) });
  const a = f.owner.capture(['Same immutable original.']); const first = await f.owner.screen(a);
  expect(first.status).toBe('settled'); if (first.status !== 'settled') return;
  expect(f.owner.project(first.receipt)).toEqual(['Same immutable original.']);
  const b = f.owner.capture(['Same immutable original.']); expect(await f.owner.screen(b)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(await f.owner.screen(a)).toEqual({ status: 'held', reason: 'unsettled' }); expect(() => f.owner.project(first.receipt)).toThrow();
  await f.owner.release(b); expect(() => f.owner.project(first.receipt)).toThrow(); expect(f.calls).toHaveLength(4);
});
