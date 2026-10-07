import { afterEach, expect, test } from 'bun:test';
import { createProtectedSourceOwner } from '../sdk/src/platform/security/source-screening/owner.js';
import type { ProtectedSourceOwnerOptions, ResearchReferenceScreeningReceipt, ProtectedSource, ProtectedResearchReference, SourceScreeningReceipt } from '../sdk/src/platform/security/source-screening/types.js';
import type { ResearchReferenceOperation } from '../sdk/src/platform/security/source-screening/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function answer(value = 0, model = 'jev-1.13.0') {
  return Response.json({ model, answers: { credential: { type: 'noul', noul: value } }, usage: { input_tokens: 5, output_tokens: 1 } });
}
function fixture(options: {
  judge?: (body: Record<string, unknown>, count: number) => Response | Promise<Response>;
  authority?: () => void;
  onRetry?: ProtectedSourceOwnerOptions['onRetry'];
} = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>;
    const path = new URL(request.url).pathname;
    calls.push({ path, body });
    if (path !== '/v1/systemone') return new Response('Unexpected proposal route', { status: 400 });
    return options.judge ? options.judge(body, calls.length) : answer();
  } });
  const lifetime = new AbortController();
  const config: ProtectedSourceOwnerOptions = {
    authority: { ownerId: 'synthetic-reference-owner', revision: '1', retention: 'ephemeral-no-log', signal: lifetime.signal,
      assertCurrent: options.authority ?? (() => {}) },
    proposal: { endpoint: `http://127.0.0.1:${server.port}`, model: 'unused-local-proposal-fixture' },
    judgment: { endpoint: `http://127.0.0.1:${server.port}`, model: 'jev-1.13.0' }, timeoutMs: 1_000,
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
  };
  const owner = createProtectedSourceOwner(config);
  cleanups.push(async () => { await owner.close(); await server.stop(true); });
  const project = async (url: string) => {
    const handle = owner.captureResearchReference(url);
    try {
      const result = await owner.screenResearchReference(handle);
      expect(result.status).toBe('settled');
      if (result.status !== 'settled') throw new Error('Synthetic reference did not settle');
      const projection = owner.projectResearchReference(result.receipt);
      return [projection.status === 'preserved' ? projection.url : '[source URL withheld]'];
    } finally { await owner.release(handle); }
  };
  return { owner, config, calls, lifetime, project };
}

test('reference operation fences reject executable metadata and async guards before any request', async () => {
  const f = fixture();
  const handle = f.owner.captureResearchReference('https://example.test/document?id=synthetic-value');
  let traps = 0;
  const getter = Object.defineProperty({}, 'assertCurrent', { get() { traps++; return () => {}; } });
  const proxy = new Proxy({}, { ownKeys() { traps++; return []; }, getPrototypeOf() { traps++; return Object.prototype; } });
  const signal = new Proxy(new AbortController().signal, { getPrototypeOf() { traps++; return AbortSignal.prototype; } });
  const guard = new Proxy(() => {}, { apply() { traps++; } });
  for (const operation of [getter, proxy, { signal }, { assertCurrent: guard }, { extra: true }]) {
    expect(await f.owner.screenResearchReference(handle, operation as ResearchReferenceOperation)).toEqual({ status: 'held', reason: 'malformed' });
  }
  expect(await f.owner.screenResearchReference(handle, { assertCurrent: async () => {} })).toEqual({ status: 'held', reason: 'stale' });
  expect(traps).toBe(0);
  expect(f.calls).toHaveLength(0);
  const aborted = new AbortController(); aborted.abort();
  expect(await f.owner.screenResearchReference(handle, { signal: aborted.signal })).toEqual({ status: 'held', reason: 'cancelled' });
  expect(f.calls).toHaveLength(0);
  await f.owner.release(handle);
});

test('name-only Jev preserves the exact benign reference, duplicate fields, query encoding and anchor', async () => {
  const f = fixture();
  const url = 'HTTPS://EXAMPLE.TEST:443/document%2fid?id=sentinel-one&id=sentinel-two&q=ordinary+words#section-2';
  expect(await f.project(url)).toEqual([url]);
  expect(f.calls.map(call => call.path)).toEqual(['/v1/systemone', '/v1/systemone']);
  expect(f.calls.map(call => call.body.state)).toEqual([{ parameter: 'id' }, { parameter: 'q' }]);
  const transmitted = JSON.stringify(f.calls);
  for (const withheld of ['EXAMPLE.TEST', 'document%2fid', 'sentinel-one', 'sentinel-two', 'ordinary+words', 'section-2']) {
    expect(transmitted).not.toContain(withheld);
  }
});

