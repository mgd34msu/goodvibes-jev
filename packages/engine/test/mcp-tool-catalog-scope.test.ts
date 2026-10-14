import { expect, test } from 'bun:test';
import { McpClient, captureMcpClientToolCatalog } from '../sdk/src/platform/mcp/client.js';
import { McpHttpConnection } from '../sdk/src/platform/mcp/http-connection.js';
import { McpRegistry } from '../sdk/src/platform/mcp/registry.js';
import { createMcpApi } from '../sdk/src/platform/mcp/mcp-api.js';
import type { McpServerConfig } from '../sdk/src/platform/mcp/config.js';
import { MCP_STATELESS_REVISION } from '../sdk/src/platform/mcp/protocol.js';
import { SandboxSessionRegistry } from '../sdk/src/platform/runtime/sandbox/session-registry.js';
import { useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings();

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function serverFixture(legacy = false) {
  let lists = 0, calls = 0, deletes = 0, generation = 1, notifyNext = false, failNextList = false;
  let hold: { readonly entered: ReturnType<typeof gate>; readonly release: ReturnType<typeof gate>; readonly stream?: 'response' | 'body' } | undefined;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (request.method === 'DELETE') {
      if (!legacy || new URL(request.url).pathname !== '/mcp' || request.headers.get('mcp-session-id') !== 'native-session')
        return new Response(null, { status: 400 });
      deletes += 1; return new Response(null, { status: 204 });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('method' in body)) return new Response(null, { status: 400 });
    if (!('id' in body)) return new Response(null, { status: 202 });
    if (legacy && body.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Legacy discovery' } });
    if (legacy && body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'native-fixture', version: '1' } } }, { headers: { 'mcp-session-id': 'native-session' } });
    const discover = { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: { listChanged: true } } };
    if (body.method === 'server/discover' && notifyNext) {
      notifyNext = false;
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: discover })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } });
    }
    let result: unknown = discover;
    if (body.method === 'tools/list') {
      lists += 1;
      if (failNextList) { failNextList = false; return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'Synthetic metadata unavailable' } }); }
      result = { tools: [{ name: 'observe', description: `Native generation ${generation}.`, inputSchema: { type: 'object', properties: { generation: { const: generation } } } }] };
      const waiting = hold;
      if (waiting) {
        hold = undefined; waiting.entered.resolve();
        if (waiting.stream === 'body') {
          let cancelled = false;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'fixture/reader-ready' })}\n\n`));
              void waiting.release.promise.then(() => {
                if (cancelled) return;
                if (notifyNext) {
                  notifyNext = false;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`));
                }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`));
                controller.close();
              }).catch(() => undefined);
            },
            cancel() { cancelled = true; },
          }), { headers: { 'content-type': 'text/event-stream' } });
        }
        await waiting.release.promise;
        if (waiting.stream === 'response') return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } });
      }
    } else if (body.method === 'tools/call') {
      calls += 1; result = { forbidden: true };
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result }, legacy ? { headers: { 'mcp-session-id': 'native-session' } } : undefined);
  } });
  const config: McpServerConfig = { name: 'native', url: `http://127.0.0.1:${server.port}/mcp`, trustMode: 'allow-all' };
  return { config, server, get lists() { return lists; }, get calls() { return calls; }, get deletes() { return deletes; },
    change() { generation += 1; notifyNext = true; },
    failNext() { failNextList = true; },
    blockNext() { const waiting = { entered: gate(), release: gate() }; hold = waiting; return waiting; },
    blockNextSse() { const waiting = { entered: gate(), release: gate(), stream: 'response' as const }; hold = waiting; return waiting; },
    blockNextStream() { const waiting = { entered: gate(), release: gate(), stream: 'body' as const }; hold = waiting; return waiting; } };
}

function registryFixture() {
  return new McpRegistry({ hookDispatcher: { fire: async () => ({ ok: true }) },
    sandboxSessions: new SandboxSessionRegistry('/synthetic/native-tool-catalog') });
}

async function closeClient(client: McpClient, fixture: ReturnType<typeof serverFixture>, pending: readonly Promise<unknown>[] = []) {
  await client.disconnect(); await Promise.allSettled(pending); fixture.server.stop(true);
}

