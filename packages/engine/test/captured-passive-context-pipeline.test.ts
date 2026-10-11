/** Actual captured contract -> AgentManager -> AgentOrchestrator -> scripted provider.
 * The only semantic provider is in-process. Owner code-index methods are tripwires.
 */
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { codeChunkView } from '../sdk/src/platform/state/batteries/code-search-rerank.js';
import { MemoryStore, MemoryRegistry } from '../sdk/src/platform/state/index.js';
import { MemoryEmbeddingProviderRegistry } from '../sdk/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../sdk/src/platform/config/index.js';
import { createClientRuntimeServices } from '../sdk/src/platform/runtime/bootstrap.js';
import { RuntimeEventBus, createRuntimeStore } from '../sdk/src/platform/runtime/state.js';
import { resumeContracts } from '../sdk/src/platform/runtime/contract-composition.js';
import { createLaunchTolerantProviderRegistry } from '../sdk/src/platform/providers/index.js';
import { createContractRunner } from '../sdk/src/platform/contract/runner.js';
import { ContractStore } from '../sdk/src/platform/contract/store.js';
import { createAgentManagerDecompositionRunner } from '../sdk/src/platform/agents/planner-decomposition-runner.js';
import { createOrchestrationEngine } from '../sdk/src/platform/orchestration/engine.js';
import type { LLMProvider } from '../sdk/src/platform/providers/interface.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './contract/runner-support.js';
import { plannerOutput } from './contract/plan-support.js';
import { probeCapturedExecAvailability } from '../sdk/src/platform/tools/exec/captured-exec.js';

const PRIVATE = 'PRIVATE_PASSIVE_BYTES_MUST_NEVER_REACH_A_MODEL';
const ORIGINAL = 'PASSIVE_ALLOWED_ORIGINAL';
const REVISED = 'PASSIVE_ALLOWED_REVISED';
const availability = await probeCapturedExecAvailability();
test('required passive mutable context proof cannot skip captured execution', () => {
  if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT !== undefined) {
    expect(process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT).toBe('1');
    expect(availability.available, JSON.stringify(availability)).toBe(true);
  }
});

