import { beforeEach, describe, expect, test } from 'bun:test';
import { createToolRegistryDouble } from '../helpers/tool-registry-double.ts';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerAgentBrowserTool } from '../../tools/agent-browser-tool.ts';
import { browserControlPosture } from '../../tools/agent-harness-browser-control.ts';
import { installAgentMcpCallRoute, resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { resetToolCapabilityDeclarationsForTests } from '../../tools/agent-tool-capability-declarations.ts';

/**
 * The rule this file enforces: a capability may not report itself ready unless
 * a route exists that can actually be invoked.
 *
 * The failure it exists to prevent is a real one. This posture used to report
 * status "ready" whenever a browser-shaped MCP server was connected, and told
 * the model to "invoke the narrowest live-control tool", while no tool mode
 * could invoke anything on an MCP server at all. The model spent a session
 * hunting for a route that did not exist.
 */

interface ServerRecord {
  readonly name: string;
  readonly connected: boolean;
  readonly trustMode: string;
  readonly role: string;
  readonly schemaFreshness: string;
  readonly allowedHosts: readonly string[];
}

function mcpTool(): Tool {
  return {
    definition: {
      name: 'mcp',
      description: 'Inspect MCP servers.',
      parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['servers'] } }, required: ['mode'], additionalProperties: false },
    },
    execute: async () => ({ success: true, output: '{}' }),
  };
}

function createContext(registry: ToolRegistry, servers: readonly ServerRecord[], callTool?: () => Promise<unknown>): CommandContext {
  return {
    platform: { readModels: {} },
    extensions: { toolRegistry: registry },
    clients: {
      mcpApi: {
        listServerSecurity: () => servers,
        ...(callTool ? { callTool } : {}),
      },
    },
  } as unknown as CommandContext;
}

const BROWSER_MCP_SERVER: ServerRecord = {
  name: 'playwright-browser',
  connected: true,
  trustMode: 'constrained',
  role: 'browser',
  schemaFreshness: 'fresh',
  allowedHosts: [],
};

