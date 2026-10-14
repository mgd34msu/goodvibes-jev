import { screeningAnswers } from './_helpers/screening-answers.js';
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as directClient from '../sdk/src/platform/security/source-screening/direct-client.ts';
import { createProtectedSourceOwner } from '../sdk/src/platform/security/source-screening/owner.ts';
import { createScreeningTransport, HOSTED_SOURCE_SCREENING_ROUTES as routes } from '../sdk/src/platform/security/source-screening/transport.ts';
import type { HostedProtectedSourceOwnerOptions, ProtectedSourceOwner } from '../sdk/src/platform/security/source-screening/types.ts';

const abacusApiKey = 'synthetic-abacus-private-key';
const typesafeApiKey = 'synthetic-typesafe-private-key';
const closes: Array<() => Promise<void>> = [];
const restore: Array<() => void> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  for (const reset of restore.splice(0).reverse()) reset();
});
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid synthetic object');
  return Object.fromEntries(Object.entries(value));
}
function sourceFrom(body: Record<string, unknown>): { readonly revision: string; readonly parts: readonly string[] } {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length !== 2) throw new Error('Invalid synthetic proposal messages');
  const content = object(messages[1]).content;
  if (typeof content !== 'string') throw new Error('Invalid synthetic proposal source');
  const source = object(JSON.parse(content));
  if (typeof source.revision !== 'string' || !Array.isArray(source.parts) || !source.parts.every(part => typeof part === 'string'))
    throw new Error('Invalid synthetic source');
  return { revision: source.revision, parts: source.parts };
}
function proposal(revision: string, spans: readonly { part: number; start: number; end: number }[] = []): Response {
  return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision, spans }) } }] });
}
function judgment(body: Record<string, unknown>, complete = 1, precise = 1, model = 'jev-1.13.0'): Response {
  return Response.json({ model, answers: screeningAnswers(body, { complete: complete, precise: precise }),
    usage: { input_tokens: 10, output_tokens: 2 } });
}
interface Call { readonly url: string; readonly headers: readonly [string, string][]; readonly body: Record<string, unknown>; }
function fixture(options: {
  readonly assertCurrent?: () => void;
  readonly respond?: (call: Call, number: number) => Response | Promise<Response>;
  readonly onRetry?: HostedProtectedSourceOwnerOptions['onRetry'];
} = {}) {
  const calls: Call[] = [];
  // Synthetic protocol substitution at the existing private direct-client seam.
  // No hosted socket, actual account, or genuine model qualification is claimed.
  const stub = spyOn(directClient, 'fetchDirect').mockImplementation(async (_client, request) => {
    const body = object(JSON.parse(await request.text()));
    const call: Call = { url: request.url, headers: [...request.headers], body };
    calls.push(call);
    if (options.respond) return options.respond(call, calls.length);
    return call.url === routes.proposal ? proposal(sourceFrom(body).revision) : judgment(body);
  });
  restore.push(() => stub.mockRestore());
  const lifetime = new AbortController();
  const config: HostedProtectedSourceOwnerOptions = {
    kind: 'hosted',
    authority: { kind: 'hosted', ownerId: 'synthetic-hosted-owner', revision: '1',
      retention: 'provider-managed-zero-retention-unverified', signal: lifetime.signal, assertCurrent: options.assertCurrent ?? (() => {}) },
    credentials: { abacusApiKey, typesafeApiKey }, timeoutMs: 1_000,
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
  };
  const owner = createProtectedSourceOwner(config);
  closes.push(() => owner.close());
  return { owner, config, calls, lifetime };
}
async function project(owner: ProtectedSourceOwner, parts: readonly string[]): Promise<readonly string[]> {
  const result = await owner.screen(owner.capture(parts));
  expect(result.status).toBe('settled');
  if (result.status !== 'settled') throw new Error('Synthetic hosted protocol did not settle');
  return owner.project(result.receipt);
}
async function rejection(work: Promise<unknown>): Promise<Error> {
  try { await work; } catch (error) {
    if (!(error instanceof Error)) throw new Error('Invalid synthetic rejection');
    expect(error.cause).toBeUndefined();
    for (const secret of [abacusApiKey, typesafeApiKey, 'synthetic-borrowed-secret']) expect(error.message).not.toContain(secret);
    return error;
  }
  throw new Error('Expected source-screening refusal');
}

