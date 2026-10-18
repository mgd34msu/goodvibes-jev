import { expect, test } from 'bun:test';
import { parseModelCatalogRepository } from '../sdk/src/platform/providers/model-catalog-repository.js';
import { transformModelsDevResponse, saveCatalogCache, loadCatalogCache } from '../sdk/src/platform/providers/model-catalog-cache.js';
import { installCatalogModelFacts, knownCatalogChatCapability } from '../sdk/src/platform/providers/model-catalog-facts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('repository model inheritance preserves canonical identity, provider overrides and capabilities through the disk cache', async () => {
  const files = new Map([
    ['models/lab/model.toml', 'name="Model"\ntype="chat"\ntool_call=true\n[limit]\ncontext=100000\ninput=90000\noutput=10000\n[modalities]\ninput=["text","image"]\noutput=["text"]'],
    ['providers/a/provider.toml', 'name="A"\nenv=[]'],
    ['providers/a/models/alias.toml', 'base_model="lab/model"\nbase_model_omit=["limit.input"]\n[cost]\ninput=1\noutput=2\n[limit]\ncontext=16000'],
    ['providers/b/provider.toml', 'name="B"\nenv=[]'],
    ['providers/b/models/other.toml', 'base_model="lab/model"\n[cost]\ninput=3\noutput=4'],
    ['providers/a/models/embedding.toml', 'name="Embedding"\ntype="embedding"'],
  ]);
  const repository = await parseModelCatalogRepository(files);
  expect(repository.a!.models.alias!.limit).toEqual({ context: 16000, output: 10000 });
  expect(repository.b!.models.other!.limit).toEqual({ context: 100000, input: 90000, output: 10000 });
  const models = transformModelsDevResponse(repository, new Map([['a', 'metered'], ['b', 'metered']]));
  expect(models.find(model => model.id === 'alias')).toMatchObject({ canonicalModelId: 'lab/model', modelType: 'chat', toolCalling: true, contextWindow: 16000, pricing: { input: 1, output: 2 }, outputModalities: ['text'] });
  const root = mkdtempSync(join(tmpdir(), 'catalog-repository-'));
  try {
    saveCatalogCache(models, join(root, 'models.json'), join(root, 'models.tmp'));
    const cached = loadCatalogCache(join(root, 'models.json'))!;
    expect(cached.models).toEqual(models); expect(cached.ttlMs).toBe(3600000);
    installCatalogModelFacts(cached.models);
    expect(knownCatalogChatCapability('a', 'alias')).toBe(true);
    expect(knownCatalogChatCapability('a', 'embedding')).toBe(false);
    expect(knownCatalogChatCapability('b', 'missing')).toBeUndefined();
  } finally { installCatalogModelFacts([]); rmSync(root, { recursive: true, force: true }); }
});

test('a broken base-model reference refuses the new snapshot', async () => {
  await expect(parseModelCatalogRepository(new Map([
    ['providers/a/provider.toml', 'name="A"'], ['providers/a/models/broken.toml', 'base_model="missing/model"'],
  ]))).rejects.toThrow('unresolved base_model');
});

test('repository types decide untyped live-listing entries without judgment calls', async () => {
  const { fetchModelIdsFromListing } = await import('../sdk/src/platform/providers/live-model-discovery.js');
  const { installJudgmentPort } = await import('@goodvibes-jev/engine/errors');
  const models = transformModelsDevResponse({ a: { id: 'a', name: 'A', models: {
    alias: { id: 'alias', type: 'chat' }, vector: { id: 'vector', type: 'embedding' },
  } } }, new Map());
  installCatalogModelFacts(models);
  let calls = 0;
  const previousPort = installJudgmentPort({ model: 'synthetic-unavailable', async ask() { calls++; throw new Error('Unexpected judgment'); } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'alias' }, { id: 'vector' }, { id: 'unknown' }] }))) as unknown as typeof fetch;
  try {
    const unknown: string[] = [];
    expect(await fetchModelIdsFromListing('a', 'https://listing.example/models', {}, { filterNonChat: true, onUnclassifiedModel: id => unknown.push(id) })).toEqual(['alias']);
    expect(unknown).toEqual(['unknown']); expect(calls).toBe(0);
  } finally { globalThis.fetch = originalFetch; installJudgmentPort(previousPort); installCatalogModelFacts([]); }
});

test('downloads a repository archive, supports long model IDs and rejects a failed refresh', async () => {
  const { c } = await import('tar');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { fetchModelCatalogRepository, MODEL_CATALOG_REPOSITORY_URL } = await import('../sdk/src/platform/providers/model-catalog-repository.js');
  const root = mkdtempSync(join(tmpdir(), 'catalog-archive-'));
  const originalFetch = globalThis.fetch;
  try {
    const dir = join(root, 'snapshot/providers/test/models'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'snapshot/providers/test/provider.toml'), 'name="Test"\nenv=[]');
    const id = 'model-' + 'x'.repeat(150);
    writeFileSync(join(dir, id + '.toml'), 'name="Long ID"\ntype="chat"\n[limit]\ncontext=16000');
    const chunks: Buffer[] = []; for await (const chunk of c({ gzip: true, cwd: root }, ['snapshot'])) chunks.push(Buffer.from(chunk));
    const archive = Buffer.concat(chunks), requested: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => { requested.push(String(url)); return new Response(archive); }) as unknown as typeof fetch;
    const catalog = await fetchModelCatalogRepository();
    expect(catalog.test!.models[id]!.limit).toEqual({ context: 16000 });
    expect(requested).toEqual([MODEL_CATALOG_REPOSITORY_URL]);
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchModelCatalogRepository()).rejects.toThrow('HTTP 503');
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
});

