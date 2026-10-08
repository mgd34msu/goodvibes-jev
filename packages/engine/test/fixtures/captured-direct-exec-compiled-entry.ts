/** Real contract graph shared by source and restored compiled-product acceptance. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAnswer, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { createContractRunner } from '../../sdk/src/platform/contract/runner.js';
import { ContractStore } from '../../sdk/src/platform/contract/store.js';
import { createAgentManagerDecompositionRunner } from '../../sdk/src/platform/agents/planner-decomposition-runner.js';
import { createOrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import type { LLMProvider, ProviderMessage } from '../../sdk/src/platform/providers/interface.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { resolveProcessCapturedBunRuntimeExecutable } from '../../sdk/src/platform/runtime/captured-bun-runtime.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from '../contract/runner-support.js';
import { plannerOutput } from '../contract/plan-support.js';

export const DIRECT_EXEC_PRIVATE_MARKER = 'PRIVATE_DIRECT_EXEC_SOURCE_BYTES';
export const DIRECT_EXEC_CAPTURED_VALUE = 'DIRTY_CAPTURED_DIRECT_EXEC_VALUE';

/** Only the provider and semantic answers are synthetic. No tool, runtime
 * admission, containment boundary, registry, or contract handoff is replaced.
 * onMemberReady lets the source test isolate projection reads from Git capture.
 */
