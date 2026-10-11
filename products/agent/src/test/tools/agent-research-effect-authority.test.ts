import { createHash } from 'node:crypto';
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, type ArtifactCreateInput, type ArtifactRecord } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import type { LLMProvider } from '@goodvibes-jev/engine/sdk/platform/providers';
import { createAgentResearchRunsTool } from '../../tools/agent-research-runs-tool.ts';
import { createAgentResearchSourcesTool } from '../../tools/agent-research-sources-tool.ts';
import { createAgentResearchReportTool } from '../../tools/agent-research-report-tool.ts';
import { createAgentResearchTool } from '../../tools/agent-research-tool.ts';
import { createAgentModelCompareTool } from '../../tools/agent-model-compare-tool.ts';
import type { AgentModelCompareArtifactStore } from '../../tools/agent-model-compare-types.ts';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry } from '../../agent/research-source-registry.ts';
import { effectAdmissionFixture } from '../helpers/effect-admission.ts';
import { ordinaryResearchOwner, researchScreeningFixture, exactSensitiveSpans, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { bindAgentResearchSourceOwner, createAgentResearchReportProjector } from '../../agent/protected-research-report.ts';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';

afterAll(cleanupResearchScreeningFixtures);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function paths() { const root = mkdtempSync(join(tmpdir(), 'research-effect-authority-')); roots.push(root); return { resolveProjectPath: (...parts: string[]) => join(root, ...parts) }; }
function deferred() { let resolve: () => void = () => {}; const promise = new Promise<void>(finish => { resolve = finish; }); return { promise, resolve }; }
async function awaitStarted(entered: ReturnType<typeof deferred>, pending: Promise<{ success: boolean; error?: string }>): Promise<void> {
  await Promise.race([entered.promise, pending.then(result => { throw new Error(`Synthetic operation ended before its awaited I/O: ${result.error ?? result.success}`); })]);
}
function compareFixture(options: { mode?: PermissionMode; artifactText?: string; artifactMetadata?: Record<string, unknown>; sourceOwner?: ReturnType<typeof ordinaryResearchOwner> | null;
  beforeChat?: () => Promise<void>; beforeModels?: () => Promise<void>; beforeCreate?: () => Promise<void> } = {}) {
  const owner = effectAdmissionFixture(options.mode);
  if (options.sourceOwner !== null) bindAgentResearchSourceOwner(owner.registry, options.sourceOwner ?? ordinaryResearchOwner());
  let writes = 0; let chats = 0; let drained = 0; let backendGetterReads = 0;
  const record: ArtifactRecord = { id: 'source-1', kind: 'document', mimeType: 'text/plain', sizeBytes: 16, sha256: createHash('sha256').update(options.artifactText ?? 'Synthetic source content.').digest('hex'), createdAt: 1,
    acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata: { purpose: 'synthetic', ...options.artifactMetadata }, contentPath: '/synthetic/source', metadataPath: '/synthetic/source-metadata' };
  let current = record;
  let content = options.artifactText ?? 'Synthetic source content.';
  const inputs: ArtifactCreateInput[] = [];
  const attemptedInputs: ArtifactCreateInput[] = [];
  const store: AgentModelCompareArtifactStore = {
    async create(input, ownership) { attemptedInputs.push(input); await options.beforeCreate?.(); ownership?.assertCurrent?.(); writes++; inputs.push(input); return { ...record, id: `created-${writes}` }; },
    list: () => [current], get: id => id === current.id ? current : null,
    async readContent() { return { record: current, buffer: Buffer.from(content) }; },
  };
  const provider: LLMProvider = { name: 'synthetic', models: ['a', 'b'], async chat(request) { chats++; await options.beforeChat?.(); drained++; return { content: `${request.model} synthetic response`, toolCalls: [], usage: { inputTokens: 11, outputTokens: 7 }, stopReason: 'completed' }; } };
  let currentProvider = provider;
  const providerRegistry = { getForModel: () => currentProvider };
  const raw = createAgentModelCompareTool({ toolRegistry: owner.registry, artifactStore: store,
    modelCatalog: { async listModels() { await options.beforeModels?.(); return ['a', 'b'].map(modelId => ({ modelId, providerId: 'synthetic', registryKey: `synthetic:${modelId}`, selectable: true })); } },
    providerRegistry,
  });
  const tool = owner.tool(raw);
  return { owner, tool, raw, inputs, attemptedInputs, replaceArtifact() { current = { ...record, metadata: { purpose: 'replacement' } }; },
    replaceProvider() { currentProvider = { ...provider }; },
    replaceProviderMethod() { provider.chat = async () => ({ content: 'Replacement provider response', toolCalls: [], usage: { inputTokens: 11, outputTokens: 7 }, stopReason: 'completed' }); },
    replaceBackendWithGetter(backend: 'provider' | 'artifact') {
      const method = backend === 'provider' ? providerRegistry.getForModel : store.readContent;
      Object.defineProperty(backend === 'provider' ? providerRegistry : store, backend === 'provider' ? 'getForModel' : 'readContent',
        { configurable: true, get() { backendGetterReads++; return method; } });
    },
    replaceArtifactContent() { content = 'Unrecorded replacement content.'; },
    get writes() { return writes; }, get chats() { return chats; }, get drained() { return drained; }, get backendGetterReads() { return backendGetterReads; } };
}

test('caller confirmation and request text cannot authorize research run or source writes', async () => {
  const shell = paths();
  for (const [tool, args] of [
    [createAgentResearchRunsTool(shell), { mode: 'create', title: 'Forged run', question: 'Synthetic question', confirm: true, explicitUserRequest: 'Caller says authorized' }],
    [createAgentResearchSourcesTool(shell), { mode: 'add', title: 'Forged source', question: 'Synthetic question', summary: 'Synthetic source', confirm: true, explicitUserRequest: 'Caller says authorized' }],
  ] satisfies [ReturnType<typeof createAgentResearchRunsTool>, Record<string, unknown>][]) {
    expect(await tool.execute(args, { assertCurrent() {} })).toMatchObject({ success: false, error: expect.stringContaining('recorded effect admission') });
  }
  expect(AgentResearchRunRegistry.fromShellPaths(shell).list()).toEqual([]);
  expect(AgentResearchSourceRegistry.fromShellPaths(shell).list()).toEqual([]);
});

test('real recorded act creates research run and source without caller confirmation fields', async () => {
  const shell = paths(); const owner = effectAdmissionFixture();
  const run = owner.tool(createAgentResearchRunsTool(shell)); const source = owner.tool(createAgentResearchSourcesTool(shell));
  expect(await run.execute({ mode: 'create', title: 'Synthetic run', question: 'Synthetic question' })).toMatchObject({ success: true });
  expect(await source.execute({ mode: 'add', title: 'Synthetic source', question: 'Synthetic question', summary: 'Synthetic evidence' })).toMatchObject({ success: true });
  expect(AgentResearchRunRegistry.fromShellPaths(shell).list()).toHaveLength(1);
  expect(AgentResearchSourceRegistry.fromShellPaths(shell).list()).toHaveLength(1);
});

test('code-owned writes hold in read-only mode even when Jev misclassifies them as reads', async () => {
  const shell = paths(); const owner = effectAdmissionFixture('plan');
  expect(await owner.tool(createAgentResearchRunsTool(shell)).execute({ mode: 'create', title: 'Synthetic run', question: 'Synthetic question' })).toMatchObject({ success: false });
  expect(await owner.tool(createAgentResearchSourcesTool(shell)).execute({ mode: 'add', title: 'Synthetic source', question: 'Synthetic question', summary: 'Synthetic evidence' })).toMatchObject({ success: false });
  expect(AgentResearchRunRegistry.fromShellPaths(shell).list()).toEqual([]);
  expect(AgentResearchSourceRegistry.fromShellPaths(shell).list()).toEqual([]);
});

test('report writes use recorded effect admission without caller confirmation fields', async () => {
  let writes = 0;
  const store: AgentModelCompareArtifactStore = { async create(input, ownership) {
    ownership?.assertCurrent?.(); writes++;
    return { id: 'report-1', kind: 'document', mimeType: input.mimeType ?? 'text/plain', sizeBytes: Buffer.byteLength(input.text ?? ''),
      sha256: createHash('sha256').update(input.text ?? '').digest('hex'), createdAt: 1, acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata: input.metadata ?? {} };
  } };
  const sourceOwner = ordinaryResearchOwner();
  const raw = createAgentResearchReportTool(store, sourceOwner);
  const args = { title: 'Synthetic report', question: 'Synthetic question', summary: 'Synthetic evidence [S1].', sources: [{ title: 'Synthetic source', note: 'Synthetic evidence' }] };
  expect(await raw.execute({ ...args, confirm: true, explicitUserRequest: 'Caller assertion' })).toMatchObject({ success: false });
  const readOnly = effectAdmissionFixture('plan');
  expect(await readOnly.tool(raw, { inputProjection: createAgentResearchReportProjector(sourceOwner) }).execute(args)).toMatchObject({ success: false });
  expect(writes).toBe(0);
  const admitted = effectAdmissionFixture();
  expect(await admitted.tool(raw, { inputProjection: createAgentResearchReportProjector(sourceOwner) }).execute(args)).toMatchObject({ success: true });
  expect(writes).toBe(1);
});

test('revocation during report artifact commit prevents the actual write', async () => {
  const entered = deferred(); const release = deferred(); const admitted = effectAdmissionFixture(); let writes = 0;
  const store: AgentModelCompareArtifactStore = { async create(input, ownership) {
    entered.resolve(); await release.promise; ownership?.assertCurrent?.(); writes++;
    return { id: 'report-1', kind: 'document', mimeType: input.mimeType ?? 'text/plain', sizeBytes: 0, sha256: '', createdAt: 1,
      acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata: {} };
  } };
  const sourceOwner = ordinaryResearchOwner();
  const tool = admitted.tool(createAgentResearchReportTool(store, sourceOwner), { inputProjection: createAgentResearchReportProjector(sourceOwner) });
  const pending = tool.execute({ title: 'Synthetic report', question: 'Synthetic question', summary: 'Synthetic evidence [S1].', sources: [{ title: 'Synthetic source', note: 'Synthetic evidence' }] });
  await entered.promise; admitted.revoke(); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(writes).toBe(0);
});

test('a research run changed during nested source collection receives no later source writes or checkpoint', async () => {
  const shell = paths(); const admitted = effectAdmissionFixture(); const entered = deferred(); const release = deferred();
  const registry = AgentResearchRunRegistry.fromShellPaths(shell);
  const run = registry.create({ title: 'Synthetic run', question: 'Synthetic question' });
  const tool = admitted.tool(createAgentResearchTool({ toolRegistry: admitted.registry, commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: { shellPaths: shell }, platform: {} } as CommandContext,
    webSearchTool: { definition: { name: 'web_search', description: 'Synthetic source collection', parameters: { type: 'object', additionalProperties: true } },
      async execute() { entered.resolve(); await release.promise; return { success: true, output: JSON.stringify({ results: [{ url: 'https://example.test/source', title: 'Synthetic source', snippet: 'Synthetic evidence' }] }) }; } },
  }));
  const pending = tool.execute({ action: 'runner', runId: run.id });
  await awaitStarted(entered, pending); registry.pause(run.id, 'Synthetic external pause'); release.resolve();
  expect(await pending).toMatchObject({ success: false });
  expect(registry.get(run.id)?.status).toBe('paused');
  expect(AgentResearchSourceRegistry.fromShellPaths(shell).list()).toEqual([]);
});

