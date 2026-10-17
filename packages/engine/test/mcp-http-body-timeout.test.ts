import { expect, test } from 'bun:test';
import { McpHttpConnection } from '../sdk/src/platform/mcp/http-connection.js';

test.each(['json', 'sse', 'error'])('explicit MCP timeout covers a stalled %s body after headers', async kind => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json() as { id: number; method: string };
    if (body.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: body.id, result: { supportedVersions: ['2026-07-28'] } });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(kind === 'sse' ? ': pending\n\n' : '{'));
    } }), { status: kind === 'error' ? 500 : 200, headers: { 'Content-Type': kind === 'sse' ? 'text/event-stream' : 'application/json' } });
  } });
  const connection = new McpHttpConnection({ serverName: 'body-stall', url: `http://127.0.0.1:${server.port}`,
    clientInfo: { name: 'test', version: '1' }, clientCapabilities: {}, timeoutMs: 50 });
  try {
    await connection.negotiate();
    await expect(connection.request('tools/list', {})).rejects.toThrow('timed out');
  } finally { await connection.close(); await server.stop(true); }
});