export async function runDirectExecContract(onMemberReady?: () => void) {
  const root = makeRepo();
  const denied = join(root, 'private.ts');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', '.gitkeep'), '');
  writeFileSync(join(root, 'allowed.ts'), 'export const value = "COMMITTED_DIRECT_EXEC_VALUE";\n');
  writeFileSync(denied, `export const secret = ${JSON.stringify(DIRECT_EXEC_PRIVATE_MARKER)};\n`);
  writeFileSync(join(root, 'configured.fixture'), 'export const configuredType: string = "PROJECT_LOADER_OK";\n');
  writeFileSync(join(root, 'bunfig.toml'), `preload = ["./first-preload.ts", "./second-preload.ts"]
[define]
DIRECT_EXEC_CONFIG_VALUE = '"PROJECT_CONFIG_OK"'
[loader]
".fixture" = "ts"
[test]
preload = ["./first-preload.ts", "./second-preload.ts"]
`);
  writeFileSync(join(root, 'first-preload.ts'), 'globalThis.directExecStartupOrder = ["first"];\n');
  writeFileSync(join(root, 'second-preload.ts'), 'globalThis.directExecStartupOrder.push("second");\n');
  writeFileSync(join(root, 'seed.ts'), `import { value } from './allowed.ts';
import { configuredType } from './configured.fixture';
export const parse = (text: string) => text.split(',');
export const captured = { value, configuredType, configValue: DIRECT_EXEC_CONFIG_VALUE };
`);
  writeFileSync(join(root, 'direct-exec.test.ts'), `import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { captured, parse } from './src/csv.ts';
test('direct compiled-parent build uses captured config and authorized bytes', async () => {
  expect(parse('a,b')).toEqual(['a', 'b']);
  expect(captured).toEqual({ value: ${JSON.stringify(DIRECT_EXEC_CAPTURED_VALUE)}, configuredType: 'PROJECT_LOADER_OK', configValue: 'PROJECT_CONFIG_OK' });
  expect(globalThis.directExecStartupOrder).toEqual(['first', 'second']);
  const denied = [];
  for (const path of ['./private.ts', ${JSON.stringify(denied)}]) {
    try { denied.push(readFileSync(path, 'utf8')); } catch { denied.push('DENIED_READ'); }
  }
  try { denied.push((await import('./private.ts')).secret); } catch { denied.push('DENIED_IMPORT'); }
  expect(denied).toEqual(['DENIED_READ', 'DENIED_READ', 'DENIED_IMPORT']);
  let networkBlocked = false;
  try { Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); } catch { networkBlocked = true; }
  const proof = { ...captured, startupOrder: globalThis.directExecStartupOrder, denied,
    mode: process.env.BUN_BE_BUN ?? null, ambient: process.env.CAPTURED_DIRECT_EXEC_PARENT ?? null, credential: process.env.CAPTURE_DIRECT_EXEC_TOKEN ?? null,
    ownerVisible: existsSync(${JSON.stringify(join(root, 'allowed.ts'))}), hostVisible: existsSync('/etc/passwd'), networkBlocked };
  expect(proof.mode).toBeNull();
  expect(proof.ambient).toBe(${JSON.stringify(process.env.CAPTURED_DIRECT_EXEC_PARENT ?? null)});
  expect(proof.credential).toBeNull();
  expect(proof.ownerVisible).toBe(false);
  expect(proof.hostVisible).toBe(false);
  expect(proof.networkBlocked).toBe(true);
  writeFileSync('generated.json', JSON.stringify(proof));
});
`);
  for (const args of [['add', '.'], ['commit', '-qm', 'direct exec fixture sources']]) {
    const committed = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    if (committed.status !== 0) throw new Error(committed.stderr);
  }
  // The real contract must capture this dirty source, not HEAD or a later edit.
  writeFileSync(join(root, 'allowed.ts'), `export const value = ${JSON.stringify(DIRECT_EXEC_CAPTURED_VALUE)};\n`);
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
  config.set('permissions.engine', 'policy-engine');
  config.set('permissions.mode', 'prompt');
  config.set('behavior.autoApprove', false);
  config.set('contract.isolation', 'worktree');
  config.set('tools.autoHeal', false);
  const bus = new RuntimeEventBus();
  let approvalCalls = 0;
  const runtime = createClientRuntimeServices({
    surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
    runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
    providerRegistryFactory: createLaunchTolerantProviderRegistry,
    requestApproval: async () => { approvalCalls++; return { approved: false }; },
  });
  await resumeContracts(runtime.contractRunner, root);
  const previous = installJudgmentPort(runnerPort((context) => {
    if (context.name === 'family') return choiceAnswer(context.question, 'file-mutation', 0.99);
    if (context.name === 'credential' && context.state.name === 'CAPTURE_DIRECT_EXEC_TOKEN') return noulAnswer(0.99);
    return undefined;
  }).port);
  await runtime.userPermissionRuleStore.add({
    rule: { id: 'deny-original-direct-exec-private', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [denied] },
    createdAt: Date.now(), tier: 'path', tool: 'read',
  });
  const storedDenial = runtime.userPermissionRuleStore.rules().some((rule) => rule.id === 'deny-original-direct-exec-private');
  const originalReadAccess = await runtime.permissionManager.readAccess(denied);
  const requests: { planner: boolean; text: string; messages: ProviderMessage[] }[] = [];
  const executed: { name: string; success: boolean }[] = [];
  let plannerCalls = 0;
  let memberCalls = 0;
  let memberRoot: string | undefined;
  let generated: string | undefined;
  let generatedSource: string | undefined;
  let ownerGeneratedDuringExec: boolean | undefined;
  const steps = [
    { name: 'exec', arguments: { commands: [{
      cmd: 'bun build ./seed.ts --target bun --outfile ./src/csv.ts && bun test ./direct-exec.test.ts && echo DIRECT_EXEC_BUILD_TEST_OK',
      timeout_ms: 30_000,
    }] } },
    { name: 'read', arguments: { files: [{ path: 'generated.json' }, { path: 'src/csv.ts' }] } },
  ];
  const provider: LLMProvider = {
    name: 'direct-exec-fixture', models: ['fixture'], isConfigured: () => true,
    async chat(request) {
      const planner = !request.tools?.some((tool) => tool.name === 'write');
      requests.push({ planner, text: JSON.stringify(request), messages: structuredClone(request.messages) });
      if (planner) {
        plannerCalls++;
        return { content: plannerOutput(oneUnitPlan(1)), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      }
      const turn = ++memberCalls;
      if (turn === 1) {
        if (!request.tools?.some((tool) => tool.name === 'exec') || !request.tools.some((tool) => tool.name === 'read'))
          throw new Error('actual member must receive the registered exec and read tools');
        memberRoot = runtime.agentManager.list().find((record) => record.contractRole === 'unit')?.workingDirectory;
        if (!memberRoot || memberRoot === root) throw new Error('actual member is missing its isolated working directory');
        writeFileSync(join(root, 'allowed.ts'), 'export const value = "LATE_OWNER_DIRECT_EXEC_VALUE";\n');
        onMemberReady?.();
      }
      const step = steps[turn - 1];
      return {
        content: step ? '' : 'Created src/csv.ts. The parser works and its build and test pass.',
        toolCalls: step ? [{ id: `direct-exec-step-${turn}`, name: step.name, arguments: step.arguments }] : [],
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
    routeSelector: async () => ({ model: 'direct-exec-fixture:fixture', provider: 'direct-exec-fixture', reason: 'direct registered exec acceptance' }),
    decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager }),
    createEngine: (input) => createOrchestrationEngine({
      agentManager: runtime.agentManager, configManager: config, runtimeBus: bus,
      projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace,
      initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
      contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
      runWorktreeSetup: () => undefined,
    }),
    fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }),
    priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-08' }), store,
    readAccessFilter: async (path) => await runtime.permissionManager.readAccess(path) === 'allow',
  });
  runtime.agentManager.setContractRunner(runner);
  runtime.agentOrchestrator.setDependencies({
    ...runtime, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: runtime.workflow,
    contractRunner: runner, contractHooks: runner.hooks(),
    toolExecutionObserver(name, _args, success) {
      executed.push({ name, success });
      if (name === 'exec' && memberRoot) {
        const output = join(memberRoot, 'generated.json');
        const source = join(memberRoot, 'src', 'csv.ts');
        generated = existsSync(output) ? readFileSync(output, 'utf8') : undefined;
        generatedSource = existsSync(source) ? readFileSync(source, 'utf8') : undefined;
        ownerGeneratedDuringExec = existsSync(join(root, 'generated.json')) || existsSync(join(root, 'src', 'csv.ts'));
      }
    },
  });
  let id: string | undefined;
  try {
    const started = runner.start({ ask: 'Add a CSV parser module', sessionId: 'direct-exec-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' });
    id = started.contract.id;
    try {
      await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'actual direct exec contract settlement', 60_000);
    } catch (error) {
      throw new Error(JSON.stringify({ error: String(error), status: runner.get(id)?.status, memberCalls, executed,
        agents: runtime.agentManager.list().map((agent) => ({ role: agent.contractRole, status: agent.status, error: agent.error })),
        toolMessages: requests.at(-1)?.messages.filter((message) => message.role === 'tool') }));
    }
    const result = runner.get(id)!;
    return {
      execPath: process.execPath, runtimeExecutable: resolveProcessCapturedBunRuntimeExecutable(), parentMode: process.env.BUN_BE_BUN ?? null,
      status: result.status, error: result.error, storedDenial, originalReadAccess, approvalCalls,
      plannerCalls, memberCalls, ownerRoot: root, memberRoot, executed, requests,
      generated, generatedSource, ownerGeneratedDuringExec, ownerValue: readFileSync(join(root, 'allowed.ts'), 'utf8'),
    };
  } finally {
    if (id) runner.cancel(id, 'fixture cleanup');
    runner.dispose();
    if (id) await runner.join(id);
    store.dispose(); runtime.dispose(); installJudgmentPort(previous);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) process.stdout.write(JSON.stringify(await runDirectExecContract()) + '\n');