test('an existing planned run without a note starts and checkpoints under recorded runner admission', async () => {
  const shell = paths(); const admitted = effectAdmissionFixture(); const registry = AgentResearchRunRegistry.fromShellPaths(shell);
  const run = registry.create({ title: 'Synthetic existing run', question: 'Synthetic question' });
  const tool = admitted.tool(createAgentResearchTool({ toolRegistry: admitted.registry, commandRegistry: {} as CommandRegistry,
    commandContext: { workspace: { shellPaths: shell }, platform: {} } as CommandContext,
    webSearchTool: { definition: { name: 'web_search', description: 'Synthetic source collection', parameters: { type: 'object', additionalProperties: true } },
      async execute() { return { success: true, output: JSON.stringify({ results: [{ url: 'https://example.test/source', title: 'Synthetic source', snippet: 'Synthetic evidence' }] }) }; } },
  }));
  expect(await tool.execute({ action: 'runner', runId: run.id })).toMatchObject({ success: true });
  expect(registry.get(run.id)).toMatchObject({ status: 'running', phase: 'reading' });
  expect(AgentResearchSourceRegistry.fromShellPaths(shell).list()).toHaveLength(1);
});

test('metered candidate admission records its actual full model, prompt and token request', async () => {
  const f = compareFixture();
  expect(await f.tool.execute({ mode: 'run', artifactId: 'source-1', prompt: 'Compare this synthetic evidence.', maxTokens: 23 })).toMatchObject({ success: true });
  expect(f.chats).toBe(2); expect(f.writes).toBe(1);
  const candidateReadings = f.owner.port.requests.filter(request => JSON.stringify(request.state).includes('agent_model_compare_candidate'));
  expect(candidateReadings.length).toBeGreaterThan(0);
  const states = candidateReadings.map(request => JSON.stringify(request.state)).join('\n');
  expect(states).toContain('Synthetic source content.'); expect(states).toContain('metered'); expect(states).toContain('23');
  expect(states).toContain('synthetic:a'); expect(states).toContain('synthetic:b');
});

