import { expect, test } from 'bun:test';
import { McpRegistry } from '../sdk/src/platform/mcp/registry.js';
import { SandboxSessionRegistry } from '../sdk/src/platform/runtime/sandbox/session-registry.js';
import { MCP_STATELESS_REVISION } from '../sdk/src/platform/mcp/protocol.js';
import { useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings();
test('McpRegistry blocks real loopback tool transport when its pre-call hook returns ok false', async () => {
  let called = false;
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || !('method' in body) || !('id' in body)) return new Response(null, { status: 400 });
    const result = body.method === 'server/discover' ? { supportedProtocolVersions: [MCP_STATELESS_REVISION], capabilities: { tools: {} } }
      : body.method === 'tools/list' ? { tools: [{ name: 'write_file', description: 'Synthetic intercepted write.', inputSchema: { type: 'object' } }] }
      : body.method === 'tools/call' ? (called = true, { ok: true }) : {};
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const registry = new McpRegistry({ hookDispatcher: { fire: async () => ({ ok: false, error: 'policy rejected call' }) },
    sandboxSessions: new SandboxSessionRegistry('/synthetic/mcp-prehook') });
  try {
    await registry.connectServer({ name: 'server', url: `http://127.0.0.1:${server.port}/mcp`, trustMode: 'allow-all' });
    await expect(registry.callTool('mcp:server:write_file', {})).rejects.toThrow('pre-call hook failed'); expect(called).toBe(false);
  } finally { await registry.disconnectAll(); server.stop(true); }
});