describe('browser capability honesty', () => {
  beforeEach(() => {
    resetAgentMcpCallRouteForTests();
    resetToolCapabilityDeclarationsForTests();
  });

  test('a ready capability always has at least one invocable route', () => {
    const registry = createToolRegistryDouble();
    registerAgentBrowserTool(registry);
    const posture = browserControlPosture(createContext(registry, []));

    expect(posture.status).toBe('ready');
    expect(posture.invocationRoutes.length).toBeGreaterThan(0);
  });

  test('every route a ready capability names belongs to a registered tool', () => {
    const registry = createToolRegistryDouble();
    registerAgentBrowserTool(registry);
    registry.register(mcpTool());
    installAgentMcpCallRoute(registry, createContext(registry, [BROWSER_MCP_SERVER], async () => 'ok'));

    const posture = browserControlPosture(createContext(registry, [BROWSER_MCP_SERVER], async () => 'ok'));

    expect(posture.status).toBe('ready');
    for (const route of posture.invocationRoutes) {
      expect(registry.has(route.toolName)).toBe(true);
      expect(route.modelRoute.startsWith(route.toolName)).toBe(true);
    }
  });

  test('a connected browser MCP server alone is NOT reported ready when nothing can call it', () => {
    // This is the exact state that produced the false "ready": a browser MCP
    // server connected and fresh, with no invocation path in the session.
    const registry = createToolRegistryDouble();
    registry.register(mcpTool());

    const posture = browserControlPosture(createContext(registry, [BROWSER_MCP_SERVER]));

    expect(posture.invocationRoutes).toHaveLength(0);
    expect(posture.status).not.toBe('ready');
    expect(posture.configured).toBe(false);
  });

  test('the same MCP server becomes a real route once calling is wired', () => {
    const registry = createToolRegistryDouble();
    registry.register(mcpTool());
    installAgentMcpCallRoute(registry, createContext(registry, [BROWSER_MCP_SERVER], async () => 'ok'));

    const posture = browserControlPosture(createContext(registry, [BROWSER_MCP_SERVER], async () => 'ok'));

    expect(posture.status).toBe('ready');
    expect(posture.invocationRoutes.map((route) => route.kind)).toContain('mcp-tool-call');
  });

  test('when nothing is invocable the blockers name the situation and the fix', () => {
    const registry = createToolRegistryDouble();
    const posture = browserControlPosture(createContext(registry, []));

    expect(posture.status).not.toBe('ready');
    expect(posture.blockers.length).toBeGreaterThan(0);
    expect(posture.blockers.join(' ')).toContain('Fix:');
  });

  test('a tool that merely mentions browsing provides nothing', () => {
    const registry = createToolRegistryDouble();
    registry.register({
      definition: {
        name: 'research',
        description: 'Plan browser-backed research runs.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      execute: async () => ({ success: true, output: '{}' }),
    });

    const posture = browserControlPosture(createContext(registry, []));

    expect(posture.declaredControlTools).toEqual([]);
    expect(posture.status).not.toBe('ready');
  });

  test('rewording an unrelated tool to mention a browser changes no posture', () => {
    // The real incident: the terminal tool's description was reworded to use a
    // browser as an example of a long-lived process, and the description scan
    // promoted terminal to a browser-control provider, flipping readiness
    // across every surface that reads this posture.
    const registry = createToolRegistryDouble();
    const before = browserControlPosture(createContext(registry, []));

    registry.register({
      definition: {
        name: 'terminal',
        description: 'Run a long-lived process in the background, such as a dev server, a desktop app, or a browser.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      execute: async () => ({ success: true, output: '{}' }),
    });
    const after = browserControlPosture(createContext(registry, []));

    expect(after.status).toBe(before.status);
    expect(after.declaredControlTools).toEqual(before.declaredControlTools);
    expect(after.invocationRoutes).toEqual(before.invocationRoutes);
    expect(after.status).not.toBe('ready');
  });

  test('a tool named like a browser tool but declaring nothing provides nothing', () => {
    const registry = createToolRegistryDouble();
    registry.register({
      definition: {
        name: 'browser_screenshot',
        description: 'Takes screenshots.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      execute: async () => ({ success: true, output: '{}' }),
    });

    const posture = browserControlPosture(createContext(registry, []));

    expect(posture.declaredControlTools).toEqual([]);
    expect(posture.status).not.toBe('ready');
  });

  test('an MCP server is judged by its declared role, not by its name', () => {
    const registry = createToolRegistryDouble();
    registry.register(mcpTool());
    const namedLikeABrowser = {
      name: 'browser-bookmarks-notes',
      connected: true,
      trustMode: 'constrained',
      role: 'general',
      schemaFreshness: 'fresh',
      allowedHosts: [],
    } as const;
    installAgentMcpCallRoute(registry, createContext(registry, [namedLikeABrowser], async () => 'ok'));

    const posture = browserControlPosture(createContext(registry, [namedLikeABrowser], async () => 'ok'));

    expect(posture.mcpServers).toEqual([]);
    expect(posture.status).not.toBe('ready');
  });

  test('a declared provider that is not registered does not count', () => {
    // Declaration alone is not enough: the tool has to actually be there.
    const registry = createToolRegistryDouble();
    registerAgentBrowserTool(createToolRegistryDouble());

    const posture = browserControlPosture(createContext(registry, []));

    expect(posture.declaredControlTools).toEqual([]);
    expect(posture.status).not.toBe('ready');
  });

  test('the recommended next step names a route that can be called now', () => {
    const registry = createToolRegistryDouble();
    registerAgentBrowserTool(registry);
    const posture = browserControlPosture(createContext(registry, []));

    expect(posture.recommendedRoute).toBe(posture.invocationRoutes[0]?.modelRoute);
    expect(posture.recommendedRoute.startsWith('browser ')).toBe(true);
  });
});