test('a credential role withholds the whole reference rather than changing its identity', async () => {
  const f = fixture({ judge: () => answer(1) });
  expect(await f.project('https://example.test/document?pat=synthetic-sentinel#section')).toEqual(['[source URL withheld]']);
  expect(f.calls[0]?.body.state).toEqual({ parameter: 'pat' });
  expect(JSON.stringify(f.calls)).not.toContain('synthetic-sentinel');
  expect(f.calls).toHaveLength(1);
});

test('names are decoded once by URLSearchParams while original resource bytes stay unchanged', async () => {
  const f = fixture({ judge: body => answer((body.state as { parameter: string }).parameter === 'auth' ? 1 : 0) });
  expect(await f.project('https://example.test/document?%61uth=synthetic-sentinel')).toEqual(['[source URL withheld]']);
  const benign = 'https://example.test/search?q=ordinary words&%71=more%20words&max_tokens=42#anchor';
  expect(await f.project(benign)).toEqual([benign]);
  expect(f.calls.map(call => call.body.state)).toEqual([{ parameter: 'auth' }, { parameter: 'q' }, { parameter: 'max_tokens' }]);
  expect(JSON.stringify(f.calls)).not.toContain('synthetic-sentinel');
});

test.each([
  'https://example.test/doc\tument?pat=synthetic-sentinel',
  'https://example.test/doc\nument?pat=synthetic-sentinel',
  'https://example.test/doc\rument?pat=synthetic-sentinel',
  'https://example.test/doc\\ument?pat=synthetic-sentinel',
  'https:example.test/document?pat=synthetic-sentinel',
  'https://name@example.test/document?pat=synthetic-sentinel',
  'ftp://example.test/document?pat=synthetic-sentinel',
  'not a URL',
])('a complete declared malformed reference is omitted without any model request: %j', async url => {
  const f = fixture(); expect(await f.project(url)).toEqual(['[source URL withheld]']); expect(f.calls).toHaveLength(0);
});

test('a complete reference with no query retains its original spelling and anchor without a model', async () => {
  const f = fixture();
  for (const url of ['https://example.test/document#section', 'HTTPS://EXAMPLE.TEST:443/doc%2fument']) expect(await f.project(url)).toEqual([url]);
  expect(f.calls).toHaveLength(0);
});

test('the complete original and decoded names face the unchanged structural and issuer credential floors', () => {
  const f = fixture();
  for (const url of [
    'https://example.test/?access_token=synthetic-sentinel',
    'https://name:synthetic-sentinel@example.test/document',
    `https://example.test/?q=${'ghp_' + 'X'.repeat(40)}`,
    `https://example.test/?${encodeURIComponent('ghp_' + 'X'.repeat(40))}=ordinary`,
    'https://example.test/?password%3Dsynthetic-sentinel=ordinary',
    'https://example.test/?pat=' + 'ordinary'.repeat(6_000),
  ]) expect(() => f.owner.captureResearchReference(url)).toThrow();
  expect(f.calls).toHaveLength(0);
});

test('unsettled parameter roles survive source release, changed values and changed URL contexts without resampling', async () => {
  const f = fixture({ judge: () => answer(0.5) });
  for (const url of ['https://example.test/a?ticket=first-sentinel', 'https://other.example.test/b?ticket=second-sentinel#changed']) {
    const handle = f.owner.captureResearchReference(url);
    expect(await f.owner.screenResearchReference(handle)).toEqual({ status: 'held', reason: 'unsettled' });
    expect(await f.owner.screenResearchReference(handle)).toEqual({ status: 'held', reason: 'unsettled' });
    await f.owner.release(handle);
  }
  expect(f.calls).toHaveLength(1);
  expect(() => f.owner.projectResearchReference({} as ResearchReferenceScreeningReceipt)).toThrow();
});