for (const scenario of ['allowed', 'feature-off', 'storage-off', 'zero-budget', 'mutable', 'cancel-embedding', 'revoke-embedding', 'retry-revoked', 'embedding-retry-revoked'] as const) {
  test.skipIf(scenario === 'mutable' && !availability.available)(`captured passive context actual contract pipeline (${scenario})`, async () => {
    const root = makeRepo();
    // Only the two source fixtures belong in this proof corpus.
    rmSync(join(root, 'README.md'));
    rmSync(join(root, '.gitignore'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'allowed.ts'), `export function ${ORIGINAL}() { return 'CSV parser'; }\n`);
    writeFileSync(join(root, 'private.ts'), `export function ${PRIVATE}() { return 'CSV parser'; }\n`);
    const commit = spawnSync('git', ['-C', root, 'add', '.']);
    expect(commit.status).toBe(0);
    expect(spawnSync('git', ['-C', root, 'commit', '-qm', 'source fixtures']).status).toBe(0);
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
    config.set('permissions.engine', 'policy-engine');
    config.set('permissions.mode', 'prompt');
    config.set('behavior.autoApprove', false);
    config.set('contract.isolation', 'worktree');
    config.set('tools.autoHeal', false);
    config.set('agents.passiveInjection.knowledge', true);
    config.set('agents.passiveInjection.code', scenario !== 'feature-off');
    const codeIndexStorageEnabled = scenario !== 'storage-off';
    config.set('agents.passiveInjection.budgetTokens', scenario === 'zero-budget' ? 0 : 1200);
    config.set('agents.passiveInjection.relevanceFloor', 0);
    config.set('agents.passiveInjection.codeLimit', 10);
    const bus = new RuntimeEventBus();
    const runtime = createClientRuntimeServices({
      surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
      runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
      providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }),
    });
    await resumeContracts(runtime.contractRunner, root);
    const judgments: string[] = [];
    const unexpectedCodeReadings: string[] = [];
    // Script only the exact source fixtures this pipeline owns. A new source or
    // changed projection must be reviewed rather than inheriting a blanket yes.
    const authoredCode = [
      ['allowed.ts', ORIGINAL, 'function', `export function ${ORIGINAL}() { return 'CSV parser'; }`],
      ['allowed.ts', REVISED, 'function', `export function ${REVISED}() { return 'CSV parser'; }`],
      ['generated.ts', 'PASSIVE_GENERATED', 'function', "export function PASSIVE_GENERATED() { return 'CSV parser'; }"],
      ['command.ts', 'PASSIVE_COMMAND', 'function', 'export function PASSIVE_COMMAND() { return 1; }'],
      ['src/csv.ts', 'parse', 'constant', 'export const parse = () => [];'],
    ] as const;
    const candidates = authoredCode.flatMap(([path, symbol, kind, code]) => [
      codeChunkView({ path, symbol, kind, startLine: 1, endLine: 1 }, code),
      codeChunkView({ path, symbol: '', kind: 'window', startLine: 1, endLine: 2 }, `${code}\n`),
    ]);
    const relevance = fakePort((name, question, state) => {
      const value = state as { query?: unknown; candidate?: unknown };
      const candidate = candidates.find(candidate => isDeepStrictEqual(candidate, value.candidate));
      if (name !== 'match' || question.type !== 'noul' || typeof value.query !== 'string'
        || value.query.length === 0 || !candidate) {
        const diagnostic = JSON.stringify({ name, question, state });
        unexpectedCodeReadings.push(diagnostic);
        throw new Error(`Unexpected captured passive code reading: ${diagnostic}`);
      }
      return noulAnswer(0.99);
    });
    const semantic = runnerPort((context) => {
      judgments.push(JSON.stringify(context.state));
      return context.name === 'family' ? choiceAnswer(context.question, 'file-mutation', 0.99) : undefined;
    });
    const previous = installJudgmentPort({ ...semantic.port, ask(request) {
      if (request.context?.battery !== 'engine.state.code-search') return semantic.port.ask(request);
      judgments.push(JSON.stringify(request.state));
      if (request.context.site !== 'state.code-injection-relevance') {
        const diagnostic = JSON.stringify(request.context);
        unexpectedCodeReadings.push(diagnostic);
        throw new Error(`Unexpected captured passive code site: ${diagnostic}`);
      }
      return relevance.port.ask(request);
    } });
    await runtime.userPermissionRuleStore.add({
      rule: { id: 'deny-original-private-passive', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [join(root, 'private.ts')] },
      createdAt: Date.now(), tier: 'path', tool: 'read',
    });
    expect(await runtime.permissionManager.readAccess(join(root, 'private.ts'))).toBe('restricted');
    expect(await runtime.permissionManager.readAccess(join(root, 'allowed.ts'))).toBe('allow');
    const embeddings: string[] = [];
    let embeddingEntered = false;
    let releaseEmbedding!: () => void;
    const embeddingReleased = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
    let retryRejected = 0;
    let embeddingDispatches = 0;
    let embeddingRetryDispatches = 0;
    let embeddingRetryRejected = 0;
    const revokeAllowed = () => runtime.userPermissionRuleStore.add({
      rule: { id: 'revoke-original-allowed-passive', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [join(root, 'allowed.ts')] },
      createdAt: Date.now(), tier: 'path', tool: 'read',
    });
    const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager: config });
    memoryEmbeddingRegistry.register({
      id: 'captured-passive-semantic-fixture', label: 'Scripted semantic fixture', dimensions: 384, capturedInputAdmission: 'per-attempt',
      deterministic: false, local: true,
      async embed(request) {
        expect(request.beforeAttempt).toBeFunction();
        const beforeAttempt = request.beforeAttempt!;
        await beforeAttempt();
        embeddingDispatches++;
        embeddings.push(request.text);
        if (scenario === 'embedding-retry-revoked') {
          await revokeAllowed();
          expect(await runtime.permissionManager.readAccess(join(root, 'allowed.ts'))).toBe('restricted');
          const retry = async () => {
            await beforeAttempt();
            embeddingRetryDispatches++;
            embeddingDispatches++;
          };
          await expect(retry()).rejects.toThrow();
          embeddingRetryRejected++;
          throw new Error('Scripted embedding retry stopped before a revoked transport submission');
        }
        if ((scenario === 'cancel-embedding' || scenario === 'revoke-embedding') && request.text.includes(ORIGINAL)) {
          embeddingEntered = true;
          // Uncooperative provider returns after cancellation/revocation.
          await embeddingReleased;
        }
        const vector = new Float32Array(request.dimensions); vector[0] = 1;
        return { vector, dimensions: request.dimensions };
      },
    }, { makeDefault: true });
    const memoryStore = new MemoryStore(':memory:', { embeddingRegistry: memoryEmbeddingRegistry, enableVectorIndex: false });
    await memoryStore.init();
    const memoryRegistry = new MemoryRegistry(memoryStore);
    let ownerStats = 0; let ownerSearch = 0; let ownerReindex = 0;
    const requests: { planner: boolean; prompt: string; text: string }[] = [];
    const toolResults: string[] = [];
    const execResults: string[] = [];
    let memberCalls = 0;
    const write = (path: string, content: string) => ({ name: 'write', arguments: { files: [{ path, mode: 'overwrite', content }] } });
    const steps = scenario === 'mutable' ? [
      write('allowed.ts', `export function ${REVISED}() { return 'CSV parser'; }\n`),
      write('generated.ts', "export function PASSIVE_GENERATED() { return 'CSV parser'; }\n"),
      { name: 'exec', arguments: { commands: [{ cmd: 'rm generated.ts; printf "export function PASSIVE_COMMAND() { return 1; }\\n" > command.ts' }] } },
      write('src/csv.ts', 'export const parse = () => [];\n'),
    ] : [write('src/csv.ts', 'export const parse = () => [];\n')];
    const provider: LLMProvider = {
      name: 'passive-pipeline-fixture', models: ['fixture'], isConfigured: () => true,
      async chat(request) {
        const planner = !request.tools?.some((tool) => tool.name === 'write');
        requests.push({ planner, prompt: request.systemPrompt ?? '', text: JSON.stringify(request) });
        for (const message of request.messages) if (message.role === 'tool' && typeof message.content === 'string') {
          toolResults.push(message.content);
          if (message.name === 'exec') execResults.push(message.content);
        }
        if (scenario === 'retry-revoked') {
          expect(request.beforeAttempt).toBeFunction();
          await revokeAllowed();
          await expect(Promise.resolve().then(() => request.beforeAttempt!())).rejects.toThrow();
          retryRejected++;
          throw new Error('Scripted retry stopped before a revoked provider submission');
        }
        if (planner) return { content: plannerOutput(oneUnitPlan(1)), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
        const step = steps[memberCalls++];
        return { content: step ? '' : 'Created src/csv.ts. The parser works.', toolCalls: step ? [{ id: `step-${memberCalls}`, ...step }] : [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: step ? 'tool_call' : 'completed' };
      },
    };
    runtime.providerRegistry.registerRuntimeProvider({ provider, models: [{
      id: 'fixture', provider: provider.name, registryKey: `${provider.name}:fixture`, displayName: 'Fixture', description: 'Synthetic',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard',
    }], replace: true });
    await runtime.providerRegistry.ready();
    const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
    const runner = createContractRunner({
      agentManager: runtime.agentManager, messageBus: runtime.agentMessageBus, runtimeBus: bus,
      configManager: { get: config.get.bind(config), getCategory: ((name: string) => name === 'contract' ? { ...config.getCategory('contract'), gates: [] } : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory },
      projectRoot: root, routeSelector: async () => ({ model: `${provider.name}:fixture`, provider: provider.name, reason: 'in-process passive fixture' }),
      decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager }),
      createEngine: (input) => createOrchestrationEngine({
        agentManager: runtime.agentManager, configManager: config, runtimeBus: bus,
        projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace,
        initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
        contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
        runWorktreeSetup: () => undefined,
      }),
      fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }), priceUsage: () => 0,
      priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-03' }), store,
      readAccessFilter: async (path) => await runtime.permissionManager.readAccess(path) === 'allow',
    });
    runtime.agentManager.setContractRunner(runner);
    runtime.agentOrchestrator.setFeatureFlagManager(runtime.featureFlags);
    runtime.agentOrchestrator.setDependencies({
      ...runtime, memoryRegistry, memoryEmbeddingRegistry, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: runtime.workflow,
      contractRunner: runner, contractHooks: runner.hooks(),
      codeIndex: {
        stats: () => { ownerStats++; throw new Error('captured task consulted owner live index stats'); },
        search: async () => { ownerSearch++; throw new Error('captured task searched owner live index'); },
      },
      isCodeInjectionSettingEnabled: () => codeIndexStorageEnabled,
      codeIndexReindexScheduler: { onToolExecuted: () => { ownerReindex++; } },
    });
    const opens = spyOn(fs, 'openSync');
    let id: string | undefined;
    try {
      id = runner.start({ ask: 'Add a CSV parser module', sessionId: 'passive-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' }).contract.id;
      if (scenario === 'cancel-embedding' || scenario === 'revoke-embedding') {
        await waitFor(() => embeddingEntered || ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'scripted embedding entry', 20_000);
        expect(embeddingEntered).toBe(true);
        if (scenario === 'cancel-embedding') runner.cancel(id, 'cancel pending captured embedding');
        else await revokeAllowed();
        releaseEmbedding();
      }
      await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'passive pipeline settlement', 120_000).catch((error) => { throw new Error(`${error.message}; members=${memberCalls}; agents=${JSON.stringify(runtime.agentManager.list().map(r => ({ status:r.status, error:r.error })))}; toolResults=${toolResults.slice(-4).join(' | ')}`); });
      const result = runner.get(id)!;
      expect(unexpectedCodeReadings).toEqual([]);
      if (scenario === 'cancel-embedding' || scenario === 'revoke-embedding' || scenario === 'retry-revoked' || scenario === 'embedding-retry-revoked') {
        // Drain the late provider result before asserting it never reached chat.
        await runner.join(id);
        expect(unexpectedCodeReadings).toEqual([]);
        expect(result.status).not.toBe('passed');
        expect([ownerStats, ownerSearch, ownerReindex]).toEqual([0, 0, 0]);
        expect(opens.mock.calls.filter(([path]) => String(path).endsWith('/private.ts'))).toHaveLength(0);
        for (const observed of [...embeddings, ...judgments, ...requests.map((r) => r.text)]) expect(observed).not.toContain(PRIVATE);
        if (scenario === 'retry-revoked') {
          expect(retryRejected, `${result.error}; requests=${requests.length}`).toBe(1);
          expect(requests).toHaveLength(1);
          expect(relevance.requests.length).toBeGreaterThan(0);
          expect(requests[0]!.prompt).toContain('## Injected Code Context');
        } else {
          expect(requests).toHaveLength(0);
          expect(embeddings.some((text) => text.includes(ORIGINAL))).toBe(true);
          if (scenario === 'cancel-embedding') expect(result.status).toBe('cancelled');
          if (scenario === 'embedding-retry-revoked') {
            expect(embeddingRetryRejected, result.error).toBe(1);
            expect(embeddingDispatches).toBe(1);
            expect(embeddingRetryDispatches).toBe(0);
            expect(embeddings).toHaveLength(1);
          }
        }
        return;
      }
      expect(result.status, result.error).toBe('passed');
      expect([ownerStats, ownerSearch, ownerReindex]).toEqual([0, 0, 0]);
      // Snapshot capture uses async descriptors. The passive adapter's bounded
      // descriptors are synchronous, and a stored original-path denial must
      // exclude every captured copy before its descriptor can be opened.
      expect(opens.mock.calls.filter(([path]) => String(path).endsWith('/private.ts'))).toHaveLength(0);
      for (const observed of [...embeddings, ...judgments, ...requests.map((r) => r.text)]) expect(observed).not.toContain(PRIVATE);
      const members = requests.filter((request) => !request.planner);
      expect(members.length).toBeGreaterThan(0);
      for (const request of members) expect(request.text).not.toContain('Output withheld');
      expect(toolResults.length).toBeGreaterThanOrEqual(steps.length);
      for (const text of toolResults) {
        let result: { success?: boolean; error?: string };
        try { result = JSON.parse(text); } catch { continue; }
        expect(result.success, text).not.toBe(false);
        expect(result.error, text).toBeUndefined();
      }
      const enabled = scenario === 'allowed' || scenario === 'mutable';
      if (enabled) {
        expect(relevance.requests.length).toBeGreaterThan(0);
        expect(relevance.requests.every(request => request.context?.battery === 'engine.state.code-search'
          && request.context.site === 'state.code-injection-relevance')).toBe(true);
        expect(opens.mock.calls.some(([path]) => String(path).endsWith('/allowed.ts'))).toBe(true);
        expect(embeddings.some((text) => text.includes(ORIGINAL))).toBe(true);
        expect(members[0]!.prompt).toContain('## Injected Code Context');
        // Planner owns the immutable receipt view; member owns its mutable copy.
        expect(requests.find((request) => request.planner)!.prompt).toContain('## Injected Code Context');
        expect(members[0]!.prompt).toContain('allowed.ts:');
        expect(members[0]!.prompt).not.toContain('private.ts:');
        const records = runtime.agentManager.list().filter((record) => record.contractRole === 'unit').flatMap((record) => record.turnInjections ?? []);
        expect(records.some((record) => record.injectedSources.includes('code-index') && record.tokenCost > 0)).toBe(true);
      } else {
        expect(embeddings).toEqual([]);
        expect(opens.mock.calls.filter(([path]) => String(path).endsWith('/allowed.ts'))).toHaveLength(0);
        expect(requests.every((request) => !request.prompt.includes('## Injected Code Context'))).toBe(true);
      }
      if (scenario === 'mutable') {
        expect(execResults.length).toBeGreaterThan(0);
        for (const result of execResults) {
          expect(JSON.parse(result)).toMatchObject({ success: true, sandboxed: true, exit_code: 0 });
        }
        expect(members[1]!.prompt).toContain(REVISED);
        expect(members[1]!.prompt).not.toContain(ORIGINAL);
        expect(members[2]!.prompt).toContain('generated.ts:');
        expect(members[3]!.prompt).not.toContain('generated.ts:');
        expect(members[3]!.prompt).toContain('command.ts:');
        expect(embeddings.some((text) => text.includes(REVISED))).toBe(true);
        expect(embeddings.some((text) => text.includes('PASSIVE_COMMAND'))).toBe(true);
      }
    } finally {
      releaseEmbedding();
      opens.mockRestore();
      if (id) runner.cancel(id, 'fixture cleanup');
      runner.dispose(); if (id) await runner.join(id);
      store.dispose(); memoryStore.close(); runtime.dispose(); installJudgmentPort(previous);
      rmSync(root, { recursive: true, force: true });
    }
  }, 150_000);
}