test('a legacy cached catalog remains available while a repository refresh fails', async () => {
  const { writeFileSync, readFileSync } = await import('node:fs');
  const { refreshProviderCatalog } = await import('../sdk/src/platform/providers/registry-catalog-lifecycle.js');
  const root = mkdtempSync(join(tmpdir(), 'catalog-offline-'));
  const cachePath = join(root, 'models.json'), tmpPath = join(root, 'models.tmp');
  const models = [{ id: 'known', name: 'Known', provider: 'A', providerId: 'a', providerEnvVars: [], pricing: null, tier: 'paid' as const, contextWindow: 16000 }];
  const bytes = JSON.stringify({ version: 5, fetchedAt: Date.now(), ttlMs: 86400000, models });
  writeFileSync(cachePath, bytes);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;
  let applied = false;
  try {
    expect(loadCatalogCache(cachePath)?.models).toEqual(models);
    expect(loadCatalogCache(cachePath)?.ttlMs).toBe(0);
    await expect(refreshProviderCatalog({ getCatalogCachePaths: () => ({ cachePath, tmpPath }), getCatalogModels: () => models,
      updateCatalogState() { applied = true; }, favoritesStore: { async load() { return { pinned: [], history: [] }; } },
      benchmarkStore: { getTopBenchmarkModelIds: () => [] }, async refreshCatalog() {}, afterCatalogApplied() {},
    })).rejects.toThrow('HTTP 503');
    expect(applied).toBe(false); expect(readFileSync(cachePath, 'utf8')).toBe(bytes);
  } finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
});

test('published reasoning controls resolve per endpoint and skip family judgments', async () => {
  const { installJudgmentPort } = await import('@goodvibes-jev/engine/errors');
  const { prepareReasoningEffort, resolveReasoningEffortSpec } = await import('../sdk/src/platform/providers/reasoning-effort-families.js');
  const { knownCatalogMaxOutput } = await import('../sdk/src/platform/providers/model-catalog-facts.js');
  const common = { id: 'alias', canonicalModelId: 'lab/model', name: 'Opaque model', providerEnvVars: [], pricing: null, tier: 'paid' as const };
  installCatalogModelFacts([
    { ...common, provider: 'A', providerId: 'a', maxOutputTokens: 16000, reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] },
    { ...common, provider: 'B', providerId: 'b', maxOutputTokens: 32000, reasoningOptions: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 16000 }] },
    ...transformModelsDevResponse({ a: { id: 'a', name: 'A', models: { plain: { id: 'plain', reasoning: false } } } }, new Map()),
    { ...common, provider: 'Google', providerId: 'google', reasoningOptions: [{ type: 'toggle' }] },
  ]);
  let calls = 0;
  const previous = installJudgmentPort({ model: 'synthetic', async ask() { calls++; throw new Error('Unexpected metadata judgment'); } });
  try {
    await prepareReasoningEffort('high', { modelId: 'alias', provider: 'a' }, 'test');
    expect(resolveReasoningEffortSpec({ modelId: 'alias', provider: 'a' })).toMatchObject({ source: 'catalog', kind: 'effort', values: ['low', 'high'] });
    expect(resolveReasoningEffortSpec({ modelId: 'alias', provider: 'b' })).toMatchObject({ source: 'catalog', kind: 'budget_tokens', canDisableReasoning: true });
    expect(resolveReasoningEffortSpec({ modelId: 'plain', provider: 'a' }).kind).toBe('unavailable');
    expect(resolveReasoningEffortSpec({ modelId: 'alias', provider: 'gemini' }).kind).toBe('toggle');
    expect(resolveReasoningEffortSpec({ modelId: 'alias' }).source).toBe('fallback');
    expect(knownCatalogMaxOutput('a', 'alias')).toBe(16000);
    expect(knownCatalogMaxOutput('b', 'alias')).toBe(32000);
    expect(knownCatalogMaxOutput('unknown', 'alias')).toBeUndefined();
    expect(calls).toBe(0);
  } finally { installJudgmentPort(previous); installCatalogModelFacts([]); }
});

test('Anthropic requests use repository output and reasoning facts while live endpoint limits take precedence', async () => {
  const { AnthropicProvider, documentedMaxOutput } = await import('../sdk/src/platform/providers/anthropic.js');
  const { installJudgmentPort } = await import('@goodvibes-jev/engine/errors');
  installCatalogModelFacts([{ id: 'opaque-model', name: 'Opaque', provider: 'Anthropic', providerId: 'anthropic',
    providerEnvVars: [], pricing: null, tier: 'paid', maxOutputTokens: 16000,
    reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] }]);
  let judgments = 0;
  const previous = installJudgmentPort({ model: 'synthetic', async ask() { judgments++; throw new Error('Unexpected metadata judgment'); } });
  const originalFetch = globalThis.fetch, bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'opaque-model', max_tokens: 8000 }] });
    if (!url.endsWith('/messages')) throw new Error('Unexpected transport');
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}', 'data: {"type":"message_stop"}'].join('\n\n'));
  }) as unknown as typeof fetch;
  try {
    const provider = new AnthropicProvider('synthetic-key');
    expect(documentedMaxOutput('opaque-model')).toBe(16000);
    await provider.chat({ model: 'opaque-model', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 50000, reasoningEffort: 'high' });
    expect(bodies[0]).toMatchObject({ max_tokens: 16000, output_config: { effort: 'high' } });
    expect((await provider.refreshModels(true)).source).toBe('live');
    await provider.chat({ model: 'opaque-model', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 50000, reasoningEffort: 'high' });
    expect(bodies[1]).toMatchObject({ max_tokens: 8000, output_config: { effort: 'high' } });
    expect(judgments).toBe(0);
  } finally { globalThis.fetch = originalFetch; installJudgmentPort(previous); installCatalogModelFacts([]); }
});