test('native catalog capture owns one cold acquisition and retains the exact warm metadata', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config);
  try {
    await client.connect();
    const first = client.captureToolCatalog(), second = client.captureToolCatalog();
    expect(first.connected).toBe(true);
    const [a, b] = await Promise.all([first.listTools(), second.listTools()]);
    expect(a).toBe(b); expect(a).toEqual([{ name: 'observe', description: 'Native generation 1.' }]);
    expect(fixture.lists).toBe(1); expect(first.assertCurrent()).toBeUndefined(); expect(second.assertCurrent()).toBeUndefined();
    const warm = client.captureToolCatalog();
    expect(await warm.listTools()).toBe(a); expect(fixture.lists).toBe(1); expect(fixture.calls).toBe(0);
  } finally { await closeClient(client, fixture); }
});

test('a native wire notification retires metadata and schema ownership before observers run', async () => {
  const fixture = serverFixture();
  let observed = false;
  let retained: ReturnType<McpClient['captureToolCatalog']> | undefined;
  const client = new McpClient(fixture.config, { onNotification: notification => {
    if (notification.method === 'notifications/tools/list_changed') {
      observed = true; expect(() => retained!.assertCurrent()).toThrow();
    }
  } });
  try {
    await client.connect(); retained = client.captureToolCatalog(); await retained.listTools();
    const schema = await client.getToolSchema('observe'); expect(schema?.inputSchema).toEqual({ type: 'object', properties: { generation: { const: 1 } } });
    const schemaScope = client.captureToolSchemaScope('observe');
    fixture.change(); expect(await client.ping()).toBe(true); expect(observed).toBe(true);
    expect(() => retained!.assertCurrent()).toThrow(); expect(() => schemaScope.assertCurrent()).toThrow();
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native generation 2.' }]);
    expect((await client.getToolSchema('observe'))?.inputSchema).toEqual({ type: 'object', properties: { generation: { const: 2 } } });
    expect(fixture.lists).toBe(4); expect(fixture.calls).toBe(0);
  } finally { await closeClient(client, fixture); }
});

test('wire retirement during a deferred metadata response cannot adopt the old response', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config), waiting = fixture.blockNext();
  let pending: Promise<unknown> | undefined;
  try {
    await client.connect(); const retained = client.captureToolCatalog();
    pending = retained.listTools(); void pending.catch(() => undefined); await waiting.entered.promise;
    fixture.change(); expect(await client.ping()).toBe(true); waiting.release.resolve();
    await expect(pending).rejects.toThrow(); expect(() => retained.assertCurrent()).toThrow();
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native generation 2.' }]);
    expect(fixture.lists).toBe(2); expect(fixture.calls).toBe(0);
  } finally { waiting.release.resolve(); await closeClient(client, fixture, pending ? [pending] : []); }
});

test('wire retirement during a deferred full-schema response cannot repopulate the schema cache', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config);
  let waiting: ReturnType<typeof fixture.blockNext> | undefined, pending: Promise<unknown> | undefined;
  try {
    await client.connect(); await client.listTools(); waiting = fixture.blockNext();
    pending = client.getToolSchema('observe'); void pending.catch(() => undefined); await waiting.entered.promise;
    fixture.change(); expect(await client.ping()).toBe(true); waiting.release.resolve();
    await expect(pending).rejects.toThrow(); expect(() => client.captureToolSchemaScope('observe')).toThrow();
    expect((await client.getToolSchema('observe'))?.inputSchema).toEqual({ type: 'object', properties: { generation: { const: 2 } } });
    expect(fixture.lists).toBe(3); expect(fixture.calls).toBe(0);
  } finally { waiting?.release.resolve(); await closeClient(client, fixture, pending ? [pending] : []); }
});

test('a retained native metadata array cannot drift behind an unchanged cache identity', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config);
  try {
    await client.connect(); const retained = client.captureToolCatalog(), tools = await retained.listTools();
    tools[0]!.description = 'Changed after native acquisition.';
    expect(() => retained.assertCurrent()).toThrow(); expect(fixture.lists).toBe(1); expect(fixture.calls).toBe(0);
  } finally { await closeClient(client, fixture); }
});

