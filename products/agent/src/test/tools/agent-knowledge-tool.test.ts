import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import type { ShellPathService } from '@/runtime/index.ts';
import {
  createAgentKnowledgeTool,
  registerAgentKnowledgeTool,
} from '../../tools/agent-knowledge-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

function shellPaths(withToken = true): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-knowledge-tool');
  if (withToken) {
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'agent-knowledge-tool-token' }));
  }
  return createShellPathService({ workingDirectory: root, homeDirectory: root });
}

function configManager(paths: ShellPaths): ConfigManager {
  return new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function statusResponse(): Response {
  return new Response(JSON.stringify({
    ready: true,
    sourceCount: 0,
    nodeCount: 0,
    edgeCount: 0,
    issueCount: 0,
    storagePath: 'knowledge-agent.sqlite',
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function askResponse(): Response {
  return new Response(JSON.stringify({
    query: 'What is GoodVibes Agent?',
    answer: {
      text: 'No Agent-owned knowledge has been ingested yet.',
      mode: 'standard',
      confidence: 0,
      synthesized: false,
      sources: [],
      facts: [],
      linkedObjects: [],
      gaps: [],
    },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function searchResponse(): Response {
  return new Response(JSON.stringify({
    query: 'GoodVibes Agent',
    results: [],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('agent_knowledge tool', () => {
  test('status uses only the isolated Agent Knowledge status route', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return statusResponse();
    });

    try {
      const result = await tool.execute({ action: 'status' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Agent Knowledge status');
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/status',
      ]);
      expect(requests.map((request) => request.url.includes('/api/knowledge'))).toEqual([false]);
      expect(requests.map((request) => request.url.includes('homeGraph'))).toEqual([false]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ask uses only the isolated Agent Knowledge ask route', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return askResponse();
    });

    try {
      const result = await tool.execute({
        action: 'ask',
        query: 'What is GoodVibes Agent?',
        mode: 'standard',
        limit: 4,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('No Agent-owned knowledge has been ingested yet.');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ask');
      expect(requests[0]?.url).not.toContain('/api/knowledge');
      expect(requests[0]?.url).not.toContain('homeGraph');
      expect(requests[0]?.method).toBe('POST');
      expect(requests[0]?.body).toContain('"query":"What is GoodVibes Agent?"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('search uses only the isolated Agent Knowledge search route', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return searchResponse();
    });

    try {
      const result = await tool.execute({
        action: 'search',
        query: 'GoodVibes Agent',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Agent Knowledge search');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/search');
      expect(requests[0]?.url).not.toContain('/api/knowledge');
      expect(requests[0]?.url).not.toContain('homeGraph');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('normalizes default scope aliases returned by isolated Agent Knowledge routes', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return jsonResponse({
        ok: true,
        knowledgeSpaceId: 'default',
        sources: [{ id: 'src-default', title: 'Default source' }],
      });
    });

    try {
      const result = await tool.execute({ action: 'sources', limit: 2 });

      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      expect(result.output).toContain('Agent Knowledge sources');
      expect(result.output).toContain('Default source');
      expect(result.output).not.toContain('scope_contamination');
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/sources?limit=2',
      ]);
      expect(requests.map((request) => request.url.includes('/api/knowledge/'))).toEqual([false]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('expanded read actions use only isolated Agent Knowledge routes', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const path = new URL(url).pathname;
      if (path.endsWith('/sources')) {
        return jsonResponse({
          sources: [{ id: 'src-alpha', title: 'Agent source', sourceType: 'url', canonicalUri: 'https://example.test/source' }],
        });
      }
      if (path.endsWith('/nodes')) {
        return jsonResponse({
          nodes: [{ id: 'node-alpha', title: 'Agent node', kind: 'fact', confidence: 0.9 }],
        });
      }
      if (path.endsWith('/issues')) {
        return jsonResponse({
          issues: [{ id: 'issue-alpha', severity: 'low', code: 'review', status: 'open', message: 'Needs review.' }],
        });
      }
      if (path.endsWith('/items/src-alpha')) {
        return jsonResponse({
          source: { id: 'src-alpha', title: 'Agent source', sourceType: 'url' },
          relatedEdges: [{}],
          linkedSources: [],
          linkedNodes: [{}],
        });
      }
      if (path.endsWith('/map')) {
        return jsonResponse({
          sources: [{ id: 'src-alpha' }],
          nodes: [{ id: 'node-alpha' }],
          edges: [{ from: 'src-alpha', to: 'node-alpha' }],
          issues: [],
        });
      }
      if (path.endsWith('/connectors/url/doctor')) {
        return jsonResponse({ connectorId: 'url', ready: true, summary: 'Connector ready.', checks: [], hints: [] });
      }
      if (path.endsWith('/connectors/url')) {
        return jsonResponse({
          connector: { id: 'url', displayName: 'URL connector', sourceType: 'url', capabilities: ['ingest'], examples: [] },
        });
      }
      if (path.endsWith('/connectors')) {
        return jsonResponse({
          connectors: [{ id: 'url', displayName: 'URL connector', sourceType: 'url', description: 'Import web pages.' }],
        });
      }
      return new Response('not found', { status: 404 });
    });

    try {
      const sources = await tool.execute({ action: 'sources', limit: 2 });
      const nodes = await tool.execute({ action: 'nodes', limit: 3 });
      const issues = await tool.execute({ action: 'issues', limit: 4 });
      const item = await tool.execute({ action: 'item', id: 'src-alpha' });
      const map = await tool.execute({ action: 'map', query: 'agent', limit: 4 });
      const connectors = await tool.execute({ action: 'connectors' });
      const connector = await tool.execute({ action: 'connector', connectorId: 'url' });
      const doctor = await tool.execute({ action: 'connector_doctor', id: 'url' });

      for (const result of [sources, nodes, issues, item, map, connectors, connector, doctor]) {
        expect(result.success).toBe(true);
        if (!result.success) throw new Error(result.error);
        expect(result.output).toContain('/api/goodvibes-agent/knowledge/');
      }
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/sources?limit=2',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/nodes?limit=3',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/issues?limit=4',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/items/src-alpha',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/map?limit=4&query=agent',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/connectors',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/connectors/url',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/connectors/url/doctor',
      ]);
      expect(requests.map((request) => request.method)).toEqual([
        'GET',
        'GET',
        'GET',
        'GET',
        'GET',
        'GET',
        'GET',
        'GET',
      ]);
      expect(requests.map((request) => request.url.includes('/api/knowledge'))).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(requests.map((request) => request.url.includes('homeGraph'))).toEqual([
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails closed without token and does not call default knowledge routes', async () => {
    const paths = shellPaths(false);
    const tool = createAgentKnowledgeTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return statusResponse();
    });

    try {
      const result = await tool.execute({ action: 'ask', query: 'What is GoodVibes Agent?' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('auth_required');
      expect(result.error).toContain('No connected-host operator token found');
      expect(result.error).toContain('/api/goodvibes-agent/knowledge/*');
      expect(result.error).not.toContain('/api/knowledge');
      expect(result.error).not.toContain('runtime operator token');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('is registered in the model tool registry', () => {
    const paths = shellPaths();
    const registry = new ToolRegistry();

    registerAgentKnowledgeTool(registry, paths, configManager(paths));

    expect(registry.has('agent_knowledge')).toBe(true);
  });
});