test('concurrent distinct references never sample the same in-flight name twice', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const f = fixture({ judge: async () => { started.resolve(); await finish.promise; return answer(); } });
  const first = f.owner.captureResearchReference('https://example.test/a?id=first');
  const second = f.owner.captureResearchReference('https://example.test/b?id=second');
  const pending = f.owner.screenResearchReference(first); await started.promise;
  expect(await f.owner.screenResearchReference(second)).toEqual({ status: 'held', reason: 'busy' });
  finish.resolve(); expect((await pending).status).toBe('settled');
  const result = await f.owner.screenResearchReference(second); expect(result.status).toBe('settled');
  if (result.status === 'settled') expect(f.owner.projectResearchReference(result.receipt)).toEqual({ status: 'preserved', url: 'https://example.test/b?id=second' });
  expect(f.calls).toHaveLength(1);
});

test('forged, foreign, released and revoked reference receipts release no original', async () => {
  const f = fixture(), other = fixture();
  const source = f.owner.captureResearchReference('https://example.test/?id=resource');
  const result = await f.owner.screenResearchReference(source); expect(result.status).toBe('settled'); if (result.status !== 'settled') return;
  expect(() => other.owner.projectResearchReference(result.receipt)).toThrow();
  expect(() => f.owner.projectResearchReference({ ...result.receipt })).toThrow();
  await f.owner.release(source); expect(() => f.owner.projectResearchReference(result.receipt)).toThrow();
  const current = f.owner.captureResearchReference('https://example.test/?id=other');
  const second = await f.owner.screenResearchReference(current); expect(second.status).toBe('settled'); if (second.status !== 'settled') return;
  f.lifetime.abort(); expect(() => f.owner.projectResearchReference(second.receipt)).toThrow();
});

test('reference route mutation cannot redirect an in-flight name-only attempt', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const f = fixture({ judge: async () => { started.resolve(); await finish.promise; return answer(); } });
  const source = f.owner.captureResearchReference('https://example.test/?id=synthetic-sentinel');
  const pending = f.owner.screenResearchReference(source); expect(f.owner.screenResearchReference(source)).toBe(pending); await started.promise;
  (f.config.judgment as { endpoint: string }).endpoint = 'https://forbidden.example';
  finish.resolve(); const result = await pending; expect(result.status).toBe('settled');
  if (result.status === 'settled') expect(f.owner.projectResearchReference(result.receipt)).toEqual({ status: 'preserved', url: 'https://example.test/?id=synthetic-sentinel' });
  expect(f.calls).toHaveLength(1); expect(JSON.stringify(f.calls)).not.toContain('synthetic-sentinel');
});

test('revocation during a reference reading releases no text or settled cache receipt', async () => {
  let current = true;
  const f = fixture({ authority: () => { if (!current) throw new Error('synthetic-private-reason'); }, judge: () => { current = false; return answer(); } });
  const source = f.owner.captureResearchReference('https://example.test/?id=synthetic-sentinel');
  expect(await f.owner.screenResearchReference(source)).toEqual({ status: 'held', reason: 'stale' });
  expect(JSON.stringify(f.calls)).not.toContain('synthetic-sentinel');
});

test('canonical transient retries send the identical name-only state and value-free progress', async () => {
  const progress: unknown[] = [];
  const f = fixture({ onRetry: event => { progress.push(event); }, judge: (_body, count) => count === 1
    ? new Response('synthetic private service echo', { status: 503 }) : answer(1) });
  expect(await f.project('https://example.test/path?auth=synthetic-sentinel#anchor')).toEqual(['[source URL withheld]']);
  expect(f.calls.map(call => call.body.state)).toEqual([{ parameter: 'auth' }, { parameter: 'auth' }]);
  expect(progress).toHaveLength(1);
  expect(JSON.stringify([f.calls, progress])).not.toContain('synthetic-sentinel');
}, 10_000);

test('wrong-model answers remain operationally unavailable rather than permitting or permanently classifying a name', async () => {
  const f = fixture({ judge: (_body, count) => answer(0, count === 1 ? 'wrong-model' : 'jev-1.13.0') });
  const source = f.owner.captureResearchReference('https://example.test/?id=synthetic-sentinel');
  expect(await f.owner.screenResearchReference(source)).toEqual({ status: 'held', reason: 'route-unavailable' });
  expect((await f.owner.screenResearchReference(source)).status).toBe('settled'); expect(f.calls).toHaveLength(2);
});

test('reference bounds fail before requests and share the original-handle capacity', () => {
  const f = fixture();
  const params = Array.from({ length: 101 }, (_, index) => `field${index}=ordinary`).join('&');
  expect(() => f.owner.captureResearchReference(`https://example.test/?${params}`)).toThrow();
  for (let index = 0; index < 128; index++) f.owner.captureResearchReference(`https://example.test/${index}`);
  expect(() => f.owner.capture(['ordinary'])).toThrow();
  expect(() => f.owner.captureResearchReference('https://example.test/overflow')).toThrow();
  expect(f.calls).toHaveLength(0);
});