test('admitted comparison preview stays available without metered sends or writes, including read-only mode', async () => {
  for (const mode of ['prompt', 'plan'] as const) {
    const f = compareFixture({ mode });
    expect(await f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison', preview: true })).toMatchObject({ success: true, output: expect.stringContaining('preview') });
    expect(f.chats).toBe(0); expect(f.writes).toBe(0);
  }
});

test('revocation while selecting candidate models prevents all provider sends and persistence', async () => {
  const started = deferred(); const release = deferred();
  const f = compareFixture({ async beforeModels() { started.resolve(); await release.promise; } });
  const pending = f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison' });
  await started.promise; f.owner.revoke(); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});

test('replacement of the captured research source owner retires comparison work before provider sends', async () => {
  const started = deferred(); const release = deferred();
  const f = compareFixture({ async beforeModels() { started.resolve(); await release.promise; } });
  bindAgentResearchSourceOwner(f.owner.registry, ordinaryResearchOwner());
  const pending = f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison' });
  await started.promise; bindAgentResearchSourceOwner(f.owner.registry, researchScreeningFixture().owner); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});

test('changed source artifacts retire each child before it can publish or save comparison outputs', async () => {
  const started = deferred(); const release = deferred();
  const f = compareFixture({ async beforeChat() { started.resolve(); await release.promise; } });
  const pending = f.tool.execute({ mode: 'run', artifactId: 'source-1', prompt: 'Synthetic comparison' });
  await started.promise; f.replaceArtifact(); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(f.writes).toBe(0);
});

test.each(['owner', 'method'] as const)('changed provider %s during a metered response prevents comparison publication', async mutation => {
  const started = deferred(); const release = deferred();
  const f = compareFixture({ async beforeChat() { started.resolve(); await release.promise; } });
  const pending = f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison' });
  await started.promise;
  if (mutation === 'owner') f.replaceProvider(); else f.replaceProviderMethod();
  release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(f.writes).toBe(0); expect(f.drained).toBe(f.chats);
});

test.each(['provider', 'artifact'] as const)('a late %s backend accessor is held without invoking it after metered waits', async backend => {
  const entered = deferred(); const release = deferred();
  const f = compareFixture({ async beforeChat() { entered.resolve(); await release.promise; } });
  const pending = f.tool.execute({ mode: 'run', artifactId: 'source-1', prompt: 'Synthetic comparison' });
  await awaitStarted(entered, pending); f.replaceBackendWithGetter(backend); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(f.backendGetterReads).toBe(0);
  expect(f.writes).toBe(0); expect(f.drained).toBe(f.chats);
});

test('cancellation drains ignored provider waits and refuses all later artifact writes', async () => {
  const started = deferred(); const release = deferred(); const controller = new AbortController();
  const f = compareFixture({ async beforeChat() { started.resolve(); await release.promise; } });
  const pending = f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison' }, { signal: controller.signal });
  await started.promise; controller.abort(); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(f.writes).toBe(0); expect(f.drained).toBe(f.chats);
});

test('revocation during comparison artifact commit prevents writes and retired result caching', async () => {
  const entered = deferred(); const release = deferred();
  const f = compareFixture({ async beforeCreate() { entered.resolve(); await release.promise; } });
  const pending = f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison' });
  await entered.promise; f.owner.revoke(); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(f.writes).toBe(0);
  const comparisonId = f.attemptedInputs[0]?.metadata?.comparisonId;
  expect(typeof comparisonId).toBe('string');
  expect(await f.tool.execute({ mode: 'reveal', comparisonId })).toMatchObject({ success: false });
});

test('protected source text is refused at actual child admission before any metered provider send', async () => {
  const f = compareFixture({ artifactText: 'Authorization: Bearer sk-proj-SyntheticProtectedCredentialDoNotSend1234567890' });
  expect(await f.tool.execute({ mode: 'run', artifactId: 'source-1', prompt: 'Synthetic comparison' })).toMatchObject({ success: false });
  expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});

test('private source metadata is locally screened in full before hosted candidate admission', async () => {
  const privateText = 'Private customer account memo';
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([privateText]) });
  const f = compareFixture({ sourceOwner: screening.owner, artifactMetadata: { privateClientMemo: privateText } });
  expect(await f.tool.execute({ mode: 'run', artifactId: 'source-1', prompt: 'Synthetic comparison' })).toMatchObject({ success: false });
  expect(screening.calls.some(call => JSON.stringify(call.body).includes(privateText))).toBe(true);
  expect(f.owner.port.requests.some(request => JSON.stringify(request.state).includes('agent_model_compare_candidate'))).toBe(false);
  expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});