test('explicit hosted grant uses fixed Abacus and latest TypeSafe protocol with private origin-bound headers', async () => {
  const text = 'Contact person@example.test, then keep the build notes. 🙂';
  const f = fixture({ respond: call => call.url === routes.proposal
    ? proposal(sourceFrom(call.body).revision, [{ part: 1, start: 8, end: 27 }]) : judgment(call.body) });
  expect(await project(f.owner, ['Direct message', text])).toEqual(['Direct message', 'Contact [redacted], then keep the build notes. 🙂']);
  expect(f.calls.map(call => call.url)).toEqual([routes.proposal, routes.judgment]);
  expect(f.calls[0]?.body.model).toBe('route-llm');
  expect(f.calls[1]?.body.model).toBe('jev-latest');
  expect(f.calls[0]?.headers).toEqual([['authorization', `Bearer ${abacusApiKey}`], ['content-type', 'application/json']]);
  expect(f.calls[1]?.headers).toEqual([['authorization', `Bearer ${typesafeApiKey}`], ['content-type', 'application/json']]);
  expect(f.calls[1]?.body.state).toMatchObject({ parts: ['Direct message', text], spans: [{ part: 1, start: 8, end: 27 }] });
  for (const call of f.calls) {
    expect(JSON.stringify(call.body)).not.toContain(abacusApiKey);
    expect(JSON.stringify(call.body)).not.toContain(typesafeApiKey);
  }
});

test('hosted capture detaches original source and native key values before asynchronous work', async () => {
  const f = fixture();
  const original = ['Original complete source.'];
  const handle = f.owner.capture(original);
  original[0] = 'Borrowed late replacement.';
  Object.defineProperty(f.config.credentials, 'abacusApiKey', { value: 'different-private-key' });
  Object.defineProperty(f.config.credentials, 'typesafeApiKey', { value: 'different-private-key' });
  const result = await f.owner.screen(handle);
  expect(result.status).toBe('settled');
  if (result.status === 'settled') expect(f.owner.project(result.receipt)).toEqual(['Original complete source.']);
  expect(f.calls[0]?.headers).toContainEqual(['authorization', `Bearer ${abacusApiKey}`]);
  expect(f.calls[1]?.headers).toContainEqual(['authorization', `Bearer ${typesafeApiKey}`]);
});

test('hosted authorization cannot claim local no-log retention or admit caller destinations and dispatchers', () => {
  const f = fixture();
  for (const changed of [
    { ...f.config, authority: { ...f.config.authority, retention: 'ephemeral-no-log' } },
    { ...f.config, authority: { ...f.config.authority, kind: 'local' } },
    { ...f.config, endpoint: routes.proposal }, { ...f.config, proposal: { endpoint: routes.proposal, model: 'other' } },
    { ...f.config, fetch: () => {} }, { ...f.config, headers: { authorization: 'wrong' } }, { ...f.config, dispatcher: {} },
  ]) {
    expect(() => Reflect.apply(createProtectedSourceOwner, undefined, [changed])).toThrow('Protected source owner is unavailable');
  }
  expect(() => createProtectedSourceOwner({ authority: { ownerId: 'local', revision: '1', retention: 'ephemeral-no-log',
    signal: new AbortController().signal, assertCurrent() {} },
    proposal: { endpoint: 'https://routellm.abacus.ai', model: 'route-llm' },
    judgment: { endpoint: 'https://api.typesafe.ai', model: 'jev-1.13.0' } })).toThrow('literal-loopback');
  expect(f.calls).toHaveLength(0);
});

