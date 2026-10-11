import { afterEach, expect, test } from 'bun:test';
import { classifyKnowledgeError, fetchConnectedHostStatus, getAgentKnowledgeJson, postAgentKnowledgeJson } from '../../cli/agent-knowledge-runtime.ts';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function scene(onRequest?: (request: Request) => void, responseStatus = 200) {
  const requests: Array<{ route: string; authorization: string | null; body: string }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ route: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body: await request.text() });
    onRequest?.(request);
    return Response.json({ source: { id: 'isolated-http-source' }, compatible: true, error: 'isolated-remote-private-error' }, { status: new URL(request.url).pathname === '/status' ? 200 : responseStatus });
  } }); servers.push(server);
  return { server, requests, connection: { baseUrl: server.url.origin, token: 'isolated-http-token', tokenPath: 'isolated fixture' } };
}
test('POST carries the actual operator credential and complete original input to the isolated HTTP endpoint', async () => {
  let checks = 0; const f = scene(), controller = new AbortController();
  const result = await postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/url',
    { url: 'https://example.com/docs', metadata: { original: 'complete' } }, { signal: controller.signal, assertCurrent() { checks++; } });
  expect(result).toMatchObject({ source: { id: 'isolated-http-source' } });
  expect(f.requests).toHaveLength(1); expect(f.requests[0]?.authorization).toBe('Bearer isolated-http-token');
  expect(JSON.parse(f.requests[0]?.body ?? '{}')).toEqual({ url: 'https://example.com/docs', metadata: { original: 'complete' } });
  expect(checks).toBeGreaterThan(3);
});
test.each(['input', 'connection', 'options', 'authority'] as const)('POST cannot adopt a response after %s changes', async change => {
  const body = { url: 'https://example.com/original' }; let current = true;
  const originalGuard = () => { if (!current) throw new Error('Retired owner'); };
  const options = { assertCurrent: originalGuard };
  const f = scene(() => {
    if (change === 'input') body.url = 'https://example.com/replacement';
    else if (change === 'connection') f.connection.token = 'replacement-private-token';
    else if (change === 'options') options.assertCurrent = () => {};
    else current = false;
  });
  await expect(postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/url', body, options)).rejects.toThrow();
  expect(f.requests).toHaveLength(1); expect(f.requests[0]?.authorization).toBe('Bearer isolated-http-token');
});
test('a replaced HTTP transport cannot receive the POST or adopt a response', async () => {
  const original = globalThis.fetch; let replacementCalls = 0, changed = false;
  const replacement: typeof fetch = Object.assign(async () => { replacementCalls++; return Response.json({ unexpected: true }); }, { preconnect: original.preconnect });
  const f = scene();
  try {
    await expect(postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/url', { url: 'https://example.com/docs' }, {
      assertCurrent() { if (!changed) { changed = true; globalThis.fetch = replacement; } },
    })).rejects.toThrow('transport changed');
    expect(f.requests).toHaveLength(0); expect(replacementCalls).toBe(0);
  } finally { globalThis.fetch = original; }
});
test.each(['cancel', 'retire'] as const)('404 classification cannot dispatch fallback status after %s', async change => {
  const f = scene(), controller = new AbortController(); let current = true;
  if (change === 'cancel') controller.abort(); else current = false;
  await expect(classifyKnowledgeError(new Error('HTTP 404 Not found'), f.connection, '/api/goodvibes-agent/knowledge/ingest/url', {
    signal: controller.signal, assertCurrent() { if (!current) throw new Error('Retired owner'); },
  })).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});
