import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createToolRegistryDouble } from '../helpers/tool-registry-double.ts';
import { ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../../input/command-registry.ts';
import { registerAgentBrowserTool } from '../../tools/agent-browser-tool.ts';
import { browserControlPosture, browserControlRouteSummary } from '../../tools/agent-harness-browser-control.ts';
import { installAgentMcpCallRoute, resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { resetToolCapabilityDeclarationsForTests } from '../../tools/agent-tool-capability-declarations.ts';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { runLocalModelServerSmoke } from '../../tools/agent-harness-local-model-smoke.ts';
import { localEndpointId } from '../../tools/agent-harness-local-model-endpoints.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previousPort); });
afterAll(cleanupResearchScreeningFixtures);

function catalogReadings(probabilities: Readonly<Record<string, number>>) {
  return fakePort((name, _question, state) => {
    if (name !== 'match' || !state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Unexpected catalog reading.');
    const candidate = state.candidate;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || typeof candidate.name !== 'string') throw new Error('Catalog candidate name missing.');
    return noulAnswer(probabilities[candidate.name] ?? 0.01);
  });
}

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
        ...(callTool ? { callTool, getToolSchema: async (qualifiedName: string) => ({ name: qualifiedName.split(':')[2] ?? '', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }) } : {}),
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

  test('workflow selection reads every candidate and permits a result contrary to the old keyword dispatch', async () => {
    const registry = createToolRegistryDouble(), context = createContext(registry, []);
    const fake = catalogReadings({ 'desktop-control': 0.99 }); installJudgmentPort(fake.port);
    const result = await browserControlRouteSummary(context, registry, { query: 'browser screenshot' }, { sourceOwner: ordinaryResearchOwner() });
    expect(result.workflow).toMatchObject({ id: 'desktop-control' });
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.every(request => request.context?.battery === 'engine.tools.registry-rank')).toBe(true);
  });

  test('workflow selection holds without a reader or on uncertainty, while exact IDs remain literal', async () => {
    const registry = createToolRegistryDouble(), context = createContext(registry, []), options = { sourceOwner: ordinaryResearchOwner() };
    await expect(browserControlRouteSummary(context, registry, { query: 'take screenshot' }, options)).rejects.toBeInstanceOf(JudgmentPortMissingError);
    expect((await browserControlRouteSummary(context, registry, { query: 'screenshot-observation' })).workflow).toMatchObject({ id: 'screenshot-observation' });
    for (const probability of [0.5, 0.58, 0.42]) {
      installJudgmentPort(catalogReadings({ 'screenshot-observation': probability }).port);
      await expect(browserControlRouteSummary(context, registry, { query: 'take screenshot' }, options)).rejects.toBeInstanceOf(ToolInputProjectionError);
    }
    installJudgmentPort(catalogReadings({}).port);
    expect(await browserControlRouteSummary(context, registry, { query: 'take screenshot' }, options)).toMatchObject({ status: 'no-matching-workflow', workflow: null });
  });

  test('a changed browser route cannot publish a pending semantic workflow', async () => {
    const registry = createToolRegistryDouble(), context = createContext(registry, []), fake = catalogReadings({ 'screenshot-observation': 0.99 });
    installJudgmentPort({ ...fake.port, async ask(request) {
      const result = await fake.port.ask(request);
      registerAgentBrowserTool(registry);
      return result;
    } });
    await expect(browserControlRouteSummary(context, registry, { query: 'take screenshot' }, { sourceOwner: ordinaryResearchOwner() })).rejects.toBeInstanceOf(ToolInputProjectionError);
  });

  test('an unreadable installed browser backend is held rather than reported empty', async () => {
    const registry = createToolRegistryDouble(), context = createContext(registry, []);
    Object.defineProperty(registry, 'getToolDefinitions', { configurable: true, value: () => { throw new Error('fixture tool inventory unavailable'); } });
    expect(() => browserControlPosture(context, registry)).toThrow(ToolInputProjectionError);
    await expect(browserControlRouteSummary(context, registry, { query: 'take screenshot' }, { sourceOwner: ordinaryResearchOwner() })).rejects.toBeInstanceOf(ToolInputProjectionError);

    const availableRegistry = createToolRegistryDouble(), unreadableContext = createContext(availableRegistry, []);
    Object.defineProperty(unreadableContext.clients?.mcpApi, 'listServerSecurity', { configurable: true, value: () => { throw new Error('fixture connector inventory unavailable'); } });
    expect(() => browserControlPosture(unreadableContext, availableRegistry)).toThrow(ToolInputProjectionError);
  });

  test('a replaced connector method cannot publish a pending workflow or invoke its accessor', async () => {
    const registry = createToolRegistryDouble(), context = createContext(registry, []), fake = catalogReadings({ 'screenshot-observation': 0.99 });
    let accessorReads = 0;
    installJudgmentPort({ ...fake.port, async ask(request) {
      const answer = await fake.port.ask(request);
      Object.defineProperty(context.clients?.mcpApi, 'listServerSecurity', { configurable: true, get() { accessorReads++; return () => []; } });
      return answer;
    } });
    await expect(browserControlRouteSummary(context, registry, { query: 'take screenshot' }, { sourceOwner: ordinaryResearchOwner() })).rejects.toBeInstanceOf(ToolInputProjectionError);
    expect(accessorReads).toBe(0);
  });

  test('semantic endpoint selection performs one real loopback GET only after settled selection', async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      requests++; expect(new URL(request.url).pathname).toBe('/v1/models');
      return Response.json({ data: [{ id: 'fixture-model-a' }, { id: 'fixture-model-b' }, { id: 'fixture-model-a' }] });
    } });
    const previous = process.env.OLLAMA_BASE_URL;
    const baseUrl = `http://127.0.0.1:${server.port}/v1`; process.env.OLLAMA_BASE_URL = baseUrl;
    const registry = createToolRegistryDouble(), context = createContext(registry, []), options = { sourceOwner: ordinaryResearchOwner() };
    try {
      await expect(runLocalModelServerSmoke(context, { query: 'opaque endpoint request' }, options)).rejects.toBeInstanceOf(JudgmentPortMissingError);
      expect(requests).toBe(0);
      for (const probability of [0.5, 0.58, 0.42]) {
        installJudgmentPort(catalogReadings({ [localEndpointId(baseUrl)]: probability }).port);
        expect(await runLocalModelServerSmoke(context, { query: 'opaque endpoint request' }, options)).toMatchObject({ status: 'reading-held', liveProbe: 'not-run' });
        expect(requests).toBe(0);
      }
      const fake = catalogReadings({ [localEndpointId(baseUrl)]: 0.99 }); installJudgmentPort(fake.port);
      expect(await runLocalModelServerSmoke(context, { query: 'opaque endpoint request' }, options)).toMatchObject({ status: 'ready', endpointCount: 1, endpoints: [{ modelCount: 2, success: true }] });
      expect(requests).toBe(1); expect(fake.requests.length).toBeGreaterThanOrEqual(5);
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previous;
      await server.stop(true);
    }
  });

  test('an endpoint changed during its canonical reading is fenced before HTTP', async () => {
    let requests = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return Response.json({ data: [{ id: 'fixture-model' }] }); } });
    const previous = process.env.OLLAMA_BASE_URL;
    const baseUrl = `http://127.0.0.1:${server.port}/v1`; process.env.OLLAMA_BASE_URL = baseUrl;
    const registry = createToolRegistryDouble(), context = createContext(registry, []), fake = catalogReadings({ [localEndpointId(baseUrl)]: 0.99 });
    installJudgmentPort({ ...fake.port, async ask(request) {
      const answer = await fake.port.ask(request); process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:1/v1'; return answer;
    } });
    try {
      await expect(runLocalModelServerSmoke(context, { query: 'opaque endpoint request' }, { sourceOwner: ordinaryResearchOwner() })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(requests).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previous;
      await server.stop(true);
    }
  });

  test('caller cancellation during the real loopback probe propagates rather than reporting endpoint failure', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
      entered.resolve(); await release.promise; return Response.json({ data: [{ id: 'fixture-model' }] });
    } });
    const previous = process.env.OLLAMA_BASE_URL;
    const baseUrl = `http://127.0.0.1:${server.port}/v1`; process.env.OLLAMA_BASE_URL = baseUrl;
    const registry = createToolRegistryDouble(), context = createContext(registry, []), controller = new AbortController();
    const reason = new Error('fixture caller cancelled');
    try {
      const pending = runLocalModelServerSmoke(context, { target: baseUrl }, { signal: controller.signal });
      await entered.promise; controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
    } finally {
      release.resolve();
      if (previous === undefined) delete process.env.OLLAMA_BASE_URL; else process.env.OLLAMA_BASE_URL = previous;
      await server.stop(true);
    }
  });
});
