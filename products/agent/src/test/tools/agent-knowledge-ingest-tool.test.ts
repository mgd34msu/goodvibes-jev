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
  createAgentKnowledgeIngestTool,
  registerAgentKnowledgeIngestTool,
} from '../../tools/agent-knowledge-ingest-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ShellPathService;

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

interface IngestPayload {
  readonly path?: string;
  readonly artifactId?: string;
  readonly url?: string;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly connectorId?: string;
  readonly allowPrivateHosts?: boolean;
  readonly input?: unknown;
  readonly content?: string;
  readonly metadata?: {
    readonly originSurface?: string;
    readonly explicitUserRequest?: string;
  };
}

function shellPaths(withToken = true): ShellPaths {
  const root = makeProjectTempDir('goodvibes-agent-knowledge-ingest-tool');
  if (withToken) {
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'agent-knowledge-ingest-token' }));
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

function ingestResponse(): Response {
  return Response.json({
    source: {
      id: 'source-agent-docs',
      canonicalUri: 'https://example.com/agent-docs',
    },
  });
}

describe('agent_knowledge_ingest tool', () => {
  test('previews without calling the connected host when confirmation is missing', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return ingestResponse();
    });

    try {
      const result = await tool.execute({
        url: 'https://example.com/agent-docs',
        tags: ['docs', 'agent'],
        confirm: false,
        explicitUserRequest: 'Add this docs URL to your Agent Knowledge.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Agent Knowledge URL ingest preview');
      expect(result.error).toContain('/api/goodvibes-agent/knowledge/ingest/url');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('requires explicit user request provenance before ingesting', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return ingestResponse();
    });

    try {
      const result = await tool.execute({
        url: 'https://example.com/agent-docs',
        confirm: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('explicitUserRequest is required');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ingests URL through only the isolated Agent Knowledge route after explicit confirmation', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return ingestResponse();
    });

    try {
      const result = await tool.execute({
        url: 'https://example.com/agent-docs',
        title: 'Agent docs',
        tags: ['docs', 'agent'],
        confirm: true,
        explicitUserRequest: 'Add this docs URL to your Agent Knowledge.',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Agent Knowledge URL ingest accepted');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/url');
      expect(requests[0]?.url).not.toContain('/api/knowledge');
      expect(requests[0]?.url).not.toContain('homeGraph');
      expect(requests[0]?.method).toBe('POST');
      const payload = JSON.parse(requests[0]?.body ?? '{}') as IngestPayload;
      expect(payload.url).toBe('https://example.com/agent-docs');
      expect(payload.title).toBe('Agent docs');
      expect(payload.tags).toEqual(['docs', 'agent']);
      expect(payload.connectorId).toBe('goodvibes-agent-main-conversation');
      expect(payload.metadata?.originSurface).toBe('goodvibes-agent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ingests local files through only the isolated Agent Knowledge artifact route', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return ingestResponse();
    });

    try {
      const result = await tool.execute({
        sourceKind: 'file',
        path: '/tmp/agent-notes.md',
        title: 'Agent notes',
        tags: ['notes'],
        confirm: true,
        explicitUserRequest: 'Add this local notes file to your Agent Knowledge.',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Agent Knowledge file ingest accepted');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/artifact');
      expect(requests[0]?.url).not.toContain('/api/knowledge');
      const payload = JSON.parse(requests[0]?.body ?? '{}') as IngestPayload;
      expect(payload.path).toBe('/tmp/agent-notes.md');
      expect(payload.title).toBe('Agent notes');
      expect(payload.tags).toEqual(['notes']);
      expect(payload.connectorId).toBe('goodvibes-agent-main-conversation-file');
      expect(payload.metadata?.originSurface).toBe('goodvibes-agent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ingests saved artifact ids through only the isolated Agent Knowledge artifact route', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return ingestResponse();
    });

    try {
      const result = await tool.execute({
        sourceKind: 'artifact',
        artifactId: 'artifact-123',
        title: 'Reviewed export',
        tags: ['artifact', 'reviewed'],
        confirm: true,
        explicitUserRequest: 'Promote this reviewed artifact into Agent Knowledge.',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Agent Knowledge artifact ingest accepted');
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/artifact');
      expect(requests[0]?.url).not.toContain('/api/knowledge');
      const payload = JSON.parse(requests[0]?.body ?? '{}') as IngestPayload;
      expect(payload.artifactId).toBe('artifact-123');
      expect(payload.path).toBeUndefined();
      expect(payload.title).toBe('Reviewed export');
      expect(payload.tags).toEqual(['artifact', 'reviewed']);
      expect(payload.connectorId).toBe('goodvibes-agent-artifact-browser');
      expect(payload.metadata?.originSurface).toBe('goodvibes-agent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('imports URL-list and bookmarks files through isolated Agent routes after confirmation', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return Response.json({ imported: 2, failed: 0, sources: [] });
    });

    try {
      const urls = await tool.execute({
        sourceKind: 'urls_file',
        path: '/tmp/urls.txt',
        confirm: true,
        explicitUserRequest: 'Import this URL list into Agent Knowledge.',
      });
      const bookmarks = await tool.execute({
        sourceKind: 'bookmarks_file',
        path: '/tmp/bookmarks.html',
        confirm: true,
        explicitUserRequest: 'Import these bookmarks into Agent Knowledge.',
      });

      expect(urls.success).toBe(true);
      expect(bookmarks.success).toBe(true);
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/urls',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/bookmarks',
      ]);
      for (const request of requests) {
        expect(request.url).not.toContain('/api/knowledge');
        const payload = JSON.parse(request.body ?? '{}') as IngestPayload;
        expect(payload.path).toMatch(/^\/tmp\//);
        expect(payload.metadata?.originSurface).toBe('goodvibes-agent');
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ingests connector input through the isolated Agent connector route', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return Response.json({ imported: 1, failed: 0, sources: [] });
    });

    try {
      const result = await tool.execute({
        sourceKind: 'connector',
        connectorId: 'manual-note',
        input: '{"summary":"Keep Agent Knowledge isolated."}',
        confirm: true,
        explicitUserRequest: 'Import this connector note into Agent Knowledge.',
      });

      expect(result.success).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/connector');
      const payload = JSON.parse(requests[0]?.body ?? '{}') as IngestPayload;
      expect(payload.connectorId).toBe('manual-note');
      expect(payload.input).toEqual({ summary: 'Keep Agent Knowledge isolated.' });
      expect(payload.metadata?.originSurface).toBe('goodvibes-agent');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('previews browser history import without calling the connected host', async () => {
    const paths = shellPaths();
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return Response.json({ imported: 0, failed: 0, sources: [] });
    });

    try {
      const result = await tool.execute({
        sourceKind: 'browser_history',
        browsers: ['firefox'],
        sourceKinds: ['history'],
        confirm: false,
        explicitUserRequest: 'Import browser history into Agent Knowledge.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('browser-history import preview');
      expect(result.error).toContain('/api/goodvibes-agent/knowledge/ingest/browser-history');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fails closed without token and does not call default knowledge routes', async () => {
    const paths = shellPaths(false);
    const tool = createAgentKnowledgeIngestTool(paths, configManager(paths));
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => {
      calls += 1;
      return ingestResponse();
    });

    try {
      const result = await tool.execute({
        url: 'https://example.com/agent-docs',
        confirm: true,
        explicitUserRequest: 'Add this docs URL to your Agent Knowledge.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('auth_required');
      expect(result.error).toContain('/api/goodvibes-agent/knowledge/ingest/url');
      expect(result.error).not.toContain('/api/knowledge');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('is registered in the model tool registry', () => {
    const paths = shellPaths();
    const registry = new ToolRegistry();

    registerAgentKnowledgeIngestTool(registry, paths, configManager(paths));

    expect(registry.has('agent_knowledge_ingest')).toBe(true);
  });
});