test('first caller currentness cannot replace the native catalog capture baseline', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config);
  try {
    await client.connect();
    expect(() => client.captureToolCatalog({ assertCurrent: () => { fixture.config.url = 'http://127.0.0.1:1/changed'; } })).toThrow();
    expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { await closeClient(client, fixture); }
});

test('actual native connection retirement rejects deferred acquisition without a tool effect', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config), waiting = fixture.blockNext();
  let pending: Promise<unknown> | undefined;
  try {
    await client.connect(); const retained = client.captureToolCatalog();
    pending = retained.listTools(); void pending.catch(() => undefined); await waiting.entered.promise;
    await client.disconnect(); waiting.release.resolve();
    await expect(pending).rejects.toThrow(); expect(() => retained.assertCurrent()).toThrow(); expect(fixture.calls).toBe(0);
  } finally { waiting.release.resolve(); await closeClient(client, fixture, pending ? [pending] : []); }
});

test('native registry acquisition retains every original server and returns the exact ordered catalog', async () => {
  const first = serverFixture(), second = serverFixture(), registry = registryFixture();
  try {
    await registry.connectServer({ ...first.config, name: 'first' }); await registry.connectServer({ ...second.config, name: 'second' });
    const retained = registry.captureToolCatalog(), tools = await retained.listAllTools();
    expect(tools).toEqual([
      { qualifiedName: 'mcp:first:observe', serverName: 'first', toolName: 'observe', description: 'Native generation 1.' },
      { qualifiedName: 'mcp:second:observe', serverName: 'second', toolName: 'observe', description: 'Native generation 1.' },
    ]);
    expect<unknown>(retained.assertCurrent()).toBeUndefined(); expect<unknown>(await registry.listAllTools()).toEqual(tools);
    expect(first.lists).toBe(1); expect(second.lists).toBe(1); expect(first.calls + second.calls).toBe(0);
    registry.setServerRole('second', 'docs'); expect(() => retained.assertCurrent()).toThrow();
  } finally { await registry.disconnectAll(); first.server.stop(true); second.server.stop(true); }
});

test('caller cancellation during the first native catalog response prevents later server requests', async () => {
  const first = serverFixture(), second = serverFixture(), registry = registryFixture(), controller = new AbortController();
  const waiting = first.blockNext(); let pending: Promise<unknown> | undefined;
  try {
    await registry.connectServer({ ...first.config, name: 'first' }); await registry.connectServer({ ...second.config, name: 'second' });
    const retained = registry.captureToolCatalog({ signal: controller.signal });
    pending = retained.listAllTools(); void pending.catch(() => undefined); await waiting.entered.promise;
    controller.abort(); await expect(pending).rejects.toThrow();
    expect(second.lists).toBe(0); expect(first.calls + second.calls).toBe(0);
    // Caller cancellation is a restriction, not replacement of the pure native source receipt.
    expect(retained.assertCurrent()).toBeUndefined();
  } finally {
    waiting.release.resolve(); await registry.disconnectAll(); await Promise.allSettled(pending ? [pending] : []);
    first.server.stop(true); second.server.stop(true);
  }
});

test('caller source retirement rejects late metadata and prevents the second server read', async () => {
  const first = serverFixture(), second = serverFixture(), registry = registryFixture(), waiting = first.blockNext();
  let current = true, pending: Promise<unknown> | undefined;
  try {
    await registry.connectServer({ ...first.config, name: 'first' }); await registry.connectServer({ ...second.config, name: 'second' });
    const retained = registry.captureToolCatalog({ assertCurrent: () => { if (!current) throw new Error('Caller retired'); } });
    pending = retained.listAllTools(); void pending.catch(() => undefined); await waiting.entered.promise;
    current = false; waiting.release.resolve(); await expect(pending).rejects.toThrow('Caller retired');
    expect(second.lists).toBe(0); expect(first.calls + second.calls).toBe(0);
    // A fresh native acquisition must perform another first-server RPC: no retired result entered its cache.
    expect((await registry.captureToolCatalog().listAllTools()).length).toBe(2); expect(first.lists).toBe(2);
  } finally {
    waiting.release.resolve(); await registry.disconnectAll(); await Promise.allSettled(pending ? [pending] : []);
    first.server.stop(true); second.server.stop(true);
  }
});

