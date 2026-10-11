import { afterEach, expect, spyOn, test } from 'bun:test';
import { McpClient } from '../sdk/src/platform/mcp/client.js';
import { McpRegistry } from '../sdk/src/platform/mcp/registry.js';
import { createMcpApi } from '../sdk/src/platform/mcp/mcp-api.js';
import { SandboxSessionRegistry } from '../sdk/src/platform/runtime/sandbox/session-registry.js';
import { MCP_STATELESS_REVISION } from '../sdk/src/platform/mcp/protocol.js';
import { useGateReadings, READ_ONLY } from './_helpers/gate-readings.ts';

useGateReadings([['synthetic', READ_ONLY]]);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function loopback() {
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('method' in body) || !('id' in body)) return new Response(null, { status: 400 });
    const result = body.method === 'server/discover' ? { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'synthetic', description: 'Synthetic loopback-only fixture.',
        inputSchema: { type: 'object', additionalProperties: true }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] }
      : body.method === 'tools/call' ? (calls.push('tools/call'), { content: [{ type: 'text', text: 'loopback-result' }] }) : {};
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  let onHook: (() => void) | undefined;
  const registry = new McpRegistry({ sandboxSessions: new SandboxSessionRegistry('/synthetic/mcp-currentness'),
    hookDispatcher: { async fire(event) { if (event.path === 'Pre:mcp:call') onHook?.(); return { ok: true }; } } });
  cleanup.push(async () => { try { await registry.disconnectAll(); } finally { server.stop(true); } });
  return { registry, calls, api: createMcpApi(registry), url: `http://127.0.0.1:${server.port}/mcp`, onHook(callback: () => void) { onHook = callback; } };
}

test('real MCP API carries exact caller currentness through to the loopback transport', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  let checks = 0; const options = { assertCurrent() { checks++; } };
  const schema = await f.api.getToolSchema?.('mcp:synthetic:synthetic', options);
  expect(schema?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const result = await f.api.callTool?.('mcp:synthetic:synthetic', {}, options);
  expect(result).toEqual({ content: [{ type: 'text', text: 'loopback-result' }] }); expect(f.calls).toEqual(['tools/call']); expect(checks).toBeGreaterThan(3);
});

test.each(['revoked', 'cancelled', 'options-changed', 'schema-changed'] as const)('real MCP pre-call async boundary refuses %s before transport write', async failure => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  const schema = await f.api.getToolSchema?.('mcp:synthetic:synthetic');
  let current = true; const controller = new AbortController();
  const options = { signal: controller.signal, assertCurrent() { if (!current) throw new Error('Synthetic caller retired'); } };
  f.onHook(() => {
    if (failure === 'revoked') current = false;
    if (failure === 'cancelled') controller.abort();
    if (failure === 'options-changed') options.assertCurrent = () => {};
    if (failure === 'schema-changed' && schema) schema.inputSchema.additionalProperties = false;
  });

  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, options)).rejects.toThrow(); expect(f.calls).toEqual([]);
});

test('async caller currentness is refused before real MCP schema or tool traffic', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  const options = { async assertCurrent() {} };
  await expect(f.api.getToolSchema?.('mcp:synthetic:synthetic', options)).rejects.toThrow('synchronous');
  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, options)).rejects.toThrow('synchronous'); expect(f.calls).toEqual([]);
});

test('accessor-backed caller restrictions are refused without executing their accessor', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  let invoked = 0;
  const options = { get assertCurrent() { invoked++; return () => {}; } };
  await expect(f.api.getToolSchema?.('mcp:synthetic:synthetic', options)).rejects.toThrow('data properties');
  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, options)).rejects.toThrow('data properties');
  expect(invoked).toBe(0); expect(f.calls).toEqual([]);
});

test('promise-returning ordinary caller restrictions are owned and rejected before transport', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  const options = { assertCurrent() { return Promise.reject(new Error('Synthetic invalid asynchronous guard')); } };
  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, options)).rejects.toThrow('synchronous');
  await Promise.resolve(); expect(f.calls).toEqual([]);
});

test('proxy caller callbacks are rejected without invoking their call trap', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  let traps = 0;
  const options = { assertCurrent: new Proxy(() => {}, { apply() { traps++; } }) };
  await expect(f.api.getToolSchema?.('mcp:synthetic:synthetic', options)).rejects.toThrow('synchronous');
  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, options)).rejects.toThrow('synchronous');
  expect(traps).toBe(0); expect(f.calls).toEqual([]);
});

test('replacement of the actual native MCP call port during its pre-call await is refused before invocation', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  let restore: (() => void) | undefined; let replacementCalls = 0;
  f.onHook(() => {
    const replacement = spyOn(McpClient.prototype, 'callTool').mockImplementation(async () => { replacementCalls++; return 'replacement'; });
    restore = () => replacement.mockRestore();
  });
  try {
    await expect(f.api.callTool?.('mcp:synthetic:synthetic', {})).rejects.toThrow('method changed');
    expect(replacementCalls).toBe(0); expect(f.calls).toEqual([]);
  } finally { restore?.(); }
});

test('a native schema cache refresh cannot replace the caller-selected schema before dispatch', async () => {
  const f = loopback(); await f.registry.connectServer({ name: 'synthetic', url: f.url, trustMode: 'allow-all' });
  const selected = await f.api.getToolSchema?.('mcp:synthetic:synthetic');
  expect(selected).not.toBeNull();
  // A new full tools/list response replaces cached objects even when bytes match.
  await f.api.getToolSchema?.('mcp:synthetic:uncached');
  const refreshed = await f.api.getToolSchema?.('mcp:synthetic:synthetic');
  expect(refreshed).not.toBe(selected); expect(refreshed).toEqual(selected);
  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, { expectedSchema: selected ?? undefined })).rejects.toThrow('selected schema changed');
  expect(f.calls).toEqual([]);
  await expect(f.api.callTool?.('mcp:synthetic:synthetic', {}, { expectedSchema: refreshed ?? undefined })).resolves.toEqual({ content: [{ type: 'text', text: 'loopback-result' }] });
  expect(f.calls).toEqual(['tools/call']);
});
