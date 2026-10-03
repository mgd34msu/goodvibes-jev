/** Real contract -> planner/member -> AgentManager -> AgentOrchestrator -> tools -> scripted provider. */
import { expect, test } from 'bun:test';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import { createContractRunner } from '../../sdk/src/platform/contract/runner.js';
import { ContractStore } from '../../sdk/src/platform/contract/store.js';
import { createAgentManagerDecompositionRunner } from '../../sdk/src/platform/agents/planner-decomposition-runner.js';
import { createOrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import type { LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

for (const mode of ['normal', 'revoke-map'] as const) test(`actual contract input authority through all construction handoffs (${mode})`, async () => {
  const root = makeRepo();
  writeFileSync(join(root, 'private.ts'), 'export const PRIVATE_GRAPH_MARKER = 1;\n');
  writeFileSync(join(root, 'allowed.ts'), 'export const ALLOWED_GRAPH_MARKER = 1;\n');
  const commit = spawnSync('git', ['-C', root, 'add', '.']); expect(commit.status).toBe(0);
  expect(spawnSync('git', ['-C', root, 'commit', '-qm', 'fixture sources']).status).toBe(0);
  // Dirty user input must remain outside automatic apply-back.
  writeFileSync(join(root, 'allowed.ts'), 'export const ALLOWED_GRAPH_MARKER = 2;\n');
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
  config.set('permissions.engine', 'policy-engine'); config.set('permissions.mode', 'prompt'); config.set('behavior.autoApprove', false);
  config.set('contract.isolation', 'worktree'); config.set('tools.autoHeal', false);
  const bus = new RuntimeEventBus();
  const runtime = createClientRuntimeServices({ surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root, runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip', providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }) });
  const previous = installJudgmentPort(runnerPort((context) => context.name === 'family' ? choiceAnswer(context.question, 'file-mutation', 0.99) : undefined).port);
  await runtime.userPermissionRuleStore.add({ rule: { id: 'deny-original-private', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [join(root, 'private.ts')] }, createdAt: Date.now(), tier: 'path', tool: 'read' });
  const requests: { planner: boolean; text: string }[] = [];
  let plannerCalls = 0; let memberCalls = 0;
  const provider: LLMProvider = { name: 'graph-fixture', models: ['fixture'], isConfigured: () => true, async chat(request) {
    const planner = !request.tools?.some((tool) => tool.name === 'write');
    const turn = planner ? ++plannerCalls : ++memberCalls;
    requests.push({ planner, text: JSON.stringify(request) });
    const toolCalls = turn === 1 ? [{ id: `${planner ? 'planner' : 'member'}-find`, name: 'find', arguments: { queries: [{ id: 'all', mode: 'files', patterns: ['private.ts', 'allowed.ts'] }], output: { format: 'with_preview' } } }]
      : !planner && turn === 2 ? [{ id: 'member-write', name: 'write', arguments: { files: [{ path: 'src/csv.ts', content: 'export const parse = () => [];\n' }] } }]
      : !planner && turn === 3 ? [{ id: 'member-read-generated', name: 'read', arguments: { files: [{ path: 'src/csv.ts' }] } }]
      : [];
    return { content: toolCalls.length ? '' : planner ? plannerOutput(oneUnitPlan(1)) : 'Created src/csv.ts. The parser works.', toolCalls, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: toolCalls.length ? 'tool_call' : 'completed' };
  } };
  runtime.providerRegistry.registerRuntimeProvider({ provider, models: [{ id: 'fixture', provider: provider.name, registryKey: `${provider.name}:fixture`, displayName: 'Fixture', description: 'Synthetic', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard' }], replace: true });
  await runtime.providerRegistry.ready();
  const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
  const runner = createContractRunner({
    agentManager: runtime.agentManager, messageBus: runtime.agentMessageBus, runtimeBus: bus, configManager: { get: config.get.bind(config), getCategory: ((name: string) => name === 'contract' ? { ...config.getCategory('contract'), gates: [] } : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory }, projectRoot: root,
    routeSelector: async () => ({ model: 'graph-fixture:fixture', provider: 'graph-fixture', reason: 'in-process fixture' }),
    decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager }),
    createEngine: (input) => createOrchestrationEngine({ agentManager: runtime.agentManager, configManager: config, runtimeBus: bus, projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace, initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority, contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts, runWorktreeSetup: () => undefined }),
    fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }), priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-03' }), store,
    readAccessFilter: async (path) => await runtime.permissionManager.readAccess(path) === 'allow',
  });
  runtime.agentManager.setContractRunner(runner);
  runtime.agentOrchestrator.setDependencies({ ...runtime, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: runtime.workflow, contractRunner: runner, contractHooks: runner.hooks() });
  let admittedMap = '';
  runtime.agentManager.setExecutor({ async runAgent(record) {
    if (mode === 'revoke-map' && record.template === 'planner') {
      admittedMap = record.task;
      await runtime.userPermissionRuleStore.add({ rule: { id: 'revoke-map-source', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [join(root, 'allowed.ts')] }, createdAt: Date.now(), tier: 'path', tool: 'read' });
    }
    await runtime.agentOrchestrator.runAgent(record);
  } });
  let id: string | undefined;
  try {
    const started = runner.start({ ask: 'Add a CSV parser module', sessionId: 'fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' }); id = started.contract.id;
    await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'actual contract settlement', 30_000);
    const result = runner.get(id)!;
    if (mode === 'revoke-map') {
      expect(admittedMap).toContain('ALLOWED_GRAPH_MARKER');
      expect(admittedMap).not.toContain('PRIVATE_GRAPH_MARKER');
      expect(result.status).toBe('failed');
      expect(plannerCalls).toBe(0); expect(memberCalls).toBe(0); return;
    }
    if (result.status !== 'passed') console.log(JSON.stringify({ error: result.error, memberCalls, lastCheck: result.units[0]?.checks.at(-1), lastToolMessages: requests.slice(-2).map((entry) => JSON.parse(entry.text).messages.slice(-2)) }));
    expect(result.status, result.error).toBe('passed');
    expect(plannerCalls).toBe(2); expect(memberCalls).toBe(4);
    expect(requests.some((request) => request.text.includes('PRIVATE_GRAPH_MARKER'))).toBe(false);
    expect(requests.some((request) => request.planner && request.text.includes('ALLOWED_GRAPH_MARKER'))).toBe(true);
    expect(requests.some((request) => !request.planner && request.text.includes('ALLOWED_GRAPH_MARKER'))).toBe(true);
    expect(requests.some((request) => !request.planner && request.text.includes('export const parse'))).toBe(true);
    expect(result.commit?.note).toContain('not applied');
    expect(readFileSync(join(root, 'allowed.ts'), 'utf8')).toContain('= 2');
    await runner.join(id);
  } finally { if (id) { runner.cancel(id, 'fixture cleanup'); await runner.join(id); } runner.dispose(); store.dispose(); runtime.dispose(); installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); }
}, 40_000);