test('native registry factory cannot adopt configuration intent changed by its first caller callback', async () => {
  const fixture = serverFixture(), registry = registryFixture();
  try {
    await registry.connectServer(fixture.config);
    expect(() => registry.captureToolCatalog({ assertCurrent: () => { registry.setServerTrustMode('native', 'blocked'); } })).toThrow();
    expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { await registry.disconnectAll(); fixture.server.stop(true); }
});

test('catalog capture is issued only by actual native class owners', () => {
  expect(() => McpClient.prototype.captureToolCatalog.call({} as McpClient)).toThrow();
  expect(() => McpRegistry.prototype.captureToolCatalog.call({} as McpRegistry)).toThrow();
});

test.each(['method', 'accessor'] as const)('public API retains the original native catalog factory against later %s replacement', async kind => {
  const fixture = serverFixture(), registry = registryFixture(); let invoked = 0;
  try {
    await registry.connectServer(fixture.config); const api = createMcpApi(registry);
    const replacement = () => { invoked += 1; throw new Error('Substitute capture must never run'); };
    Object.defineProperty(registry, 'captureToolCatalog', kind === 'method'
      ? { configurable: true, value: replacement }
      : { configurable: true, get: replacement });
    expect(() => api.captureToolCatalog()).toThrow(); expect(invoked).toBe(0);
    expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { delete (registry as Partial<McpRegistry>).captureToolCatalog; await registry.disconnectAll(); fixture.server.stop(true); }
});

test('catalog restrictions reject accessor and nonvoid currentness before any metadata RPC', async () => {
  const fixture = serverFixture(), registry = registryFixture(); let invoked = 0;
  try {
    await registry.connectServer(fixture.config);
    const accessor = Object.defineProperty({}, 'assertCurrent', { get() { invoked += 1; return () => undefined; } });
    expect(() => registry.captureToolCatalog(accessor)).toThrow(); expect(invoked).toBe(0);
    expect(() => registry.captureToolCatalog({ assertCurrent: (() => true) as unknown as () => void })).toThrow();
    expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { await registry.disconnectAll(); fixture.server.stop(true); }
});


test('restriction replacement during a deferred native response holds before cache publication', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config), waiting = fixture.blockNext();
  const options = { assertCurrent: () => undefined }; let pending: Promise<unknown> | undefined;
  try {
    await client.connect(); const retained = client.captureToolCatalog(options);
    pending = retained.listTools(); void pending.catch(() => undefined); await waiting.entered.promise;
    options.assertCurrent = () => undefined; waiting.release.resolve();
    await expect(pending).rejects.toThrow('restrictions');
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native generation 1.' }]);
    expect(fixture.lists).toBe(2); expect(fixture.calls).toBe(0);
  } finally { waiting.release.resolve(); await closeClient(client, fixture, pending ? [pending] : []); }
});

test('the public API forwards actual cancellation restrictions to the captured native factory', async () => {
  const fixture = serverFixture(), registry = registryFixture(), controller = new AbortController();
  try {
    await registry.connectServer(fixture.config); const api = createMcpApi(registry); controller.abort();
    expect(() => api.captureToolCatalog({ signal: controller.signal })).toThrow();
    expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { await registry.disconnectAll(); fixture.server.stop(true); }
});


test('original native client factory refuses a replaced instance factory before acquisition', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config); let invoked = 0;
  try {
    await client.connect();
    Object.defineProperty(client, 'captureToolCatalog', { configurable: true, value: () => { invoked += 1; throw new Error('Substitute factory'); } });
    expect(() => captureMcpClientToolCatalog(client)).toThrow(); expect(invoked).toBe(0);
    expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { delete (client as Partial<McpClient>).captureToolCatalog; await closeClient(client, fixture); }
});


test('an empty native registry supplies truthful empty metadata without a transport', async () => {
  const registry = registryFixture();
  try {
    const retained = registry.captureToolCatalog();
    expect(await retained.listAllTools()).toEqual([]); expect(retained.assertCurrent()).toBeUndefined();
  } finally { await registry.disconnectAll(); }
});

test('a failed connected server cannot become a complete owned semantic catalog', async () => {
  const fixture = serverFixture(), registry = registryFixture();
  try {
    await registry.connectServer(fixture.config); fixture.failNext();
    await expect(registry.captureToolCatalog().listAllTools()).rejects.toThrow('metadata unavailable');
    expect(fixture.lists).toBe(1); expect(fixture.calls).toBe(0);
    expect((await registry.captureToolCatalog().listAllTools()).length).toBe(1); expect(fixture.lists).toBe(2);
  } finally { await registry.disconnectAll(); fixture.server.stop(true); }
});


test.each(['listTools', '_request'] as const)('native catalog factory refuses a replaced %s before acquiring metadata', async key => {
  const fixture = serverFixture(), client = new McpClient(fixture.config); let invoked = 0;
  try {
    await client.connect();
    Object.defineProperty(client, key, { configurable: true, value: () => { invoked += 1; throw new Error('Substitute native collector'); } });
    expect(() => captureMcpClientToolCatalog(client)).toThrow(); expect(invoked).toBe(0);
    expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { Reflect.deleteProperty(client, key); await closeClient(client, fixture); }
});


function nativeHttp(client: McpClient): McpHttpConnection {
  const descriptor = Object.getOwnPropertyDescriptor(client, 'http');
  if (!descriptor || !('value' in descriptor) || !(descriptor.value instanceof McpHttpConnection)) throw new Error('Expected actual native HTTP transport');
  return descriptor.value;
}

test.each(['request', 'postAndParse', 'post', 'dispatchStreamMessage'] as const)('first callback cannot replace actual HTTP %s and invent or suppress native catalog data', async key => {
  const fixture = serverFixture(), client = new McpClient(fixture.config); let invoked = 0;
  let http: McpHttpConnection | undefined;
  try {
    await client.connect(); const transport = nativeHttp(client); http = transport;
    expect(() => client.captureToolCatalog({ assertCurrent: () => {
      Object.defineProperty(transport, key, { configurable: true, value: () => { invoked += 1; return Promise.resolve({ tools: [{ name: 'invented', description: 'Unsupported substitute.' }] }); } });
    } })).toThrow();
    expect(invoked).toBe(0); expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { if (http) Reflect.deleteProperty(http, key); await closeClient(client, fixture); }
});

test('first callback cannot replace native fetch getter or notification callback bindings', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config); let invoked = 0;
  let http: McpHttpConnection | undefined;
  try {
    await client.connect(); const transport = nativeHttp(client); http = transport;
    expect(() => client.captureToolCatalog({ assertCurrent: () => {
      Object.defineProperty(transport, 'fetchImpl', { configurable: true, get() { invoked += 1; return fetch; } });
    } })).toThrow(); expect(invoked).toBe(0); Reflect.deleteProperty(http, 'fetchImpl');
    const optionsSlot = Object.getOwnPropertyDescriptor(http, 'options');
    if (!optionsSlot || !('value' in optionsSlot)) throw new Error('Expected original transport options');
    const options = optionsSlot.value as { handlers: { onNotification: (...args: unknown[]) => void } };
    const original = options.handlers.onNotification;
    try {
      expect(() => client.captureToolCatalog({ assertCurrent: () => { options.handlers.onNotification = () => { invoked += 1; }; } })).toThrow();
      expect(invoked).toBe(0); expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
    } finally { options.handlers.onNotification = original; }
  } finally { if (http) Reflect.deleteProperty(http, 'fetchImpl'); await closeClient(client, fixture); }
});

test('first callback cannot suppress the actual native tools-changed invalidator', async () => {
  const fixture = serverFixture(), client = new McpClient(fixture.config); let invoked = 0;
  try {
    await client.connect();
    expect(() => client.captureToolCatalog({ assertCurrent: () => {
      Object.defineProperty(client, '_handleNotification', { configurable: true, value: () => { invoked += 1; } });
    } })).toThrow();
    expect(invoked).toBe(0); expect(fixture.lists).toBe(0); expect(fixture.calls).toBe(0);
  } finally { Reflect.deleteProperty(client, '_handleNotification'); await closeClient(client, fixture); }
});

test('ordinary legacy session request progress preserves retained native catalog ownership', async () => {
  const fixture = serverFixture(true), client = new McpClient(fixture.config);
  try {
    await client.connect(); expect(client.protocolInfo?.era).toBe('legacy');
    const retained = client.captureToolCatalog();
    expect(await retained.listTools()).toEqual([{ name: 'observe', description: 'Native generation 1.' }]);
    expect((await client.getToolSchema('observe'))?.name).toBe('observe'); expect(await client.ping()).toBe(true);
    expect(retained.assertCurrent()).toBeUndefined(); expect(fixture.lists).toBe(2); expect(fixture.calls).toBe(0);
  } finally { await closeClient(client, fixture); }
});

test('first callback cannot replace actual stdio raw dispatch before its first metadata RPC', async () => {
  const program = `let input = ''; let lists = 0;
process.stdin.on('data', chunk => {
  input += chunk.toString(); let end;
  while ((end = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1); if (!line.trim()) continue;
    const body = JSON.parse(line); if (body.id === undefined) continue;
    const result = body.method === 'server/discover'
      ? { supportedProtocolVersions: ['${MCP_STATELESS_REVISION}'], capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'observe', description: 'Native stdio list ' + (++lists) + '.' }] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) + '\\n');
  }
});`;
  const client = new McpClient({ name: 'native-stdio', command: process.execPath, args: ['-e', program] }); let invoked = 0;
  try {
    await client.connect();
    expect(() => client.captureToolCatalog({ assertCurrent: () => {
      Object.defineProperty(client, '_rawRequest', { configurable: true, value: () => { invoked += 1; return Promise.resolve({ tools: [{ name: 'invented', description: 'Unsupported raw substitute.' }] }); } });
    } })).toThrow(); expect(invoked).toBe(0); Reflect.deleteProperty(client, '_rawRequest');
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native stdio list 1.' }]);
  } finally { Reflect.deleteProperty(client, '_rawRequest'); await client.disconnect(); }
});


test.each(['captureSessionId', 'readSseResponse', 'resolveJsonRpcResponse'] as const)('a deferred HTTP response cannot execute a self-restoring %s substitute', async key => {
  const fixture = serverFixture(), client = new McpClient(fixture.config);
  const waiting = key === 'readSseResponse' ? fixture.blockNextSse() : fixture.blockNext();
  let pending: Promise<unknown> | undefined, http: McpHttpConnection | undefined, invoked = 0;
  try {
    await client.connect(); http = nativeHttp(client); const retained = client.captureToolCatalog();
    pending = retained.listTools(); void pending.catch(() => undefined); await waiting.entered.promise;
    const transport = http;
    Object.defineProperty(transport, key, { configurable: true, value: () => {
      invoked += 1; Reflect.deleteProperty(transport, key);
      return Promise.resolve({ tools: [{ name: 'invented', description: 'Unsupported transient parser.' }] });
    } });
    waiting.release.resolve(); await expect(pending).rejects.toThrow(); expect(invoked).toBe(0);
    Reflect.deleteProperty(transport, key);
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native generation 1.' }]);
    expect(fixture.lists).toBe(2); expect(fixture.calls).toBe(0);
  } finally { waiting.release.resolve(); if (http) Reflect.deleteProperty(http, key); await closeClient(client, fixture, pending ? [pending] : []); }
});

test.each(['resolveJsonRpcResponse', 'dispatchStreamMessage'] as const)('a pending SSE read cannot execute a self-restoring %s substitute', async key => {
  const fixture = serverFixture(), waiting = fixture.blockNextStream(), ready = gate(); let observed = false;
  const client = new McpClient(fixture.config, { onNotification: notification => {
    if (notification.method === 'fixture/reader-ready') ready.resolve();
    if (notification.method === 'notifications/tools/list_changed') observed = true;
  } });
  let pending: Promise<unknown> | undefined, http: McpHttpConnection | undefined, invoked = 0;
  try {
    await client.connect(); http = nativeHttp(client); const retained = client.captureToolCatalog();
    pending = retained.listTools(); void pending.catch(() => undefined); await ready.promise;
    const transport = http;
    Object.defineProperty(transport, key, { configurable: true, value: () => {
      invoked += 1; Reflect.deleteProperty(transport, key);
      return { tools: [{ name: 'invented', description: 'Unsupported transient SSE parser.' }] };
    } });
    fixture.change(); waiting.release.resolve(); await expect(pending).rejects.toThrow();
    expect(invoked).toBe(0); expect(observed).toBe(true); Reflect.deleteProperty(transport, key);
    expect(() => retained.assertCurrent()).toThrow();
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native generation 2.' }]);
    expect(fixture.lists).toBe(2); expect(fixture.calls).toBe(0);
  } finally { waiting.release.resolve(); if (http) Reflect.deleteProperty(http, key); await closeClient(client, fixture, pending ? [pending] : []); }
});

test('a pending SSE read retains the original native notification callback', async () => {
  const fixture = serverFixture(), waiting = fixture.blockNextStream(), ready = gate(); let observed = false, invoked = 0;
  const client = new McpClient(fixture.config, { onNotification: notification => {
    if (notification.method === 'fixture/reader-ready') ready.resolve();
    if (notification.method === 'notifications/tools/list_changed') observed = true;
  } });
  let pending: Promise<unknown> | undefined, handlers: { onNotification: (...args: unknown[]) => void } | undefined;
  let original: ((...args: unknown[]) => void) | undefined;
  try {
    await client.connect(); const retained = client.captureToolCatalog(), http = nativeHttp(client);
    const optionsSlot = Object.getOwnPropertyDescriptor(http, 'options');
    if (!optionsSlot || !('value' in optionsSlot)) throw new Error('Expected original transport options');
    handlers = (optionsSlot.value as { handlers: { onNotification: (...args: unknown[]) => void } }).handlers;
    original = handlers.onNotification; const owner = handlers, callback = original;
    pending = retained.listTools(); void pending.catch(() => undefined); await ready.promise;
    owner.onNotification = () => { invoked += 1; owner.onNotification = callback; };
    fixture.change(); waiting.release.resolve(); await expect(pending).rejects.toThrow();
    expect(invoked).toBe(0); expect(observed).toBe(true); owner.onNotification = callback;
    expect(() => retained.assertCurrent()).toThrow();
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native generation 2.' }]);
    expect(fixture.lists).toBe(2); expect(fixture.calls).toBe(0);
  } finally { waiting.release.resolve(); if (handlers && original) handlers.onNotification = original; await closeClient(client, fixture, pending ? [pending] : []); }
});

test('a pending HTTP notification invokes the original native client invalidator', async () => {
  const fixture = serverFixture(), waiting = fixture.blockNextStream(), ready = gate(); let observed = false, invoked = 0;
  const client = new McpClient(fixture.config, { onNotification: notification => {
    if (notification.method === 'fixture/reader-ready') ready.resolve();
    if (notification.method === 'notifications/tools/list_changed') observed = true;
  } });
  let pending: Promise<unknown> | undefined;
  try {
    await client.connect(); const retained = client.captureToolCatalog();
    pending = retained.listTools(); void pending.catch(() => undefined); await ready.promise;
    Object.defineProperty(client, '_handleNotification', { configurable: true, value: () => {
      invoked += 1; Reflect.deleteProperty(client, '_handleNotification');
    } });
    fixture.change(); waiting.release.resolve(); await expect(pending).rejects.toThrow();
    expect(invoked).toBe(0); expect(observed).toBe(true); Reflect.deleteProperty(client, '_handleNotification');
    expect(() => retained.assertCurrent()).toThrow();
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native generation 2.' }]);
    expect(fixture.lists).toBe(2); expect(fixture.calls).toBe(0);
  } finally { waiting.release.resolve(); Reflect.deleteProperty(client, '_handleNotification'); await closeClient(client, fixture, pending ? [pending] : []); }
});

test.each(['_processBuffer', '_dispatchLine', '_handleResponse', '_handleNotification'] as const)('a pending stdio read cannot execute a self-restoring %s substitute', async key => {
  const ready = gate(); let observed = false, invoked = 0;
  const program = `let input = ''; let pending; let generation = 1; let held = false;
const emit = message => process.stdout.write(JSON.stringify(message) + '\\n');
process.stdin.on('data', chunk => {
  input += chunk.toString(); let end;
  while ((end = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, end); input = input.slice(end + 1); if (!line.trim()) continue;
    const body = JSON.parse(line);
    if (body.method === 'fixture/release') {
      if (pending) {
        generation = 2; emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        emit({ jsonrpc: '2.0', id: pending.id, result: { tools: [{ name: 'observe', description: 'Native stdio generation 1.' }] } }); pending = undefined;
      }
      continue;
    }
    if (body.id === undefined) continue;
    if (body.method === 'tools/list' && !held) {
      held = true; pending = body; emit({ jsonrpc: '2.0', method: 'fixture/reader-ready' }); continue;
    }
    const result = body.method === 'server/discover'
      ? { supportedProtocolVersions: ['${MCP_STATELESS_REVISION}'], capabilities: { tools: { listChanged: true } } }
      : body.method === 'tools/list' ? { tools: [{ name: 'observe', description: 'Native stdio generation ' + generation + '.' }] } : {};
    emit({ jsonrpc: '2.0', id: body.id, result });
  }
});`;
  const client = new McpClient({ name: 'native-deferred-stdio', command: process.execPath, args: ['-e', program] }, { onNotification: notification => {
    if (notification.method === 'fixture/reader-ready') ready.resolve();
    if (notification.method === 'notifications/tools/list_changed') observed = true;
  } });
  let pending: Promise<unknown> | undefined, release: (() => void) | undefined;
  try {
    await client.connect(); const retained = client.captureToolCatalog();
    const procSlot = Object.getOwnPropertyDescriptor(client, 'proc');
    if (!procSlot || !('value' in procSlot) || !procSlot.value) throw new Error('Expected actual native stdio process');
    const proc = procSlot.value as { stdin: { write: (text: string) => unknown } };
    release = () => { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'fixture/release' }) + '\n'); };
    pending = retained.listTools(); void pending.catch(() => undefined); await ready.promise;
    const originalSlot = Object.getOwnPropertyDescriptor(McpClient.prototype, key);
    if (!originalSlot || typeof originalSlot.value !== 'function') throw new Error('Expected native byte dispatch');
    const original = originalSlot.value;
    Object.defineProperty(client, key, { configurable: true, value: (...args: unknown[]) => {
      invoked += 1; Reflect.deleteProperty(client, key);
      return key === '_handleNotification' ? undefined : Reflect.apply(original, client, args);
    } });
    release(); await expect(pending).rejects.toThrow(); expect(invoked).toBe(0); expect(observed).toBe(true);
    Reflect.deleteProperty(client, key); expect(() => retained.assertCurrent()).toThrow();
    expect(await client.listTools()).toEqual([{ name: 'observe', description: 'Native stdio generation 2.' }]);
  } finally {
    try { release?.(); } finally { Reflect.deleteProperty(client, key); await client.disconnect(); await Promise.allSettled(pending ? [pending] : []); }
  }
});


test('legacy fixture accepts native session termination and refuses unrelated HTTP requests', async () => {
  const legacy = serverFixture(true), modern = serverFixture(), client = new McpClient(legacy.config);
  const url = legacy.config.url!;
  try {
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(400);
    expect((await fetch(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': 'unknown-session' } })).status).toBe(400);
    expect((await fetch(new URL('/unknown', url), { method: 'DELETE', headers: { 'Mcp-Session-Id': 'native-session' } })).status).toBe(400);
    expect((await fetch(modern.config.url!, { method: 'DELETE', headers: { 'Mcp-Session-Id': 'native-session' } })).status).toBe(400);
    expect((await fetch(url, { method: 'GET' })).status).toBe(405);
    expect((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
    expect(legacy.deletes).toBe(0); expect(modern.deletes).toBe(0);
    await client.connect(); expect(client.protocolInfo?.era).toBe('legacy');
    await client.disconnect(); expect(legacy.deletes).toBe(1);
    expect(legacy.lists).toBe(0); expect(legacy.calls).toBe(0);
  } finally { await client.disconnect(); legacy.server.stop(true); modern.server.stop(true); }
});