test('current genuine HTTP 404 classification performs one restricted real status request', async () => {
  const f = scene(undefined, 404); let checks = 0;
  let failure: unknown;
  try { await postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/url', { url: 'https://example.com/docs' }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  const result = await classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/ingest/url', { assertCurrent() { checks++; } });
  expect(result.kind).toBe('connected_host_incompatible'); expect(f.requests).toHaveLength(2);
  expect(f.requests[1]?.route).toBe('/status'); expect(f.requests[1]?.authorization).toBe('Bearer isolated-http-token');
  expect(checks).toBeGreaterThan(3);
});
test.each(['input', 'connection', 'restriction', 'cancel'] as const)('a genuine failed POST retains its original %s through status classification', async change => {
  const f = scene(undefined, 404), controller = new AbortController();
  const body = { url: 'https://example.com/original' }; let current = true, failure: unknown;
  const options = { signal: controller.signal, assertCurrent() { if (!current) throw new Error('Retired request'); } };
  try { await postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/url', body, options); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  if (change === 'input') body.url = 'https://example.com/replacement';
  else if (change === 'connection') f.connection.token = 'replacement-private-token';
  else if (change === 'restriction') current = false;
  else controller.abort();
  await expect(classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/ingest/url')).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
});
test('arbitrary 404 or auth error prose cannot fabricate an HTTP status receipt', async () => {
  const f = scene();
  for (const error of [new Error('HTTP 404 Not found'), new Error('HTTP 401 unauthorized')]) {
    expect((await classifyKnowledgeError(error, f.connection, '/api/goodvibes-agent/knowledge/ingest/url')).kind).toBe('connected_host_error');
  }
  expect(f.requests).toHaveLength(0);
});

test.each([401, 403])('actual HTTP %i refusal classifies auth without publishing remote error text', async status => {
  const f = scene(undefined, status); let failure: unknown;
  try { await postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/url', { url: 'https://example.com/docs' }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  const result = await classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/ingest/url');
  expect(result.kind).toBe('auth_required'); expect(f.requests).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('isolated-remote-private-error');
  expect(failure instanceof Error && failure.message).not.toContain('isolated-remote-private-error');
});
test('actual GET HTTP failure retains typed status after error prose redaction', async () => {
  const f = scene(undefined, 404); let failure: unknown;
  try { await getAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/sources'); }
  catch (error) { failure = error; }
  const result = await classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/sources');
  expect(result.kind).toBe('connected_host_incompatible');
  expect(f.requests.map(request => request.route)).toEqual(['/api/goodvibes-agent/knowledge/sources', '/status']);
  expect(JSON.stringify(result)).not.toContain('isolated-remote-private-error');
});
test('actual loopback transport rejection retains unavailable classification without arbitrary error prose', async () => {
  const f = scene(); f.server.stop(true); let failure: unknown;
  try { await postAgentKnowledgeJson(f.connection, '/api/goodvibes-agent/knowledge/ingest/url', { url: 'https://example.com/docs' }); }
  catch (error) { failure = error; }
  expect((await classifyKnowledgeError(failure, f.connection, '/api/goodvibes-agent/knowledge/ingest/url')).kind).toBe('connected_host_unavailable');
  expect(f.requests).toHaveLength(0);
});
test('status response cannot publish after the retained owner retires', async () => {
  let current = true; const f = scene(() => { current = false; });
  await expect(fetchConnectedHostStatus(f.connection, { assertCurrent() { if (!current) throw new Error('Retired owner'); } })).rejects.toThrow('Retired owner');
  expect(f.requests).toHaveLength(1);
});
test('real response body cancellation retires an in-flight POST without status dispatch', async () => {
  const controller = new AbortController(); const requests: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return new Response(new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(new TextEncoder().encode('{"source":'));
      queueMicrotask(() => { controller.abort(); stream.close(); });
    } }));
  } }); servers.push(server);
  const connection = { baseUrl: server.url.origin, token: 'isolated-body-token', tokenPath: 'isolated fixture' };
  await expect(postAgentKnowledgeJson(connection, '/api/goodvibes-agent/knowledge/ingest/url', { url: 'https://example.com/docs' }, { signal: controller.signal })).rejects.toThrow();
  expect(requests).toEqual(['/api/goodvibes-agent/knowledge/ingest/url']);
});
