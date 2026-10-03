import { beforeEach, describe, expect, test } from 'bun:test';
import { createToolRegistryDouble } from '../helpers/tool-registry-double.ts';
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../../input/command-registry.ts';
import {
  installAgentMcpCallRoute,
  isAgentMcpCallRouteInstalled,
  resetAgentMcpCallRouteForTests,
} from '../../tools/agent-mcp-call-route.ts';

interface ServerRecord {
  readonly name: string;
  readonly connected: boolean;
  readonly trustMode: string;
  readonly role: string;
  readonly schemaFreshness: string;
  readonly allowedHosts: readonly string[];
}

function fakeMcpTool(): Tool {
  return {
    definition: {
      name: 'mcp',
      description: 'Inspect MCP servers, tools, schemas, and trust state.',
      parameters: {
        type: 'object',
        properties: { mode: { type: 'string', enum: ['servers', 'tools', 'schema'] }, qualifiedName: { type: 'string' } },
        required: ['mode'],
        additionalProperties: false,
      },
    },
    execute: async (args) => ({ success: true, output: JSON.stringify({ passthrough: args.mode }) }),
  };
}

function createContext(options: {
  readonly servers?: readonly ServerRecord[];
  readonly callTool?: (qualifiedName: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
}): CommandContext {
  const servers = options.servers ?? [
    { name: 'browserpilot', connected: true, trustMode: 'constrained', role: 'browser', schemaFreshness: 'fresh', allowedHosts: [] },
  ];
  const api = {
    listServerSecurity: () => servers,
    ...(options.callTool ? { callTool: options.callTool } : {}),
  };
  return { clients: { mcpApi: api } } as unknown as CommandContext;
}

function registryWithMcp(): { registry: ToolRegistry; tool: Tool } {
  const registry = createToolRegistryDouble();
  const tool = fakeMcpTool();
  registry.register(tool);
  return { registry, tool };
}

describe('mcp call route', () => {
  beforeEach(() => {
    resetAgentMcpCallRouteForTests();
  });

  test('is not installed when the runtime publishes no tool caller', () => {
    const { registry } = registryWithMcp();
    const installed = installAgentMcpCallRoute(registry, createContext({}));
    expect(installed).toBe(false);
    expect(isAgentMcpCallRouteInstalled()).toBe(false);
  });

  test('does not advertise a call mode it cannot serve', () => {
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({}));
    const mode = (tool.definition.parameters.properties as Record<string, { enum?: string[] }>).mode;
    expect(mode?.enum).not.toContain('call');
  });

  test('advertises the call mode once it is wired', () => {
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({ callTool: async () => ({ ok: true }) }));
    const properties = tool.definition.parameters.properties as Record<string, { enum?: string[] }>;
    expect(properties.mode?.enum).toContain('call');
    expect(properties.input).toBeDefined();
    expect(isAgentMcpCallRouteInstalled()).toBe(true);
  });

  test('invokes the named tool and returns what the server sent back', async () => {
    const invoked: { name?: string; input?: unknown } = {};
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({
      callTool: async (qualifiedName, input) => {
        invoked.name = qualifiedName;
        invoked.input = input;
        return { content: [{ type: 'text', text: 'navigated' }] };
      },
    }));

    const result = await tool.execute({ mode: 'call', qualifiedName: 'mcp:browserpilot:browser_navigate', input: { url: 'https://example.com' } });

    expect(result.success).toBe(true);
    expect(result.output).toContain('navigated');
    expect(invoked.name).toBe('mcp:browserpilot:browser_navigate');
    expect(invoked.input).toEqual({ url: 'https://example.com' });
  });

  test('a browser tool is callable: the old keyword filter would have refused it', async () => {
    const called: string[] = [];
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({
      callTool: async (qualifiedName) => {
        called.push(qualifiedName);
        return 'ok';
      },
    }));

    await tool.execute({ mode: 'call', qualifiedName: 'mcp:browserpilot:browser_click', input: {} });

    expect(called).toEqual(['mcp:browserpilot:browser_click']);
  });

  test('other modes still reach the underlying tool untouched', async () => {
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({ callTool: async () => 'ok' }));
    const result = await tool.execute({ mode: 'servers' });
    expect(result.output).toContain('passthrough');
  });

  test('a blocked server is refused by its trust setting, not by its name', async () => {
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({
      servers: [{ name: 'risky', connected: true, trustMode: 'blocked', role: 'browser', schemaFreshness: 'fresh', allowedHosts: [] }],
      callTool: async () => 'should not be reached',
    }));

    const result = await tool.execute({ mode: 'call', qualifiedName: 'mcp:risky:anything', input: {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('blocked');
  });

  test('a disconnected server is named as disconnected', async () => {
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({
      servers: [{ name: 'offline', connected: false, trustMode: 'constrained', role: 'browser', schemaFreshness: 'fresh', allowedHosts: [] }],
      callTool: async () => 'unreachable',
    }));

    const result = await tool.execute({ mode: 'call', qualifiedName: 'mcp:offline:tool', input: {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not connected');
  });

  test('an unknown server lists the ones that exist', async () => {
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({ callTool: async () => 'ok' }));
    const result = await tool.execute({ mode: 'call', qualifiedName: 'mcp:ghost:tool', input: {} });
    expect(result.error).toContain('browserpilot');
  });

  test('a malformed tool name explains the expected form', async () => {
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({ callTool: async () => 'ok' }));
    const result = await tool.execute({ mode: 'call', qualifiedName: 'browser_navigate', input: {} });
    expect(result.error).toContain('mcp:<server>:<tool>');
  });

  test('a failing server call is reported, not thrown', async () => {
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({
      callTool: async () => {
        throw new Error('MCP call denied: host not allowed');
      },
    }));

    const result = await tool.execute({ mode: 'call', qualifiedName: 'mcp:browserpilot:browser_navigate', input: {} });

    expect(result.success).toBe(false);
    expect(result.error).toContain('host not allowed');
  });

  test('a call with no arguments sends an empty object rather than failing', async () => {
    let received: unknown = null;
    const { registry, tool } = registryWithMcp();
    installAgentMcpCallRoute(registry, createContext({
      callTool: async (_name, input) => {
        received = input;
        return 'ok';
      },
    }));

    await tool.execute({ mode: 'call', qualifiedName: 'mcp:browserpilot:list' });

    expect(received).toEqual({});
  });
});