test('query-role handles and receipts cannot satisfy the generic display-preview boundary, even after unsafe casts', async () => {
  const f = fixture({ judge: body => 'parameter' in (body.state as object) ? answer() : Response.json({ model: 'jev-1.13.0',
    answers: { complete: { type: 'noul', noul: 1 }, precise: { type: 'noul', noul: 1 } } }) });
  const reference = f.owner.captureResearchReference('https://example.test/#section');
  expect(await f.owner.screen(reference as unknown as ProtectedSource)).toEqual({ status: 'held', reason: 'stale' });
  const result = await f.owner.screenResearchReference(reference);
  expect(result.status).toBe('settled'); if (result.status !== 'settled') return;
  expect(() => f.owner.project(result.receipt as unknown as SourceScreeningReceipt)).toThrow();
  const source = f.owner.capture(['Ordinary source.']);
  expect(await f.owner.screenResearchReference(source as unknown as ProtectedResearchReference)).toEqual({ status: 'held', reason: 'stale' });
  // A forged empty object never supplies the missing other-mode receipt.
  expect(() => f.owner.projectResearchReference({} as ResearchReferenceScreeningReceipt)).toThrow();
  expect(f.calls).toHaveLength(0);
});

test('query-role projection makes no claim about fragments or server-specific query delimiters', async () => {
  const f = fixture();
  const fragment = 'https://example.test/#access_token=synthetic-fragment';
  const serverSpecific = 'https://example.test/?id=123;auth=synthetic-server-field';
  expect(await f.project(fragment)).toEqual([fragment]);
  expect(await f.project(serverSpecific)).toEqual([serverSpecific]);
  expect(f.calls.map(call => call.body.state)).toEqual([{ parameter: 'id' }]);
  expect(JSON.stringify(f.calls)).not.toContain('synthetic-');
});

test('non-string inputs are refused without invoking coercion or proxy traps', () => {
  const f = fixture(); let reads = 0;
  const input = new Proxy({}, { get() { reads++; throw new Error('synthetic-private-error'); },
    getPrototypeOf() { reads++; throw new Error('synthetic-private-error'); } });
  expect(() => f.owner.captureResearchReference(input as string)).toThrow();
  expect(reads).toBe(0); expect(f.calls).toHaveLength(0);
});

test('name-role capacity never evicts an earlier outcome or sends overflowing names', async () => {
  const f = fixture();
  for (let offset = 0; offset < 1_024; offset += 100) {
    const names = Array.from({ length: Math.min(100, 1_024 - offset) }, (_, index) => `field${offset + index}=ordinary`);
    await f.project(`https://example.test/?${names.join('&')}`);
  }
  expect(f.calls).toHaveLength(1_024);
  const overflow = f.owner.captureResearchReference('https://example.test/?new_field=synthetic-sentinel');
  expect(await f.owner.screenResearchReference(overflow)).toEqual({ status: 'held', reason: 'capacity' });
  expect(await f.owner.screenResearchReference(overflow)).toEqual({ status: 'held', reason: 'capacity' });
  await f.owner.release(overflow);
  expect(await f.project('https://other.example.test/?field0=changed#anchor')).toEqual(['https://other.example.test/?field0=changed#anchor']);
  expect(f.calls).toHaveLength(1_024);
}, 30_000);

test('reference cancellation retires the request before release completes and permits no late projection', async () => {
  const started = deferred<void>(), finish = deferred<void>();
  const f = fixture({ judge: async () => { started.resolve(); await finish.promise; return answer(); } });
  const source = f.owner.captureResearchReference('https://example.test/?auth=synthetic-sentinel');
  const pending = f.owner.screenResearchReference(source); await started.promise;
  await f.owner.release(source);
  expect(await pending).toEqual({ status: 'held', reason: 'cancelled' });
  finish.resolve();
  expect(await f.owner.screenResearchReference(source)).toEqual({ status: 'held', reason: 'stale' });
  expect(JSON.stringify(f.calls)).not.toContain('synthetic-sentinel');
  const closing = f.owner.close(); expect(f.owner.close()).toBe(closing); await closing;
});
