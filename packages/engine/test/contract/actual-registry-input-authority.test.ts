/** Real default contract -> planner/member -> AgentOrchestrator -> registry -> scripted provider. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import { createContractRunner } from '../../sdk/src/platform/contract/runner.js';
import { ContractStore } from '../../sdk/src/platform/contract/store.js';
import { createAgentManagerDecompositionRunner } from '../../sdk/src/platform/agents/planner-decomposition-runner.js';
import { createOrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import type { LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

for (const scenario of ['allowed', 'revoke-cached'] as const) {
  test(`actual default contract registry uses permitted owner context (${scenario})`, async () => {
    const root = makeRepo();
    const home = mkdtempSync(join(tmpdir(), 'registry-runner-home-'));
    const skill = (owner: string, name: string, marker: string): string => {
      const dir = join(owner, '.goodvibes', 'skills');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${name}.md`);
      writeFileSync(path, `---\nname: ${name}\ndescription: ${marker}\ndepends_on: [base]\n---\n# ${name}\n${marker}\n`);
      return path;
    };
    const allowed = skill(root, 'allowed', 'PROJECT_REGISTRY_MARKER');
    const global = skill(home, 'global', 'GLOBAL_REGISTRY_MARKER');
    const denied = skill(root, 'private', 'PRIVATE_REGISTRY_MARKER');
    const deniedGlobal = skill(home, 'private-global', 'PRIVATE_GLOBAL_MARKER');
    writeFileSync(join(root, '.goodvibes', 'outside.md'), 'OUTSIDE_REGISTRY_MARKER');
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: home });
    config.set('permissions.engine', 'policy-engine');
    config.set('permissions.mode', 'prompt');
    config.set('behavior.autoApprove', false);
    config.set('contract.isolation', 'worktree');
    config.set('tools.autoHeal', false);
    const bus = new RuntimeEventBus();
    const runtime = createClientRuntimeServices({
      surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: home,
      runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
      providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }),
    });
    await resumeContracts(runtime.contractRunner, root);
    const previous = installJudgmentPort(runnerPort((context) => context.name === 'family' ? choiceAnswer(context.question, 'file-mutation', 0.99) : undefined).port);
    const deny = async (path: string, id: string): Promise<void> => {
      await runtime.userPermissionRuleStore.add({
        rule: { id, type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [path] },
        createdAt: Date.now(), tier: 'path', tool: 'read',
      });
    };
    await deny(denied, 'deny-project-registry');
    await deny(deniedGlobal, 'deny-global-registry');
    expect(await runtime.permissionManager.readAccess(allowed)).toBe('allow');
    expect(await runtime.permissionManager.readAccess(global)).toBe('allow');
    expect(await runtime.permissionManager.readAccess(denied)).toBe('restricted');
    const requests: { planner: boolean; text: string }[] = [];
    let plannerCalls = 0;
    let memberCalls = 0;
    const steps = [
      { name: 'registry', arguments: { mode: 'search', type: 'skills' } },
      { name: 'registry', arguments: { mode: 'content', path: allowed } },
      { name: 'registry', arguments: { mode: 'preview', path: global } },
      { name: 'registry', arguments: { mode: 'dependencies', skillName: 'allowed' } },
      { name: 'registry', arguments: { mode: 'recommend', scope: 'skills', task: 'CSV parser' } },
      { name: 'registry', arguments: { mode: 'content', path: join(root, '.goodvibes', 'outside.md') } },
      { name: 'write', arguments: { files: [{ path: 'src/csv.ts', mode: 'overwrite', content: 'export const parse = () => [];\n' }] } },
    ];
    const provider: LLMProvider = {
      name: 'registry-fixture', models: ['fixture'], isConfigured: () => true,
      async chat(request) {
        const planner = !request.tools?.some((tool) => tool.name === 'write');
        requests.push({ planner, text: JSON.stringify(request) });
        if (planner) {
          plannerCalls++;
          return { content: plannerOutput(oneUnitPlan(1)), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
        }
        const turn = ++memberCalls;
        expect(request.tools?.some((tool) => tool.name === 'registry')).toBe(true);
        if (scenario === 'revoke-cached' && turn === 2) await deny(allowed, 'revoke-used-registry');
        const step = steps[turn - 1];
        return {
          content: step ? '' : 'Created src/csv.ts. The parser works.',
          toolCalls: step ? [{ id: `registry-step-${turn}`, name: step.name, arguments: step.arguments }] : [],
          usage: { inputTokens: 1, outputTokens: 1 }, stopReason: step ? 'tool_call' : 'completed',
        };
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
      configManager: {
        get: config.get.bind(config),
        getCategory: ((name: string) => name === 'contract' ? { ...config.getCategory('contract'), gates: [] } : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory,
      },
      projectRoot: root,
      routeSelector: async () => ({ model: 'registry-fixture:fixture', provider: 'registry-fixture', reason: 'in-process registry fixture' }),
      decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager }),
      createEngine: (input) => createOrchestrationEngine({
        agentManager: runtime.agentManager, configManager: config, runtimeBus: bus,
        projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace,
        initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
        contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
        runWorktreeSetup: () => undefined,
      }),
      fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }),
      priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-03' }), store,
      readAccessFilter: async (path) => await runtime.permissionManager.readAccess(path) === 'allow',
    });
    runtime.agentManager.setContractRunner(runner);
    runtime.agentOrchestrator.setDependencies({
      ...runtime, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: runtime.workflow,
      contractRunner: runner, contractHooks: runner.hooks(),
    });
    let id: string | undefined;
    try {
      const started = runner.start({ ask: 'Add a CSV parser module', sessionId: 'registry-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' });
      id = started.contract.id;
      await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'actual registry contract settlement', 30_000);
      const result = runner.get(id)!;
      const memberRequests = requests.filter((request) => !request.planner);
      expect(plannerCalls).toBe(1);
      expect(memberRequests[1]?.text).toContain('PROJECT_REGISTRY_MARKER');
      expect(memberRequests[1]?.text).toContain('GLOBAL_REGISTRY_MARKER');
      for (const request of requests) {
        expect(request.text).not.toContain('PRIVATE_REGISTRY_MARKER');
        expect(request.text).not.toContain('PRIVATE_GLOBAL_MARKER');
        expect(request.text).not.toContain('OUTSIDE_REGISTRY_MARKER');
      }
      if (scenario === 'revoke-cached') {
        expect(memberCalls).toBe(2);
        expect(result.status).not.toBe('passed');
      } else {
        expect(result.status, result.error).toBe('passed');
        expect(memberCalls).toBe(8);
        expect(memberRequests[5]?.text).toContain('"mode":"recommend"'.replaceAll('"', '\\"'));
        expect(memberRequests[6]?.text).toContain('File not found:');
      }
    } finally {
      if (id) runner.cancel(id, 'fixture cleanup');
      runner.dispose();
      if (id) await runner.join(id);
      store.dispose(); runtime.dispose(); installJudgmentPort(previous);
      rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
}
