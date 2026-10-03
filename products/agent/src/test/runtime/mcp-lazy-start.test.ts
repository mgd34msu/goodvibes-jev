/**
 * mcp-lazy-start.test.ts
 *
 * A bare `goodvibes-agent` boot, no prompt, no tool call, spawned every
 * server in mcp.json, because `scheduleBackgroundMcpDiscovery()` calls
 * `connectAll()` as its first act. On a real machine that put two
 * browser-automation servers into the process tree at startup, one of them
 * configured with a start-url pointing at a cloud console.
 *
 * Nobody ordered browser automation at boot. These tests pin that servers start
 * on first USE and never before it.
 */

import { describe, expect, test } from 'bun:test';
import { createLazyMcpRegistry } from '../../runtime/mcp-lazy-start.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/sdk/platform/mcp';

/** A registry that records whether anything would have been spawned. */
function fakeRegistry(): { registry: McpRegistry; connects: number; calls: string[] } {
  const state = { connects: 0, calls: [] as string[] };
  const registry = {
    connectAll: async (): Promise<void> => { state.connects += 1; },
    listAllTools: async (): Promise<unknown[]> => { state.calls.push('listAllTools'); return []; },
    callTool: async (): Promise<unknown> => { state.calls.push('callTool'); return null; },
    getToolSchema: async (): Promise<unknown> => { state.calls.push('getToolSchema'); return null; },
    // SYNCHRONOUS in the real registry, modelling it as async once hid a
    // defect where gating it returned a promise and broke every caller.
    listServerSecurity: (): unknown[] => { state.calls.push('listServerSecurity'); return []; },
    disconnectAll: async (): Promise<void> => { state.calls.push('disconnectAll'); },
    get serverNames(): string[] { state.calls.push('serverNames'); return ['playwright', 'zen-devtools']; },
  } as unknown as McpRegistry;
  return {
    registry,
    get connects() { return state.connects; },
    get calls() { return state.calls; },
  } as { registry: McpRegistry; connects: number; calls: string[] };
}

const ROOTS = {} as Parameters<McpRegistry['connectAll']>[0];

describe('MCP servers do not start at boot', () => {
  test('wrapping the registry starts nothing', () => {
    const fake = fakeRegistry();
    createLazyMcpRegistry(fake.registry, ROOTS);
    // This is the boot: the agent composed its services and did nothing else.
    expect(fake.connects).toBe(0);
  });

  test('asking what is configured does not spawn anything', () => {
    // `serverNames` is what the suggestion scan reads two seconds into a boot.
    // If it connected, the fix would be undone by its own diagnostics.
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    expect(lazy.registry.serverNames).toEqual(['playwright', 'zen-devtools']);
    expect(fake.connects).toBe(0);
    expect(lazy.isConnected()).toBe(false);
  });
});

describe('MCP servers start on first use', () => {
  test('calling a tool connects first, then calls', async () => {
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    expect(fake.connects).toBe(0);

    await lazy.registry.callTool('playwright.navigate', {});

    expect(fake.connects).toBe(1);
    expect(lazy.isConnected()).toBe(true);
    // Connect happened BEFORE the call, or the call would have hit no server.
    expect(fake.calls).toContain('callTool');
  });

  test('every method that needs a live server triggers the start', async () => {
    for (const use of [
      (r: McpRegistry) => r.listAllTools(),
      (r: McpRegistry) => r.getToolSchema('x.y'),
      (r: McpRegistry) => r.callTool('x.y', {}),
    ]) {
      const fake = fakeRegistry();
      const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
      await use(lazy.registry);
      expect(fake.connects).toBe(1);
    }
  });

  test('synchronous registry methods stay synchronous', () => {
    // Gating a sync method turns it into a promise. `listServerSecurity()`
    // returns an array that callers immediately `.filter()`, wrapping it threw
    // "workspaceMcpServers(context).filter is not a function" and took the
    // whole TUI down at launch.
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    const security = lazy.registry.listServerSecurity();
    expect(Array.isArray(security)).toBe(true);
    // …and it starts nothing, so it is honest about there being no servers yet.
    expect(fake.connects).toBe(0);
  });

  test('concurrent first uses start the servers once, not once each', async () => {
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    await Promise.all([
      lazy.registry.listAllTools(),
      lazy.registry.callTool('a.b', {}),
      lazy.registry.getToolSchema('a.b'),
    ]);
    expect(fake.connects).toBe(1);
  });

  test('a later use after the first does not reconnect', async () => {
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    await lazy.registry.listAllTools();
    await lazy.registry.listAllTools();
    expect(fake.connects).toBe(1);
  });

  test('the first-connect hook runs once, after the connect', async () => {
    const fake = fakeRegistry();
    let hooks = 0;
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS, {
      onFirstConnect: () => { hooks += 1; },
    });
    await lazy.registry.listAllTools();
    await lazy.registry.listAllTools();
    expect(hooks).toBe(1);
  });

  test('a failed connect does not permanently poison later attempts', async () => {
    let attempts = 0;
    const registry = {
      connectAll: async (): Promise<void> => {
        attempts += 1;
        if (attempts === 1) throw new Error('server not installed');
      },
      listAllTools: async (): Promise<unknown[]> => [],
    } as unknown as McpRegistry;
    const lazy = createLazyMcpRegistry(registry, ROOTS);
    await lazy.registry.listAllTools();
    expect(lazy.isConnected()).toBe(false);
    // A server installed since the first try must be reachable.
    await lazy.registry.listAllTools();
    expect(attempts).toBe(2);
    expect(lazy.isConnected()).toBe(true);
  });
});
