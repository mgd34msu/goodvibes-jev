import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CommandContext } from '../../input/command-registry.ts';
import { knowledgeCommand } from '../../input/commands/knowledge.ts';
import { createKnowledgeApi, KnowledgeService, KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response('<html><head><title>Example Page</title></head><body><h1>Example</h1><p>Knowledge command test page.</p></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

function makeKnowledgeCommandContext(
  root: string,
  printed: string[],
  knowledgeService: KnowledgeService,
  memoryRegistry: MemoryRegistry,
  sessionId = 'session-1',
): CommandContext {
  const providerRegistry = {} as never;
  const conversationManager = {} as never;
  const configManager = {
    getControlPlaneConfigDir: () => root,
  } as never;
  return {
    session: {
      conversationManager,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId,
      },
    },
    provider: {
      providerRegistry,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      agentKnowledgeService: knowledgeService,
    },
    clients: {
      agentKnowledgeApi: createKnowledgeApi(knowledgeService, { memoryRegistry }),
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

function makeKnowledgeAskCommandContext(printed: string[], askResult: unknown): CommandContext {
  return {
    session: {
      conversationManager: {} as never,
      runtime: {
        model: '',
        provider: '',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: '',
        sessionId: 'session-ask',
      },
    },
    provider: {
      providerRegistry: {} as never,
    },
    workspace: {},
    platform: {
      config: {} as never,
      configManager: {} as never,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
      agentKnowledgeService: {
        ask: async () => askResult,
      } as never,
    },
    clients: {
      agentKnowledgeApi: {} as never,
    },
    renderRequest: () => {},
    print: (text: string) => { printed.push(text); },
    exit: () => {},
  };
}

describe('knowledgeCommand', () => {
  let printed: string[];
  let root: string;
  let memoryStore: MemoryStore;
  let memoryRegistry: MemoryRegistry;
  let configManager: ConfigManager;

  beforeEach(() => {
    printed = [];
    root = makeProjectTempDir('gv-knowledge-command');
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(root, '.goodvibes', 'tui'), workingDir: root });
    memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    memoryRegistry = new MemoryRegistry(memoryStore);
  });

  test('opens Agent Knowledge workspace by default instead of copied panels or fallback APIs', async () => {
    const opened: string[] = [];
    const context = {
      print: (text: string) => { printed.push(text); },
      openAgentWorkspace: (categoryId?: string) => { opened.push(categoryId ?? ''); },
      openKnowledgeWorkspace: () => {
        throw new Error('copied knowledge panel must not open');
      },
      clients: {
        knowledgeApi: {
          status: {
            get: () => {
              throw new Error('default knowledge API must not be called');
            },
          },
        },
      },
    } as unknown as CommandContext;

    await knowledgeCommand.handler([], context);

    expect(opened).toEqual(['knowledge']);
    expect(printed).toEqual([]);
  });

  test('ingests a URL and renders a packet', async () => {
    const artifactStore = new ArtifactStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    const knowledgeStore = new KnowledgeStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    await memoryStore.init();
    const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });

    await knowledgeCommand.handler(
      ['ingest-url', `${baseUrl}/docs`, '--tags', 'example,docs'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Refusing to ingest URL into Agent Knowledge');

    printed.length = 0;
    await knowledgeCommand.handler(
      ['ingest-url', `${baseUrl}/docs`, '--tags', 'example,docs', '--yes'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Ingested');

    printed.length = 0;
    await knowledgeCommand.handler(
      ['packet', 'example docs'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Curated Project Knowledge');
  });

  test('ingests a local file into Agent Knowledge only after confirmation', async () => {
    const artifactStore = new ArtifactStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    const knowledgeStore = new KnowledgeStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    await memoryStore.init();
    const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });
    const filePath = join(root, 'agent-guide.md');
    writeFileSync(filePath, '# Agent Guide\n\nUse Agent Knowledge for product-owned references.\n');

    await knowledgeCommand.handler(
      ['ingest-file', filePath, '--title', 'Agent Guide', '--tags', 'agent,guide'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Refusing to ingest file into Agent Knowledge');
    expect(knowledgeStore.listSources()).toHaveLength(0);

    printed = [];
    await knowledgeCommand.handler(
      ['ingest-file', filePath, '--title', 'Agent Guide', '--tags', 'agent,guide', '--yes'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Ingested');
    expect(printed.join('\n')).toContain('artifact:');
    const sources = knowledgeStore.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.connectorId).toBe('goodvibes-agent-file');
  });

  test('ingests a saved artifact id into Agent Knowledge only after confirmation', async () => {
    const artifactStore = new ArtifactStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    const knowledgeStore = new KnowledgeStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    await memoryStore.init();
    const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });
    const artifact = await artifactStore.create({
      filename: 'reviewed-export.md',
      text: '# Reviewed Export\n\nPromote this artifact into Agent Knowledge.\n',
    });

    await knowledgeCommand.handler(
      ['ingest-artifact', artifact.id, '--title', 'Reviewed Export', '--tags', 'artifact,reviewed'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Refusing to ingest artifact into Agent Knowledge');
    expect(knowledgeStore.listSources()).toHaveLength(0);

    printed = [];
    await knowledgeCommand.handler(
      ['ingest-artifact', artifact.id, '--title', 'Reviewed Export', '--tags', 'artifact,reviewed', '--yes'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Ingested');
    const sources = knowledgeStore.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.connectorId).toBe('goodvibes-agent-artifact-browser');
    expect(sources[0]?.metadata).toMatchObject({
      knowledgeIntent: {
        ingestMode: 'artifact',
      },
    });
  });

  test('imports browser history only after confirmation', async () => {
    let calledInput: unknown = null;
    const context = {
      ...makeKnowledgeAskCommandContext(printed, {
        query: '',
        answer: {
          text: '',
          mode: 'standard',
          confidence: 0,
          synthesized: false,
          sources: [],
          facts: [],
          linkedObjects: [],
          gaps: [],
        },
      }),
      clients: {
        agentKnowledgeApi: {
          ingest: {
            browserHistory: async (input: unknown) => {
              calledInput = input;
              return {
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
              };
            },
          },
        },
      },
    } as unknown as CommandContext;

    await knowledgeCommand.handler(
      ['import-browser-history', '--browsers', 'chrome,firefox', '--sources', 'history', '--limit', '12'],
      context,
    );

    expect(calledInput).toBeNull();
    expect(printed.join('\n')).toContain('Refusing to import browser history into Agent Knowledge without --yes');

    printed.length = 0;
    await knowledgeCommand.handler(
      ['import-browser-history', '--browsers', 'chrome,firefox', '--sources', 'history', '--limit', '12', '--yes'],
      context,
    );

    const input = calledInput as {
      readonly browsers?: readonly string[];
      readonly sourceKinds?: readonly string[];
      readonly limit?: number;
      readonly connectorId?: string;
      readonly sessionId?: string;
    };
    expect(input.browsers).toEqual(['chrome', 'firefox']);
    expect(input.sourceKinds).toEqual(['history']);
    expect(input.limit).toBe(12);
    expect(input.connectorId).toBe('goodvibes-agent-browser-history');
    expect(input.sessionId).toBe('session-ask');
    expect(printed.join('\n')).toContain('Imported browser knowledge: 2 ok, 0 failed');
  });

  test('inspects Agent Knowledge connectors and doctor reports', async () => {
    const context = {
      ...makeKnowledgeAskCommandContext(printed, {
        query: '',
        answer: {
          text: '',
          mode: 'standard',
          confidence: 0,
          synthesized: false,
          sources: [],
          facts: [],
          linkedObjects: [],
          gaps: [],
        },
      }),
      clients: {
        agentKnowledgeApi: {
          connectors: {
            list: () => [{
              id: 'url',
              displayName: 'URL',
              description: 'Ingest one URL.',
              sourceType: 'url',
              capabilities: ['ingest-url'],
            }],
            get: (id: string) => id === 'url'
              ? {
                id: 'url',
                displayName: 'URL',
                description: 'Ingest one URL.',
                sourceType: 'url',
                capabilities: ['ingest-url'],
              }
              : null,
            doctor: (id: string) => ({
              connectorId: id,
              ready: true,
              summary: 'Connector ready.',
              checks: [{
                id: 'route',
                label: 'Route',
                status: 'pass',
                detail: 'Agent route available.',
              }],
              hints: [],
            }),
          },
        },
      },
    } as unknown as CommandContext;

    await knowledgeCommand.handler(['connectors'], context);
    expect(printed.join('\n')).toContain('Connectors (1)');
    expect(printed.join('\n')).toContain('url');

    printed.length = 0;
    await knowledgeCommand.handler(['connectors', 'url'], context);
    expect(printed.join('\n')).toContain('Connector url');
    expect(printed.join('\n')).toContain('capabilities: ingest-url');

    printed.length = 0;
    await knowledgeCommand.handler(['connectors', 'doctor', 'url'], context);
    expect(printed.join('\n')).toContain('Connector doctor url');
    expect(printed.join('\n')).toContain('ready: yes');
  });

  test('ingests connector input only after confirmation', async () => {
    let calledInput: unknown = null;
    const context = {
      ...makeKnowledgeAskCommandContext(printed, {
        query: '',
        answer: {
          text: '',
          mode: 'standard',
          confidence: 0,
          synthesized: false,
          sources: [],
          facts: [],
          linkedObjects: [],
          gaps: [],
        },
      }),
      clients: {
        agentKnowledgeApi: {
          ingest: {
            connectorInput: async (input: unknown) => {
              calledInput = input;
              return {
                imported: 1,
                failed: 0,
                sources: [],
                errors: [],
              };
            },
          },
        },
      },
    } as unknown as CommandContext;

    await knowledgeCommand.handler(
      ['ingest-connector', 'url', '--input', '{"url":"https://example.test/reference"}'],
      context,
    );

    expect(calledInput).toBeNull();
    expect(printed.join('\n')).toContain('Refusing to ingest connector input into Agent Knowledge for url without --yes');

    printed.length = 0;
    await knowledgeCommand.handler(
      ['ingest-connector', 'url', '--input', '{"url":"https://example.test/reference"}', '--yes'],
      context,
    );

    const input = calledInput as {
      readonly connectorId?: string;
      readonly input?: { readonly url?: string };
      readonly sessionId?: string;
    };
    expect(input.connectorId).toBe('url');
    expect(input.input?.url).toBe('https://example.test/reference');
    expect(input.sessionId).toBe('session-ask');
    expect(printed.join('\n')).toContain('Imported connector input: 1 ok, 0 failed');
  });

  test('reviews a knowledge issue', async () => {
    const artifactStore = new ArtifactStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    const knowledgeStore = new KnowledgeStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    await memoryStore.init();
    await knowledgeStore.upsertIssue({
      id: 'issue-1',
      severity: 'warning',
      code: 'needs-review',
      message: 'Generated issue needs operator review.',
      status: 'open',
      metadata: {},
    });
    const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });

    await knowledgeCommand.handler(
      ['review-issue', 'issue-1', 'resolve', '--reviewer', 'test'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Refusing to review Agent Knowledge issue issue-1 without --yes');
    expect(knowledgeStore.getIssue('issue-1')?.status).toBe('open');

    printed = [];
    await knowledgeCommand.handler(
      ['review-issue', 'issue-1', 'resolve', '--reviewer', 'test', '--yes'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Reviewed issue issue-1');
    expect(knowledgeStore.getIssue('issue-1')?.status).toBe('resolved');
  });

  test('maps Agent Knowledge through the isolated service map', async () => {
    const artifactStore = new ArtifactStore({
      rootDir: join(root, 'artifacts'),
    });
    const knowledgeStore = new KnowledgeStore({
      configManager: {
        getControlPlaneConfigDir: () => root,
      },
    });
    await memoryStore.init();
    const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, { memoryRegistry });

    await knowledgeCommand.handler(
      ['map', 'setup', '--limit', '25'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    const output = printed.join('\n');
    expect(output).toContain('Agent Knowledge map');
    expect(output).toContain('nodes: 0');
    expect(output).toContain('edges: 0');
    expect(output).toContain('/api/goodvibes-agent/knowledge/map');
  });

  test('asks knowledge and renders Agent semantic answer fields', async () => {
    await knowledgeCommand.handler(
      ['ask', 'what', 'does', 'the', 'manual', 'say?', '--mode', 'detailed'],
      makeKnowledgeAskCommandContext(printed, {
        ok: true,
        spaceId: 'goodvibes-agent',
        query: 'what does the manual say?',
        answer: {
          text: 'The Agent answer text.',
          mode: 'detailed',
          confidence: 91,
          synthesized: true,
          sources: [{
            id: 'src-1',
            connectorId: 'goodvibes-agent',
            sourceType: 'document',
            title: 'Agent manual.pdf',
            tags: [],
            status: 'indexed',
            summary: 'Official manual.',
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
          facts: [{
            id: 'fact-1',
            kind: 'feature',
            slug: 'feature-1',
            title: 'Supports explicit delegation',
            summary: 'Delegation support is documented.',
            aliases: [],
            status: 'active',
            confidence: 88,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
          linkedObjects: [{
            id: 'device-1',
            kind: 'agent_capability',
            slug: 'device-1',
            title: 'Operator workspace',
            summary: 'Agent workspace',
            aliases: [],
            status: 'active',
            confidence: 90,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
          gaps: [{
            id: 'gap-1',
            kind: 'gap',
            slug: 'gap-1',
            title: 'Missing warranty',
            summary: 'No warranty document linked.',
            aliases: [],
            status: 'open',
            confidence: 60,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          }],
        },
        results: [{
          kind: 'source',
          id: 'src-1',
          score: 1,
          reason: 'This local snippet should not be rendered.',
        }],
      }),
    );

    const output = printed.join('\n');
    expect(output).toContain('The Agent answer text.');
    expect(output).toContain('Sources:');
    expect(output).toContain('Agent manual.pdf');
    expect(output).toContain('Facts:');
    expect(output).toContain('Supports explicit delegation');
    expect(output).toContain('Linked objects:');
    expect(output).toContain('Operator workspace');
    expect(output).toContain('Gaps:');
    expect(output).toContain('Missing warranty');
    expect(output).not.toContain('This local snippet should not be rendered.');
  });

  test('refuses default knowledge or non-Agent fallback when Agent Knowledge is not wired', async () => {
    const genericKnowledgeApi = createKnowledgeApi({
      getStatus: () => {
        throw new Error('default knowledge must not be called');
      },
    } as never);
    const context = {
      ...makeKnowledgeAskCommandContext(printed, {
        query: '',
        answer: {
          text: '',
          mode: 'standard',
          confidence: 0,
          synthesized: false,
          sources: [],
          facts: [],
          linkedObjects: [],
          gaps: [],
        },
      }),
      extensions: {
        toolRegistry: {} as never,
        mcpRegistry: {} as never,
        knowledgeService: {
          ask: async () => {
            throw new Error('default knowledge ask must not be called');
          },
        } as never,
      },
      clients: {
        knowledgeApi: genericKnowledgeApi,
      },
    } as CommandContext;

    await knowledgeCommand.handler(['status'], context);

    const output = printed.join('\n');
    expect(output).toContain('Agent Knowledge API is not available');
    expect(output).toContain('Refusing to use default knowledge or non-Agent knowledge fallback');
  });

  test('rejects space flags instead of routing Agent Knowledge to non-Agent/default spaces', async () => {
    await knowledgeCommand.handler(
      ['ask', 'what', 'does', 'the', 'manual', 'say?', '--space'],
      makeKnowledgeAskCommandContext(printed, {
        query: 'what does the manual say?',
        answer: {
          text: 'This must not render.',
          mode: 'standard',
          confidence: 99,
          synthesized: true,
          sources: [],
          facts: [],
          linkedObjects: [],
          gaps: [],
        },
      }),
    );

    const output = printed.join('\n');
    expect(output).toContain('Agent Knowledge is isolated');
    expect(output).toContain('--space is not accepted');
    expect(output).toContain('must not use default knowledge or non-Agent product spaces');
    expect(output).not.toContain('This must not render.');
  });

  test('rejects include-all-spaces on search before querying Agent Knowledge', async () => {
    await knowledgeCommand.handler(
      ['search', 'manual', '--includeAllSpaces'],
      makeKnowledgeCommandContext(root, printed, {
        getStatus: () => {
          throw new Error('search must not call knowledge service when includeAllSpaces is rejected');
        },
      } as never, memoryRegistry),
    );

    const output = printed.join('\n');
    expect(output).toContain('Agent Knowledge is isolated');
    expect(output).toContain('--includeAllSpaces is not accepted');
    expect(output).toContain('/api/goodvibes-agent/knowledge/*');
  });

  test('ingest-url with rejecting API prints [knowledge] prefixed error', async () => {
    const context = {
      ...makeKnowledgeAskCommandContext(printed, {}),
      clients: {
        agentKnowledgeApi: {
          ingest: {
            url: async () => {
              throw new Error('service unavailable');
            },
          },
        },
      },
    } as unknown as CommandContext;

    await knowledgeCommand.handler(['ingest-url', 'https://example.test/doc', '--yes'], context);

    const output = printed.join('\n');
    expect(output).toContain('[knowledge]');
    expect(output).toContain('service unavailable');
  });

  test('refuses Agent Knowledge maintenance mutations without --yes', async () => {
    let reindexed = false;
    let ranJob = false;
    const context = {
      ...makeKnowledgeAskCommandContext(printed, {
        query: '',
        answer: {
          text: '',
          mode: 'standard',
          confidence: 0,
          synthesized: false,
          sources: [],
          facts: [],
          linkedObjects: [],
          gaps: [],
        },
      }),
      clients: {
        agentKnowledgeApi: {
          status: {
            reindex: async () => {
              reindexed = true;
              return { status: { sourceCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0 } };
            },
          },
          jobs: {
            run: async () => {
              ranJob = true;
              return { id: 'run-1', status: 'completed' };
            },
          },
        },
      },
    } as unknown as CommandContext;

    await knowledgeCommand.handler(['reindex'], context);
    expect(reindexed).toBe(false);
    expect(printed.join('\n')).toContain('Refusing to reindex Agent Knowledge without --yes');

    printed.length = 0;
    await knowledgeCommand.handler(['consolidate', 'deep'], context);
    expect(ranJob).toBe(false);
    expect(printed.join('\n')).toContain('Refusing to run Agent Knowledge consolidation without --yes');

    printed.length = 0;
    await knowledgeCommand.handler(['reindex', '--yes'], context);
    expect(reindexed).toBe(true);
    expect(printed.join('\n')).toContain('Reindex complete');

    printed.length = 0;
    await knowledgeCommand.handler(['consolidate', 'deep', '--yes'], context);
    expect(ranJob).toBe(true);
    expect(printed.join('\n')).toContain('Consolidation run run-1 finished');
  });
});
