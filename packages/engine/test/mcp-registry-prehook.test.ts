import { describe, expect, test } from 'bun:test';
import { McpRegistry } from '../sdk/src/platform/mcp/registry.js';
import { useGateReadings } from './_helpers/gate-readings.ts';

describe('McpRegistry pre-call hooks', () => {
  // The MCP permission check reads each call's capability through Jev; a fake
  // port answers so no test calls the live API.
  useGateReadings();
  test('blocks tool execution when a pre-call hook returns ok false', async () => {
    const registry = new McpRegistry({
      hookDispatcher: {
        fire: async () => ({ ok: false, error: 'policy rejected call' }),
      },
      sandboxSessions: {
        start: () => 'sandbox-1',
        stop: () => {},
      } as never,
    });
    let called = false;
    (registry as unknown as {
      permissions: { registerServer: (name: string, trustLevel: 'trusted') => void };
    }).permissions.registerServer('server', 'trusted');
    (registry as unknown as { clients: Map<string, unknown> }).clients.set('server', {
      isConnected: true,
      captureToolScope: () => ({ connectionId: 'test', destination: 'test', signal: new AbortController().signal, assertCurrent() {} }),
      callTool: async () => {
        called = true;
        return { ok: true };
      },
    });

    await expect(registry.callTool('mcp:server:write_file', {})).rejects.toThrow('pre-call hook failed');
    expect(called).toBe(false);
  });
});
