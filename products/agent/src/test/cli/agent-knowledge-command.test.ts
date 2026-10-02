import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { handleAgentKnowledgeCommand, handleAgentKnowledgeShortcutCommand } from '../../cli/agent-knowledge-command.ts';
import { formatEntityList } from '../../cli/agent-knowledge-format.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

function createRuntimeForArgv(argv: readonly string[]) {
  const root = makeProjectTempDir('gv-agent-knowledge-cli');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  mkdirSync(workingDirectory, { recursive: true });
  writeFileSync(
    join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'),
    JSON.stringify({ token: 'test-token' }),
  );
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  return {
    cli: parseGoodVibesCli([...argv, '--json']),
    configManager,
    workingDirectory,
    homeDirectory,
  };
}

function createRuntime(commandArgs: readonly string[]) {
  return createRuntimeForArgv(['knowledge', ...commandArgs]);
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent Knowledge CLI route isolation', () => {
  test('ingest-url uses the Agent Knowledge route and never the default knowledge path', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify({
        source: {
          id: 'src-agent-manual',
          canonicalUri: 'https://example.test/agent-manual',
          sourceType: 'url',
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime([
        'ingest-url',
        'https://example.test/agent-manual',
        '--title',
        'Agent Manual',
        '--tags',
        'agent,manual',
      ]));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(2);
      expect(requests).toHaveLength(0);
      expect(parsed).toMatchObject({
        ok: false,
        kind: 'confirmation_required',
        route: '/api/goodvibes-agent/knowledge/ingest/url',
      });

      const confirmed = await handleAgentKnowledgeCommand(createRuntime([
        'ingest-url',
        'https://example.test/agent-manual',
        '--title',
        'Agent Manual',
        '--tags',
        'agent,manual',
        '--yes',
      ]));
      const confirmedParsed = JSON.parse(confirmed.output) as unknown;

      expect(confirmed.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/url');
      expect(requests[0]?.url).not.toContain('/api/knowledge/');
      expect(requests[0]?.body).toContain('"title":"Agent Manual"');
      expect(confirmedParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ingest.url',
        route: '/api/goodvibes-agent/knowledge/ingest/url',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ingest-file uses the Agent Knowledge artifact route and never the default knowledge path', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify({
        source: {
          id: 'src-agent-file',
          canonicalUri: '/workspace/agent-guide.md',
          sourceType: 'document',
        },
        artifactId: 'artifact-agent-file',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime([
        'ingest-file',
        '/workspace/agent-guide.md',
        '--title',
        'Agent Guide',
        '--tags',
        'agent,guide',
      ]));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(2);
      expect(requests).toHaveLength(0);
      expect(parsed).toMatchObject({
        ok: false,
        kind: 'confirmation_required',
        route: '/api/goodvibes-agent/knowledge/ingest/artifact',
      });

      const confirmed = await handleAgentKnowledgeCommand(createRuntime([
        'ingest-file',
        '/workspace/agent-guide.md',
        '--title',
        'Agent Guide',
        '--tags',
        'agent,guide',
        '--yes',
      ]));
      const confirmedParsed = JSON.parse(confirmed.output) as unknown;

      expect(confirmed.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/artifact');
      expect(requests[0]?.url).not.toContain('/api/knowledge/');
      expect(requests[0]?.body).toContain('"path":"/workspace/agent-guide.md"');
      expect(requests[0]?.body).toContain('"connectorId":"goodvibes-agent-file"');
      expect(confirmedParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ingest.artifact',
        route: '/api/goodvibes-agent/knowledge/ingest/artifact',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ingest-artifact uses artifact ids on the isolated Agent Knowledge route', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify({
        source: {
          id: 'src-agent-artifact',
          canonicalUri: 'artifact-123',
          sourceType: 'artifact',
        },
        artifactId: 'artifact-123',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime([
        'ingest-artifact',
        'artifact-123',
        '--title',
        'Reviewed Export',
        '--tags',
        'artifact,reviewed',
        '--yes',
      ]));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/artifact');
      expect(requests[0]?.url).not.toContain('/api/knowledge/');
      expect(requests[0]?.body).toContain('"artifactId":"artifact-123"');
      expect(requests[0]?.body).not.toContain('"path"');
      expect(requests[0]?.body).toContain('"connectorId":"goodvibes-agent-artifact-browser"');
      expect(parsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ingest.artifact',
        route: '/api/goodvibes-agent/knowledge/ingest/artifact',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('rejects Knowledge space flags before any connected-host request', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => {
      throw new Error('connected host must not be called for rejected Agent Knowledge scope flags');
    });

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime([
        'search',
        'what',
        'is',
        'Agent?',
        '--includeAllSpaces',
      ]));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(2);
      expect(parsed).toMatchObject({
        ok: false,
        kind: 'agent_knowledge_scope_rejected',
        route: '/api/goodvibes-agent/knowledge/*',
      });
      expect(result.output).toContain('must not use default knowledge or non-Agent product spaces');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('status JSON reports Agent Knowledge route identity', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({
      ready: true,
      sourceCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      issueCount: 0,
      storagePath: 'knowledge-agent.sqlite',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime(['status']));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(0);
      expect(parsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.status',
        route: '/api/goodvibes-agent/knowledge/status',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('list/get/connectors use isolated Agent Knowledge read routes', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (url.includes('/sources')) {
        return new Response(JSON.stringify({
          sources: [{
            id: 'src-agent',
            connectorId: 'manual',
            sourceType: 'url',
            title: 'Agent Manual',
            canonicalUri: 'https://example.test/agent',
            tags: [],
            status: 'ready',
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/items/src-agent')) {
        return new Response(JSON.stringify({
          source: {
            id: 'src-agent',
            connectorId: 'manual',
            sourceType: 'url',
            title: 'Agent Manual',
            canonicalUri: 'https://example.test/agent',
            tags: [],
            status: 'ready',
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          },
          relatedEdges: [],
          linkedSources: [],
          linkedNodes: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/connectors/url/doctor')) {
        return new Response(JSON.stringify({
          connectorId: 'url',
          ready: true,
          summary: 'URL connector is ready.',
          checks: [{
            id: 'route',
            label: 'Route',
            status: 'pass',
            detail: 'Agent Knowledge route is available.',
          }],
          hints: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/connectors/url')) {
        return new Response(JSON.stringify({
          id: 'url',
          displayName: 'URL',
          description: 'Ingest one URL into Agent Knowledge.',
          sourceType: 'url',
          capabilities: ['ingest-url'],
          examples: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/connectors')) {
        return new Response(JSON.stringify({
          connectors: [{
            id: 'url',
            displayName: 'URL',
            description: 'Ingest one URL into Agent Knowledge.',
            sourceType: 'url',
          }],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected route ${url}`);
    });

    try {
      const sources = await handleAgentKnowledgeCommand(createRuntime(['list', '--kind', 'sources', '--limit', '2']));
      const sourceParsed = JSON.parse(sources.output) as unknown;
      const item = await handleAgentKnowledgeCommand(createRuntime(['get', 'src-agent']));
      const itemParsed = JSON.parse(item.output) as unknown;
      const connectors = await handleAgentKnowledgeCommand(createRuntime(['connectors']));
      const connectorParsed = JSON.parse(connectors.output) as unknown;
      const connector = await handleAgentKnowledgeCommand(createRuntime(['connectors', 'url']));
      const connectorGetParsed = JSON.parse(connector.output) as unknown;
      const doctor = await handleAgentKnowledgeCommand(createRuntime(['connectors', 'doctor', 'url']));
      const doctorParsed = JSON.parse(doctor.output) as unknown;

      expect(sources.exitCode).toBe(0);
      expect(item.exitCode).toBe(0);
      expect(connectors.exitCode).toBe(0);
      expect(connector.exitCode).toBe(0);
      expect(doctor.exitCode).toBe(0);
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/sources?limit=2',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/items/src-agent',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/connectors',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/connectors/url',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/connectors/url/doctor',
      ]);
      expect(requests.map((request) => request.url).filter((url) => url.includes('/api/knowledge/'))).toEqual([]);
      expect(sourceParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.sources.list',
        route: '/api/goodvibes-agent/knowledge/sources',
      });
      expect(itemParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.item.get',
        route: '/api/goodvibes-agent/knowledge/items/src-agent',
      });
      expect(connectorParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.connectors.list',
        route: '/api/goodvibes-agent/knowledge/connectors',
      });
      expect(connectorGetParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.connector.get',
        route: '/api/goodvibes-agent/knowledge/connectors/url',
      });
      expect(doctorParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.connector.doctor',
        route: '/api/goodvibes-agent/knowledge/connectors/url/doctor',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('import-urls and reindex require confirmation and use isolated Agent Knowledge routes', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      if (inputUrl(input).includes('/ingest/urls')) {
        return new Response(JSON.stringify({
          imported: 1,
          failed: 0,
          sources: [],
          errors: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (inputUrl(input).includes('/reindex')) {
        return new Response(JSON.stringify({
          status: {
            ready: true,
            storagePath: 'knowledge-agent.sqlite',
            sourceCount: 1,
            nodeCount: 1,
            edgeCount: 0,
            issueCount: 0,
            extractionCount: 1,
            jobRunCount: 0,
            usageCount: 0,
            candidateCount: 0,
            reportCount: 0,
            scheduleCount: 0,
          },
          issues: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected route ${inputUrl(input)}`);
    });

    try {
      const preview = await handleAgentKnowledgeCommand(createRuntime(['import-urls', '/tmp/links.txt']));
      const previewParsed = JSON.parse(preview.output) as unknown;
      expect(preview.exitCode).toBe(2);
      expect(requests).toHaveLength(0);
      expect(previewParsed).toMatchObject({
        ok: false,
        kind: 'confirmation_required',
        route: '/api/goodvibes-agent/knowledge/ingest/urls',
      });

      const imported = await handleAgentKnowledgeCommand(createRuntime(['import-urls', '/tmp/links.txt', '--yes']));
      const importedParsed = JSON.parse(imported.output) as unknown;
      expect(imported.exitCode).toBe(0);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/urls');
      expect(requests[0]?.body).toContain('"path":"/tmp/links.txt"');
      expect(importedParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ingest.urls',
        route: '/api/goodvibes-agent/knowledge/ingest/urls',
      });

      const reindexPreview = await handleAgentKnowledgeCommand(createRuntime(['reindex']));
      const reindexPreviewParsed = JSON.parse(reindexPreview.output) as unknown;
      expect(reindexPreview.exitCode).toBe(2);
      expect(requests).toHaveLength(1);
      expect(reindexPreviewParsed).toMatchObject({
        ok: false,
        kind: 'confirmation_required',
        route: '/api/goodvibes-agent/knowledge/reindex',
      });

      const reindex = await handleAgentKnowledgeCommand(createRuntime(['reindex', '--yes']));
      const reindexParsed = JSON.parse(reindex.output) as unknown;
      expect(reindex.exitCode).toBe(0);
      expect(requests[1]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/reindex');
      expect(requests.map((request) => request.url).filter((url) => url.includes('/api/knowledge/'))).toEqual([]);
      expect(reindexParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.reindex',
        route: '/api/goodvibes-agent/knowledge/reindex',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('import-browser-history requires confirmation and uses isolated Agent Knowledge routes', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify({
        imported: 2,
        failed: 0,
        sources: [],
        errors: [],
        profiles: [{
          family: 'chromium',
          browser: 'chrome',
          profileName: 'Default',
          profilePath: '/home/test/.config/google-chrome/Default',
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const preview = await handleAgentKnowledgeCommand(createRuntime([
        'import-browser-history',
        '--browsers',
        'chrome,firefox',
        '--sources',
        'history,bookmark',
        '--limit',
        '25',
      ]));
      const previewParsed = JSON.parse(preview.output) as unknown;
      expect(preview.exitCode).toBe(2);
      expect(requests).toHaveLength(0);
      expect(previewParsed).toMatchObject({
        ok: false,
        kind: 'confirmation_required',
        route: '/api/goodvibes-agent/knowledge/ingest/browser-history',
      });

      const imported = await handleAgentKnowledgeCommand(createRuntime([
        'import-browser-history',
        '--browsers',
        'chrome,firefox',
        '--sources',
        'history,bookmark',
        '--limit',
        '25',
        '--yes',
      ]));
      const importedParsed = JSON.parse(imported.output) as unknown;

      expect(imported.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/browser-history');
      expect(requests[0]?.url).not.toContain('/api/knowledge/');
      expect(requests[0]?.body).toContain('"browsers":["chrome","firefox"]');
      expect(requests[0]?.body).toContain('"sourceKinds":["history","bookmark"]');
      expect(requests[0]?.body).toContain('"connectorId":"goodvibes-agent-browser-history"');
      expect(importedParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ingest.browserHistory',
        route: '/api/goodvibes-agent/knowledge/ingest/browser-history',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ingest-connector requires confirmation and uses isolated Agent Knowledge routes', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify({
        imported: 1,
        failed: 0,
        sources: [],
        errors: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const preview = await handleAgentKnowledgeCommand(createRuntime([
        'ingest-connector',
        'url',
        '--input',
        'https://example.test/reference',
      ]));
      const previewParsed = JSON.parse(preview.output) as unknown;
      expect(preview.exitCode).toBe(2);
      expect(requests).toHaveLength(0);
      expect(previewParsed).toMatchObject({
        ok: false,
        kind: 'confirmation_required',
        route: '/api/goodvibes-agent/knowledge/ingest/connector',
      });

      const imported = await handleAgentKnowledgeCommand(createRuntime([
        'ingest-connector',
        'url',
        '--input',
        'https://example.test/reference',
        '--yes',
      ]));
      const importedParsed = JSON.parse(imported.output) as unknown;

      expect(imported.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ingest/connector');
      expect(requests[0]?.url).not.toContain('/api/knowledge/');
      expect(requests[0]?.body).toContain('"connectorId":"url"');
      expect(requests[0]?.body).toContain('"input":"https://example.test/reference"');
      expect(importedParsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ingest.connector',
        route: '/api/goodvibes-agent/knowledge/ingest/connector',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('ask uses only the Agent Knowledge route', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
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
    });

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime([
        'ask',
        'What',
        'is',
        'GoodVibes',
        'Agent?',
      ]));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ask');
      expect(requests[0]?.url).not.toContain('/api/knowledge/');
      expect(parsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ask',
        route: '/api/goodvibes-agent/knowledge/ask',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('top-level ask shortcut uses only the Agent Knowledge route', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
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
    });

    try {
      const runtime = createRuntimeForArgv(['ask', 'What', 'is', 'GoodVibes', 'Agent?']);
      const result = await handleAgentKnowledgeShortcutCommand(runtime, 'ask');
      const parsed = JSON.parse(result.output) as unknown;

      expect(runtime.cli.command).toBe('ask');
      expect(result.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ask');
      expect(requests[0]?.url).not.toContain('/api/knowledge/');
      expect(parsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ask',
        route: '/api/goodvibes-agent/knowledge/ask',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('search uses only the Agent Knowledge route', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify({
        query: 'GoodVibes Agent',
        results: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime([
        'search',
        'GoodVibes',
        'Agent',
      ]));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('http://127.0.0.1:3421/api/goodvibes-agent/knowledge/search');
      expect(requests[0]?.url).not.toContain('/api/knowledge/');
      expect(parsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.search',
        route: '/api/goodvibes-agent/knowledge/search',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('normalizes Agent Knowledge default scope aliases on public Agent routes', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({
        url: inputUrl(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      return new Response(JSON.stringify({
        ok: true,
        spaceId: 'default',
        query: 'What is GoodVibes Agent?',
        answer: {
          text: 'No knowledge matched.',
          mode: 'standard',
          confidence: 0,
          synthesized: false,
          sources: [],
          facts: [],
          linkedObjects: [],
          gaps: [],
        },
        results: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime([
        'ask',
        'What',
        'is',
        'GoodVibes',
        'Agent?',
      ]));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(0);
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/ask',
      ]);
      expect(requests.map((request) => request.url).filter((url) => url.includes('/api/knowledge/'))).toEqual([]);
      expect(parsed).toMatchObject({
        ok: true,
        kind: 'agentKnowledge.ask',
        route: '/api/goodvibes-agent/knowledge/ask',
        data: {
          spaceId: 'goodvibes-agent:default',
        },
      });
      expect(result.output).not.toContain('"spaceId": "default"');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('classifies missing Agent Knowledge route without legacy daemon fields or default knowledge fallback', async () => {
    const requests: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : null,
      });
      throw new Error('Route not found: /api/goodvibes-agent/knowledge/status (404)');
    });

    try {
      const result = await handleAgentKnowledgeCommand(createRuntime(['status']));
      const parsed = JSON.parse(result.output) as unknown;

      expect(result.exitCode).toBe(1);
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/status',
        'http://127.0.0.1:3421/status',
      ]);
      expect(parsed).toMatchObject({
        ok: false,
        kind: 'connected_host_route_unavailable',
        route: '/api/goodvibes-agent/knowledge/status',
      });
      expect(Object.prototype.hasOwnProperty.call(parsed as object, 'daemonVersion')).toBe(false);
      expect(result.output).not.toContain('daemon_');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Agent Knowledge list rendering', () => {
  const nodes = (count: number): unknown[] => Array.from({ length: count }, (_value, index) => ({
    id: `node-${index}`,
    label: `Node ${index}`,
    kind: 'concept',
  }));

  test('names the records left out when the service reports more than the page holds', () => {
    const printed = formatEntityList({ nodes: nodes(3), total: 41 }, 'nodes', 3);
    expect(printed).toContain('3 of 41');
    expect(printed).toContain('partial');
  });

  test('says a full page may be hiding records when no total is reported', () => {
    const printed = formatEntityList({ nodes: nodes(5) }, 'nodes', 5);
    expect(printed).toContain('page is full');
    expect(printed).toContain('more records may exist');
  });

  test('a short page with no total makes no partial claim', () => {
    const printed = formatEntityList({ nodes: nodes(2) }, 'nodes', 5);
    expect(printed).toContain('Agent Knowledge nodes (2, limit 5)');
    expect(printed).not.toContain('partial');
    expect(printed).not.toContain('page is full');
  });

  test('renders every row the service sent when more arrive than the page asked for', () => {
    const printed = formatEntityList({ nodes: nodes(7) }, 'nodes', 4);
    expect(printed).toContain('4 of 7 received');
    expect(printed).toContain('partial');
    expect(printed).not.toContain('Node 4');
  });
});
