import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort, JudgmentRequest, JudgmentResult, Questions } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { CommandContext } from '../../input/command-registry.ts';
import { knowledgeCommand } from '../../input/commands/knowledge.ts';
import { createKnowledgeApi, KnowledgeService, KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { MemoryEmbeddingProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/state';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type CommandScopeReading = readonly [kind: 'source' | 'node' | 'issue', text: string, probability: number];
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function commandKnowledgeReadings(scope: readonly CommandScopeReading[], titles: readonly string[] = [], excerpts: readonly string[] = []) {
  return fakePort((name, _question, state) => {
    if (!object(state) || !object(state.candidate)) throw new Error('Missing command knowledge candidate');
    const candidate = state.candidate;
    if (name === 'included' && object(candidate.content)) {
      const text = candidate.content.title ?? candidate.content.message ?? candidate.content.sourceUri;
      const reading = scope.find(([kind, authored]) => kind === candidate.kind && authored === text);
      if (reading) return noulAnswer(reading[2]);
    }
    if (name === 'useful' && typeof candidate.title === 'string' && titles.includes(candidate.title)) return noulAnswer(0.99);
    if (name === 'excerptUseful' && typeof candidate.text === 'string' && excerpts.includes(candidate.text)) return noulAnswer(0.99);
    throw new Error(`Unscripted command knowledge reading: ${name}`);
  });
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl = '';
let servedRequests = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch() {
      servedRequests++;
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
  let restoreJudgment: (() => void) | undefined;
  let previousJudgment: JudgmentPort | undefined;

  function installKnowledgeSourceReadings(title: string) {
    const rejected: string[] = [];
    const readings = fakePort((name, question, state) => {
      if (!object(state)) throw new Error('Missing artifact fixture state');
      const input = state;
      if (name === 'included' && object(input.candidate) && input.candidate.kind === 'source'
        && object(input.candidate.content) && input.candidate.content.title === title) return noulAnswer(0.99);
      rejected.push(name);
      throw new Error(`Unexpected knowledge command reading: ${name}`);
    });
    const previous = installJudgmentPort(readings.port);
    restoreJudgment = () => { installJudgmentPort(previous); };
    return { ...readings, rejected };
  }

  beforeEach(() => {
    previousJudgment = installJudgmentPort(undefined);
    printed = [];
    root = makeProjectTempDir('gv-knowledge-command');
    configManager = new ConfigManager({ surfaceRoot: 'tui',  configDir: join(root, '.goodvibes', 'tui'), workingDir: root });
    memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    });
    memoryRegistry = new MemoryRegistry(memoryStore);
  });

  afterEach(() => {
    restoreJudgment?.();
    restoreJudgment = undefined;
    installJudgmentPort(previousJudgment);
    memoryStore.close();
  });

  async function scopedFixture() {
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge-agent.sqlite'), family: 'agent' });
    const service = new KnowledgeService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }), undefined, { memoryRegistry });
    const source = await store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Agent recovery guide', status: 'indexed' });
    const node = await store.upsertNode({ kind: 'topic', slug: 'agent-recovery', title: 'Agent recovery', sourceId: source.id, confidence: 95 });
    const issue = await store.upsertIssue({ severity: 'warning', code: 'agent.recovery', message: 'Replay the Agent recovery queue.', sourceId: source.id, nodeId: node.id });
    await store.upsertSource({ connectorId: 'manual', sourceType: 'document', title: 'Installation device catalog', status: 'indexed', description: 'Only device installation descriptors with no project documentation.' });
    const foreign = await store.upsertSource({ connectorId: 'homeassistant', sourceType: 'document', title: 'Private kitchen passport', status: 'indexed', metadata: { knowledgeSpaceId: 'homeassistant:fixture' } });
    await store.upsertEdge({ fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id, relation: 'documents' });
    const scope: readonly CommandScopeReading[] = [
      ['source', 'Agent recovery guide', 0.99], ['node', 'Agent recovery', 0.99],
      ['issue', 'Replay the Agent recovery queue.', 0.99], ['source', 'Installation device catalog', 0.01],
    ];
    const readings = commandKnowledgeReadings(scope);
    const context = makeKnowledgeCommandContext(root, printed, service, memoryRegistry);
    return { store, service, source, node, issue, foreign, readings, context };
  }

  test.each([
    { command: ['list'], expected: 'Agent recovery guide' },
    { command: ['list', '--kind', 'nodes'], expected: 'Agent recovery' },
    { command: ['list', '--kind', 'issues'], expected: 'Replay the Agent recovery queue.' },
    { command: ['queue'], expected: 'Replay the Agent recovery queue.' },
    { command: ['status'], expected: 'sources: 1' },
    { command: ['map'], expected: 'nodes: 2 of 3' },
  ])('awaits real scoped Agent records for $command', async ({ command, expected }) => {
    const fixture = await scopedFixture();
    const previous = installJudgmentPort(fixture.readings.port);
    try {
      await knowledgeCommand.handler([...command], fixture.context);
      expect(printed.join('\n')).toContain(expected);
      expect(printed.join('\n')).not.toContain('Installation device catalog');
      expect(printed.join('\n')).not.toContain('Private kitchen passport');
      expect(fixture.readings.requests.some(request => Object.hasOwn(request.questions, 'included'))).toBe(true);
    } finally { installJudgmentPort(previous); fixture.service.dispose(); fixture.store.close(); }
  });

  test('awaits scoped item lookup and never publishes a foreign item', async () => {
    const fixture = await scopedFixture();
    const previous = installJudgmentPort(fixture.readings.port);
    try {
      await knowledgeCommand.handler(['get', fixture.source.id], fixture.context);
      expect(printed.join('\n')).toContain('Agent recovery guide');
      printed.length = 0;
      await knowledgeCommand.handler(['get', fixture.foreign.id], fixture.context);
      expect(printed.join('\n')).toContain(`Unknown item ${fixture.foreign.id}`);
      expect(printed.join('\n')).not.toContain('Private kitchen passport');
    } finally { installJudgmentPort(previous); fixture.service.dispose(); fixture.store.close(); }
  });

  test.each(['cancelled', 'revoked', 'stopped', 'session', 'args', 'api', 'method', 'restriction', 'output'] as const)(
    'pending scoped Agent command retains %s ownership and publishes no stale output or usage', async state => {
      const fixture = await scopedFixture();
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const port: JudgmentPort = { ...fixture.readings.port, async ask<const Q extends Questions>(request: JudgmentRequest<Q>): Promise<JudgmentResult<Q>> {
        if (Object.hasOwn(request.questions, 'included')) { entered.resolve(); await release.promise; }
        return fixture.readings.port.ask(request);
      } };
      const previous = installJudgmentPort(port);
      const controller = new AbortController();
      let current = true, stopped = false;
      const restrictions = { signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('Command revoked'); }, shouldStop: () => stopped };
      const context: CommandContext = { ...fixture.context, judgmentReadingOptions: restrictions };
      const args = ['get', fixture.source.id];
      const usage = fixture.store.listUsageRecords();
      let restoreMethod: (() => void) | undefined;
      let replacementCalls = 0;
      try {
        const pending = knowledgeCommand.handler(args, context);
        await Promise.race([entered.promise, Promise.resolve(pending).then(() => { throw new Error('Command settled before scope dispatch'); })]);
        if (state === 'cancelled') controller.abort(new Error('Command cancelled'));
        if (state === 'revoked') current = false;
        if (state === 'stopped') stopped = true;
        if (state === 'session') context.session.runtime.sessionId = 'another-session';
        if (state === 'args') args[1] = fixture.foreign.id;
        if (state === 'api') Object.defineProperty(context, 'clients', { value: { agentKnowledgeApi: createKnowledgeApi(fixture.service) } });
        if (state === 'method') {
          const api = context.clients?.agentKnowledgeApi;
          if (!api) throw new Error('Missing fixture API');
          const replaced = spyOn(api.graph.items, 'get').mockImplementation(async () => { replacementCalls++; return null; });
          restoreMethod = () => { replaced.mockRestore(); };
        }
        if (state === 'restriction') restrictions.assertCurrent = () => {};
        if (state === 'output') context.print = () => { replacementCalls++; };
        release.resolve();
        await pending;
        expect(printed).toEqual([]);
        expect(replacementCalls).toBe(0);
        expect(fixture.store.listUsageRecords()).toEqual(usage);
      } finally { release.resolve(); restoreMethod?.(); installJudgmentPort(previous); fixture.service.dispose(); fixture.store.close(); }
    },
  );

  test.each(['currentness', 'stop'] as const)('asynchronous %s cannot authorize an Agent command reading', async field => {
    const fixture = await scopedFixture();
    const restrictions = {};
    Object.defineProperty(restrictions, field === 'currentness' ? 'assertCurrent' : 'shouldStop', { value: async () => false });
    const context: CommandContext = { ...fixture.context, judgmentReadingOptions: restrictions };
    const previous = installJudgmentPort(fixture.readings.port);
    try {
      await knowledgeCommand.handler(['get', fixture.source.id], context);
      expect(printed).toEqual([]);
      expect(fixture.readings.requests).toHaveLength(0);
      expect(fixture.store.listUsageRecords()).toHaveLength(0);
    } finally { installJudgmentPort(previous); fixture.service.dispose(); fixture.store.close(); }
  });

  test.each(['session', 'output'] as const)('a fulfilled real scoped read cannot paint into a replaced %s', async state => {
    const fixture = await scopedFixture();
    const api = fixture.context.clients?.agentKnowledgeApi;
    if (!api) throw new Error('Missing fixture API');
    const original = api.sources.list;
    let fulfilled = false, replacementPaints = 0;
    const wrapped = spyOn(api.sources, 'list').mockImplementation(async (limit, options) => {
      const records = await original.call(api.sources, limit, options);
      fulfilled = true;
      if (state === 'session') fixture.context.session.runtime.sessionId = 'another-session';
      else fixture.context.print = () => { replacementPaints++; };
      return records;
    });
    const previous = installJudgmentPort(fixture.readings.port);
    try {
      await knowledgeCommand.handler(['list'], fixture.context);
      expect(fulfilled).toBe(true);
      expect(printed).toEqual([]);
      expect(replacementPaints).toBe(0);
    } finally { wrapped.mockRestore(); installJudgmentPort(previous); fixture.service.dispose(); fixture.store.close(); }
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

  test('retains blocked URL metadata in a packet without claiming fetched HTML', async () => {
    const requestsBefore = servedRequests;
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

    const sources = knowledgeStore.listSources(10);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ status: 'failed', sourceUri: `${baseUrl}/docs`, tags: ['example', 'docs'] });
    expect(sources[0]?.crawlError).toContain('Artifact URI blocked by SSRF policy');
    expect(servedRequests).toBe(requestsBefore);
    expect(sources[0]?.title).toBeUndefined();
    expect(sources[0]?.summary).toBeUndefined();
    expect(knowledgeStore.getExtractionBySourceId(sources[0]!.id)).toBeNull();

    printed.length = 0;
    // Authored relevance for this sole metadata-only source. The existing
    // localhost boundary remains intact and no HTML excerpts were captured.
    const packetReadings = commandKnowledgeReadings([['source', `${baseUrl}/docs`, 0.99]], ['Untitled source']);
    const previous = installJudgmentPort(packetReadings.port);
    try { await knowledgeCommand.handler(
      ['packet', 'example docs'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    ); } finally { installJudgmentPort(previous); }

    expect(printed.join('\n')).toContain('Curated Project Knowledge');
    expect(printed.join('\n')).toContain(`${baseUrl}/docs`);
    expect(printed.join('\n')).not.toContain('Example Page');
    expect(printed.join('\n')).not.toContain('Knowledge command test page.');
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
    const text = '# Agent Guide\n\nUse Agent Knowledge for product-owned references.\n';
    const readings = installKnowledgeSourceReadings('Agent Guide');
    writeFileSync(filePath, text);

    await knowledgeCommand.handler(
      ['ingest-file', filePath, '--title', 'Agent Guide', '--tags', 'agent,guide'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Refusing to ingest file into Agent Knowledge');
    expect(knowledgeStore.listSources()).toHaveLength(0);
    expect(readings.requests).toHaveLength(0);

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
    expect(sources[0]?.status).toBe('indexed');
    expect(knowledgeStore.getExtractionBySourceId(sources[0]!.id)?.excerpt).toBe(text.trim());
    // Optional semantic enrichment is outside this extraction fixture and
    // remains fail-closed rather than inventing facts for the document.
    expect(readings.rejected.filter(name => name !== 'wanted')).toEqual([]);
    expect(readings.requests.some(request => Object.hasOwn(request.questions, 'kind'))).toBe(false);
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
    const text = '# Reviewed Export\n\nPromote this artifact into Agent Knowledge.\n';
    const readings = installKnowledgeSourceReadings('Reviewed Export');
    const artifact = await artifactStore.create({
      filename: 'reviewed-export.md',
      text,
    });
    expect(readings.requests).toHaveLength(0);

    await knowledgeCommand.handler(
      ['ingest-artifact', artifact.id, '--title', 'Reviewed Export', '--tags', 'artifact,reviewed'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Refusing to ingest artifact into Agent Knowledge');
    expect(knowledgeStore.listSources()).toHaveLength(0);
    expect(readings.requests).toHaveLength(0);

    printed = [];
    await knowledgeCommand.handler(
      ['ingest-artifact', artifact.id, '--title', 'Reviewed Export', '--tags', 'artifact,reviewed', '--yes'],
      makeKnowledgeCommandContext(root, printed, knowledgeService, memoryRegistry),
    );

    expect(printed.join('\n')).toContain('Ingested');
    const sources = knowledgeStore.listSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.connectorId).toBe('goodvibes-agent-artifact-browser');
    expect(sources[0]?.status).toBe('indexed');
    expect(knowledgeStore.getExtractionBySourceId(sources[0]!.id)?.excerpt).toBe(text.trim());
    // Optional semantic enrichment is outside this extraction fixture and
    // remains fail-closed rather than inventing facts for the document.
    expect(readings.rejected.filter(name => name !== 'wanted')).toEqual([]);
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