test('private keys require strict data descriptors and malformed credentials never transmit or execute getters', () => {
  const f = fixture();
  let reads = 0;
  const accessor = Object.defineProperty({ typesafeApiKey }, 'abacusApiKey', { get() { reads++; return abacusApiKey; } });
  const proxy = new Proxy({ abacusApiKey, typesafeApiKey }, { ownKeys() { reads++; throw new Error('private'); },
    getPrototypeOf() { reads++; throw new Error('private'); } });
  const extra = Object.defineProperty({ abacusApiKey, typesafeApiKey }, 'private', { value: 'hidden' });
  for (const credentials of [accessor, proxy, extra, { abacusApiKey: '', typesafeApiKey }, { abacusApiKey, typesafeApiKey: 'bad\r\nheader' },
    { abacusApiKey: ' '.repeat(10), typesafeApiKey }, { abacusApiKey: 'X'.repeat(8_193), typesafeApiKey }]) {
    expect(() => Reflect.apply(createProtectedSourceOwner, undefined, [{ ...f.config, credentials }])).toThrow('credentials are unavailable');
  }
  const badAuthority = Object.defineProperty({ ...f.config.authority }, 'assertCurrent', { get() { reads++; return () => {}; } });
  expect(() => Reflect.apply(createProtectedSourceOwner, undefined, [{ ...f.config, authority: badAuthority }])).toThrow('Protected source owner is unavailable');
  expect(reads).toBe(0); expect(f.calls).toHaveLength(0);
});

test('hosted known credential and card floors run before proposal or judgment transmission', () => {
  const f = fixture();
  for (const text of [abacusApiKey, typesafeApiKey, 'apiKey=synthetic-value', 'password=synthetic-value',
    'ghp_' + 'X'.repeat(40), '4111 1111 1111 1111']) expect(() => f.owner.capture([text])).toThrow();
  expect(f.calls).toHaveLength(0);
});

test.each([abacusApiKey, typesafeApiKey])('fully encoded captured key in a research query name is refused before any hosted request', secret => {
  const f = fixture();
  const encoded = [...secret].map(character => '%' + character.charCodeAt(0).toString(16)).join('');
  const original = `https://example.test/document?${encoded}=ordinary#section`;
  expect(original).not.toContain(secret);
  expect(() => f.owner.captureResearchReference(original)).toThrow();
  expect(f.calls).toHaveLength(0);
});

test('an encoded ordinary query name keeps its exact original reference after the unchanged role reading', async () => {
  const original = 'HTTPS://EXAMPLE.TEST:443/doc%2fument?%64%6f%63%75%6d%65%6e%74%5f%69%64=ordinary#section-%F0%9F%99%82';
  const f = fixture({ respond: () => Response.json({ model: 'jev-1.13.0', answers: { credential: { type: 'noul', noul: 0 } },
    usage: { input_tokens: 5, output_tokens: 1 } }) });
  const handle = f.owner.captureResearchReference(original);
  const result = await f.owner.screenResearchReference(handle);
  expect(result.status).toBe('settled');
  if (result.status !== 'settled') throw new Error('Synthetic ordinary reference did not settle');
  expect(f.owner.projectResearchReference(result.receipt)).toEqual({ status: 'preserved', url: original });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.url).toBe(routes.judgment);
  expect(f.calls[0]?.body.state).toEqual({ parameter: 'document_id' });
  for (const secret of [abacusApiKey, typesafeApiKey]) expect(JSON.stringify(f.calls[0]?.body)).not.toContain(secret);
});