test('an unconfigured local privacy owner holds metered candidates before hosted admission while preview remains usable', async () => {
  const f = compareFixture({ sourceOwner: null });
  expect(await f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison', preview: true })).toMatchObject({ success: true });
  expect(await f.tool.execute({ mode: 'run', artifactId: 'source-1', prompt: 'Synthetic comparison' })).toMatchObject({ success: false });
  expect(f.owner.port.requests.some(request => JSON.stringify(request.state).includes('agent_model_compare_candidate'))).toBe(false);
  expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});

test('source replacement during local candidate screening prevents hosted admission and provider sends', async () => {
  const entered = deferred(); const release = deferred();
  const screening = researchScreeningFixture({ async beforeProposal() { entered.resolve(); await release.promise; } });
  const f = compareFixture({ sourceOwner: screening.owner });
  const pending = f.tool.execute({ mode: 'run', artifactId: 'source-1', prompt: 'Synthetic comparison' });
  await entered.promise; f.replaceArtifact(); release.resolve();
  expect(await pending).toMatchObject({ success: false });
  expect(f.owner.port.requests.some(request => JSON.stringify(request.state).includes('agent_model_compare_candidate'))).toBe(false);
  expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});

test('actual privacy receipt revocation during provider waits prevents comparison publication', async () => {
  const entered = deferred(); const release = deferred(); const screening = researchScreeningFixture();
  const f = compareFixture({ sourceOwner: screening.owner, async beforeChat() { entered.resolve(); await release.promise; } });
  const pending = f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison' });
  await entered.promise; screening.lifetime.abort(); release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(f.writes).toBe(0); expect(f.drained).toBe(f.chats);
});

test('unrecorded source content changes are refused before metered provider sends', async () => {
  const f = compareFixture(); f.replaceArtifactContent();
  expect(await f.tool.execute({ mode: 'run', artifactId: 'source-1', prompt: 'Synthetic comparison' })).toMatchObject({ success: false });
  expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});

test.each(['overwrite', 'symlink'] as const)('native artifact %s during provider waits retires comparison publication', async mutation => {
  const root = mkdtempSync(join(tmpdir(), 'native-comparison-source-')); roots.push(root);
  const store = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const clock = spyOn(Date, 'now').mockReturnValue(1);
  const source = await (async () => { try { return await store.create({ kind: 'document', mimeType: 'text/plain', text: 'Synthetic physical source.', retentionMs: 0 }); } finally { clock.mockRestore(); } })();
  const record = store.getRecord(source.id)!;
  const entered = deferred(); const release = deferred(); const owner = effectAdmissionFixture();
  bindAgentResearchSourceOwner(owner.registry, ordinaryResearchOwner());
  const provider: LLMProvider = { name: 'synthetic', models: ['a', 'b'], async chat() { entered.resolve(); await release.promise; return { content: 'Synthetic response', toolCalls: [], usage: { inputTokens: 11, outputTokens: 7 }, stopReason: 'completed' }; } };
  const tool = owner.tool(createAgentModelCompareTool({ toolRegistry: owner.registry, artifactStore: store,
    modelCatalog: { listModels: () => ['a', 'b'].map(modelId => ({ modelId, providerId: 'synthetic', registryKey: `synthetic:${modelId}`, selectable: true })) },
    providerRegistry: { getForModel: () => provider },
  }));
  const pending = tool.execute({ mode: 'run', artifactId: source.id, prompt: 'Synthetic comparison' });
  await awaitStarted(entered, pending);
  if (mutation === 'overwrite') writeFileSync(record.contentPath, 'Unrecorded physical replacement.');
  else { const outside = join(root, 'outside-source'); writeFileSync(outside, 'Unrecorded physical replacement.'); unlinkSync(record.contentPath); symlinkSync(outside, record.contentPath); }
  release.resolve();
  expect(await pending).toMatchObject({ success: false }); expect(store.list()).toHaveLength(1);
});

test('replacement of a native artifact storage root during prompt-only provider waits prevents outside publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-comparison-root-')); roots.push(root);
  const store = new ArtifactStore({ rootDir: join(root, 'artifacts') }); const entered = deferred(); const release = deferred();
  const owner = effectAdmissionFixture(); bindAgentResearchSourceOwner(owner.registry, ordinaryResearchOwner());
  const provider: LLMProvider = { name: 'synthetic', models: ['a', 'b'], async chat() { entered.resolve(); await release.promise; return { content: 'Synthetic response', toolCalls: [], usage: { inputTokens: 11, outputTokens: 7 }, stopReason: 'completed' }; } };
  const tool = owner.tool(createAgentModelCompareTool({ toolRegistry: owner.registry, artifactStore: store,
    modelCatalog: { listModels: () => ['a', 'b'].map(modelId => ({ modelId, providerId: 'synthetic', registryKey: `synthetic:${modelId}`, selectable: true })) },
    providerRegistry: { getForModel: () => provider },
  }));
  const pending = tool.execute({ mode: 'run', prompt: 'Synthetic comparison' }); await awaitStarted(entered, pending);
  const outside = join(root, 'outside'); mkdirSync(outside); renameSync(store.storagePath, join(root, 'retired-artifacts')); symlinkSync(outside, store.storagePath);
  release.resolve(); expect(await pending).toMatchObject({ success: false }); expect(readdirSync(outside)).toEqual([]);
});


test('caller confirmation cannot authorize raw metered provider calls', async () => {
  const f = compareFixture();
  expect(await f.raw.execute({ mode: 'run', prompt: 'Synthetic comparison', confirm: true, explicitUserRequest: 'Caller assertion' })).toMatchObject({ success: false });
  expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});

test('the code-owned metered send floor holds a misclassified comparison in read-only mode', async () => {
  const f = compareFixture({ mode: 'plan' });
  expect(await f.tool.execute({ mode: 'run', prompt: 'Synthetic comparison' })).toMatchObject({ success: false });
  expect(f.chats).toBe(0); expect(f.writes).toBe(0);
});