test('hosted transport admits only two literal HTTPS targets and replaces every caller-supplied header', async () => {
  const f = fixture({ respond: call => call.url === routes.proposal ? proposal(sourceFrom(call.body).revision) : Response.json({ transport: 'synthetic' }) });
  const owned = createScreeningTransport({ kind: 'hosted', credentials: f.config.credentials,
    signal: f.lifetime.signal, assertCurrent() {}, timeoutMs: 1_000 });
  closes.push(() => owned.close());
  const post = { method: 'POST', body: '{"model":"synthetic"}', headers: { authorization: 'synthetic-borrowed-secret',
    'x-api-key': 'synthetic-borrowed-secret', cookie: 'session=synthetic-borrowed-secret', 'proxy-authorization': 'private' },
    dispatcher: {}, proxy: 'http://127.0.0.1:1', redirect: 'follow' as const };
  for (const url of [routes.proposal + '/', routes.judgment + '?', routes.judgment + '#x', routes.proposal.replace('https:', 'http:'),
    routes.judgment.replace('api.typesafe.ai', 'other.typesafe.ai'), routes.judgment.replace('api.typesafe.ai', 'api.typesafe.ai:443'),
    'https://routellm.abacus.ai/v1/systemone', 'https://api.typesafe.ai/v1/chat/completions']) await rejection(owned.fetch(url, post));
  expect(f.calls).toHaveLength(0);
  // The proposal fixture needs a complete source; use exact canonical body framing.
  const body = JSON.stringify({ messages: [{ content: '' }, { content: JSON.stringify({ revision: 'synthetic', parts: ['ordinary'] }) }] });
  await owned.fetch(routes.proposal, { ...post, body });
  await owned.fetch(routes.judgment, post);
  expect(f.calls.map(call => call.headers)).toEqual([
    [['authorization', `Bearer ${abacusApiKey}`], ['content-type', 'application/json']],
    [['authorization', `Bearer ${typesafeApiKey}`], ['content-type', 'application/json']],
  ]);
});

test.each([0, 0.5, 0.97])('hosted coverage probability %s stays held without a lucky semantic retry', async complete => {
  const f = fixture({ respond: call => call.url === routes.proposal ? proposal(sourceFrom(call.body).revision) : judgment(call.body, complete) });
  const handle = f.owner.capture(['Ordinary complete source.']);
  expect(await f.owner.screen(handle)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(await f.owner.screen(handle)).toEqual({ status: 'held', reason: 'unsettled' });
  expect(f.calls).toHaveLength(2);
});

test('hosted model mismatch never grants calibrated source privacy authority', async () => {
  const f = fixture({ respond: call => call.url === routes.proposal ? proposal(sourceFrom(call.body).revision) : judgment(call.body, 1, 1, 'other-model') });
  expect(await f.owner.screen(f.owner.capture(['Ordinary source.']))).toEqual({ status: 'held', reason: 'route-unavailable' });
  expect(f.calls).toHaveLength(2);
});

test.each(['revision', 'range', 'overlap'])('hosted malformed %s proposal cannot reach Jev or release original text', async kind => {
  const f = fixture({ respond: call => {
    const revision = sourceFrom(call.body).revision;
    if (kind === 'revision') return proposal('foreign-revision');
    return proposal(revision, kind === 'range' ? [{ part: 0, start: 0, end: 999 }] : [
      { part: 0, start: 0, end: 5 }, { part: 0, start: 4, end: 8 },
    ]);
  } });
  expect(await f.owner.screen(f.owner.capture(['Ordinary original source.']))).toEqual({ status: 'held', reason: 'malformed' });
  expect(f.calls.map(call => call.url)).toEqual([routes.proposal]);
});

test('hosted semantic precision refusal cannot redact unrelated source to force completeness', async () => {
  const f = fixture({ respond: call => call.url === routes.proposal ? proposal(sourceFrom(call.body).revision, [{ part: 0, start: 0, end: 8 }])
    : judgment(call.body, 1, 0) });
  expect(await f.owner.screen(f.owner.capture(['Ordinary source.']))).toEqual({ status: 'held', reason: 'unsettled' });
  expect(f.calls).toHaveLength(2);
});

test('hosted revocation after proposal prevents late Jev transmission', async () => {
  let current = true;
  const f = fixture({ assertCurrent() { if (!current) throw new Error('synthetic-borrowed-secret'); }, respond: call => {
    current = false; return proposal(sourceFrom(call.body).revision);
  } });
  expect(await f.owner.screen(f.owner.capture(['Ordinary source.']))).toEqual({ status: 'held', reason: 'stale' });
  expect(f.calls.map(call => call.url)).toEqual([routes.proposal]);
});

test('hosted settled receipts lose projection authority after native retirement or release', async () => {
  const f = fixture();
  const handle = f.owner.capture(['Ordinary source.']);
  const result = await f.owner.screen(handle);
  expect(result.status).toBe('settled');
  if (result.status !== 'settled') return;
  expect(f.owner.project(result.receipt)).toEqual(['Ordinary source.']);
  f.lifetime.abort(new Error('synthetic-borrowed-secret'));
  expect(() => f.owner.project(result.receipt)).toThrow('handle is not current');
  await f.owner.release(handle);
  expect(() => f.owner.project(result.receipt)).toThrow('handle is not current');
});

test('hosted cancellation joins delayed private body retirement and publishes no late receipt', async () => {
  const bodyRead = Promise.withResolvers<void>(), cancelBody = Promise.withResolvers<void>(), retireBody = Promise.withResolvers<void>();
  const f = fixture({ respond: () => new Response(new ReadableStream<Uint8Array>({
    pull() { bodyRead.resolve(); }, cancel() { cancelBody.resolve(); return retireBody.promise; },
  }, { highWaterMark: 0 })) });
  const pending = f.owner.screen(f.owner.capture(['Ordinary complete source.']));
  await bodyRead.promise;
  f.lifetime.abort(new Error('synthetic-borrowed-secret'));
  await cancelBody.promise;
  let finished = false;
  const closing = f.owner.close().then(() => { finished = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 10));
  expect(finished).toBe(false);
  retireBody.resolve();
  await closing;
  expect(await pending).toEqual({ status: 'held', reason: 'cancelled' });
  expect(f.calls).toHaveLength(1);
});

test('hosted canonical Jev retry retains fixed key, source and live grant without proposal fallback', async () => {
  let judgmentCalls = 0;
  const f = fixture({ respond: call => {
    if (call.url === routes.proposal) return proposal(sourceFrom(call.body).revision);
    return ++judgmentCalls === 1 ? new Response('synthetic-private-upstream-body', { status: 503 }) : judgment(call.body);
  } });
  expect(await project(f.owner, ['Ordinary source.'])).toEqual(['Ordinary source.']);
  expect(f.calls.map(call => call.url)).toEqual([routes.proposal, routes.judgment, routes.judgment]);
  expect(f.calls.slice(1).every(call => call.headers.some(([name, value]) => name === 'authorization' && value === `Bearer ${typesafeApiKey}`))).toBe(true);
}, 10_000);

test('native hosted grant revocation during Jev backoff fences the next actual attempt', async () => {
  let current = true;
  const f = fixture({ assertCurrent() { if (!current) throw new Error('synthetic-borrowed-secret'); },
    onRetry(progress) {
      expect(progress.attempt.endpointKind).toBe('hosted');
      expect(JSON.stringify(progress)).not.toContain('Ordinary source.');
      expect(JSON.stringify(progress)).not.toContain(typesafeApiKey);
      current = false;
    },
    respond: call => call.url === routes.proposal ? proposal(sourceFrom(call.body).revision)
      : new Response('synthetic-private-upstream-body', { status: 503 }),
  });
  expect(await f.owner.screen(f.owner.capture(['Ordinary source.']))).toEqual({ status: 'held', reason: 'stale' });
  expect(f.calls.map(call => call.url)).toEqual([routes.proposal, routes.judgment]);
}, 10_000);
