/** Real contract -> default AgentOrchestrator -> registerAllTools -> contained validators. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { probeCapturedExecAvailability } from '../../sdk/src/platform/tools/exec/captured-exec.js';
import type { LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import type { ToolCall, ToolResult } from '../../sdk/src/platform/types/tools.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';


const supported = (await probeCapturedExecAvailability()).available;
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !supported)
  throw new Error('required actual validator runtime is unavailable');
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
function copyPackage(source: string, target: string, seen = new Set<string>()): void {
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> };
  if (seen.has(metadata.name)) return;
  seen.add(metadata.name);
  const destination = join(target, metadata.name); mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true, filter: (path) => path === source || !path.slice(source.length + 1).split('/').includes('node_modules') });
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    let cursor = source;
    while (!existsSync(join(cursor, 'node_modules', name)) && dirname(cursor) !== cursor) cursor = dirname(cursor);
    const dependency = join(cursor, 'node_modules', name);
    if (!existsSync(dependency)) throw new Error(`fixture dependency missing: ${name}`);
    copyPackage(realpathSync(dependency), target, seen);
  }
}

test.skipIf(!supported)('actual default member direct commands and typecheck/lint share admitted Node/npm and real project dependencies', async () => {
  const root = makeRepo();
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\nnode_modules/\n');
  mkdirSync(join(root, 'src'));
  const original = 'export const answer: number = 1;\n';
  const changed = 'export const answer: number = 42;\n';
  writeFileSync(join(root, 'src/csv.ts'), original);
  writeFileSync(join(root, 'private.txt'), 'SYNTHETIC_DIRECT_RUNTIME_DENIED');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { proof: 'node direct-proof.cjs' } }));
  writeFileSync(join(root, 'direct-proof.cjs'), [
    'const { existsSync, readFileSync, writeFileSync } = require("node:fs");',
    `if (existsSync(${JSON.stringify(join(root, 'src/csv.ts'))})) throw Error("owner source escaped into direct command");`,
    'if (existsSync("private.txt") || existsSync(".git") || existsSync("/opt/codex")) throw Error("unadmitted direct inputs visible");',
    'if (process.env.HOME !== "/home/captured") throw Error("direct runtime is not contained");',
    'if (!readFileSync("src/csv.ts", "utf8").includes("= 1")) throw Error("wrong captured input");',
    'writeFileSync("node-proof.txt", "REAL_CONTAINED_DIRECT_NODE\\n");',
    'console.log("DIRECT_RUNTIME_ALLOWED");',
  ].join('\n'));
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"skipLibCheck":true},"files":["src/csv.ts"]}');
  writeFileSync(join(root, 'lint-target.js'), 'const answer = 42; console.log(answer);');
  writeFileSync(join(root, 'eslint.config.mjs'), [
    'import { existsSync, writeFileSync } from "node:fs";',
    `if (existsSync(${JSON.stringify(join(root, 'src/csv.ts'))})) throw Error("owner source escaped into validator");`,
    'if (existsSync(".git") || existsSync(".goodvibes") || existsSync("/opt/codex")) throw Error("unadmitted runtime files visible");',
    'if (process.env.HOME !== "/home/captured") throw Error("validator is not contained");',
    'writeFileSync("lint-proof.txt", "REAL_CONTAINED_ESLINT\\n");',
    'export default [{files:["lint-target.js"],rules:{"no-unused-vars":"error"}}];',
  ].join('\n'));
  writeFileSync(join(root, 'owner.txt'), 'committed\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'validator source');
  writeFileSync(join(root, 'owner.txt'), 'staged\n'); git(root, 'add', 'owner.txt'); writeFileSync(join(root, 'owner.txt'), 'unstaged\n');
  const head = git(root, 'rev-parse', 'HEAD'); const index = readFileSync(join(root, '.git/index'));
  const modules = join(root, 'node_modules'); mkdirSync(modules);
  const installed = realpathSync(join(import.meta.dir, '../../../../node_modules'));
  copyPackage(realpathSync(join(installed, 'typescript')), modules);
  const store = join(installed, '.bun'); const eslint = readdirSync(store).find((name) => name.startsWith('eslint@'));
  expect(eslint).toBeDefined(); copyPackage(join(store, eslint!, 'node_modules/eslint'), modules);
  mkdirSync(join(modules, '.bin')); symlinkSync('../typescript/bin/tsc', join(modules, '.bin/tsc')); symlinkSync('../eslint/bin/eslint.js', join(modules, '.bin/eslint'));
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
  config.set('permissions.engine', 'policy-engine'); config.set('permissions.mode', 'prompt'); config.set('behavior.autoApprove', false);
  config.set('contract.isolation', 'worktree'); config.set('tools.autoHeal', false);
  const bus = new RuntimeEventBus();
  const runtime = createClientRuntimeServices({ surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
    runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip', providerRegistryFactory: createLaunchTolerantProviderRegistry,
    requestApproval: async () => ({ approved: true }),
  });
  await resumeContracts(runtime.contractRunner, root);
  await runtime.userPermissionRuleStore.add({ rule: { id: 'deny-direct-runtime-original', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [join(root, 'private.txt')] }, createdAt: Date.now(), tier: 'path', tool: 'read' });
  const previous = installJudgmentPort(runnerPort((context) => context.name === 'family' ? choiceAnswer(context.question, 'file-mutation', 0.99) : undefined).port);
  const results = new Map<string, ToolResult>(); let calls = 0; let memberRoot = ''; let checked = false;
  const assertOwner = (): void => {
    expect(readFileSync(join(root, 'src/csv.ts'), 'utf8')).toBe(original); expect(existsSync(join(root, 'lint-proof.txt'))).toBe(false);
    expect(readFileSync(join(root, 'owner.txt'), 'utf8')).toBe('unstaged\n'); expect(readFileSync(join(root, '.git/index'))).toEqual(index);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  };
  const provider: LLMProvider = { name: 'actual-npx', models: ['fixture'], isConfigured: () => true,
    async chat(request) {
      if (!request.tools?.some((tool) => tool.name === 'write')) return { content: plannerOutput(oneUnitPlan(1)), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
      expect(JSON.stringify(request)).not.toContain('SYNTHETIC_DIRECT_RUNTIME_DENIED');
      const turn = ++calls; memberRoot = runtime.agentManager.list().find((record) => record.contractRole === 'unit')!.workingDirectory!;
      expect(memberRoot).not.toBe(root); assertOwner();
      let step: ToolCall | undefined;
      if (turn === 1) step = { id: 'direct-node-npm', name: 'exec', arguments: { commands: [{ cmd: 'node --version && npm run proof && npx --version' }] } };
      else if (turn === 2) {
        const direct = results.get('direct-node-npm');
        expect(direct?.success, JSON.stringify(direct)).toBe(true);
        expect(direct?.output).toContain('DIRECT_RUNTIME_ALLOWED');
        expect(readFileSync(join(memberRoot, 'node-proof.txt'), 'utf8')).toBe('REAL_CONTAINED_DIRECT_NODE\n');
        expect(existsSync(join(root, 'node-proof.txt'))).toBe(false);
        step = { id: 'real-npx', name: 'write', arguments: { files: [{ path: 'src/csv.ts', content: changed, mode: 'overwrite' }], validate: { after: ['typecheck', 'lint'] }, verbosity: 'standard' } };
      } else {
        const written = results.get('real-npx'); expect(written?.success, JSON.stringify(written)).toBe(true);
        expect(JSON.parse(written!.output!).validation_passed, written!.output).toBe(true);
        expect(readFileSync(join(memberRoot, 'lint-proof.txt'), 'utf8')).toBe('REAL_CONTAINED_ESLINT\n');
        expect(readFileSync(join(memberRoot, 'src/csv.ts'), 'utf8')).toBe(changed);
        if (turn === 3) step = { id: 'actual-type-error', name: 'edit', arguments: { edits: [{ path: 'src/csv.ts', find: '= 42', replace: '= "wrong"' }], validate: { after: ['typecheck'] }, transaction: { mode: 'atomic' } } };
        else { expect(results.get('actual-type-error')?.success).toBe(false); expect(results.get('actual-type-error')?.error).toContain('TS2322'); }
      }
      return { content: step ? '' : 'Created src/csv.ts. The parser works.', toolCalls: step ? [step] : [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: step ? 'tool_call' : 'completed' };
    },
  };
  runtime.providerRegistry.registerRuntimeProvider({ provider, models: [{ id: 'fixture', provider: provider.name, registryKey: 'actual-npx:fixture', displayName: 'Fixture', description: 'Synthetic', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard' }], replace: true });
  await runtime.providerRegistry.ready();
  const storeObject = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
  const runner = createContractRunner({ agentManager: runtime.agentManager, messageBus: runtime.agentMessageBus, runtimeBus: bus,
    configManager: { get: config.get.bind(config), getCategory: ((name: string) => name === 'contract' ? { ...config.getCategory('contract'), gates: [] } : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory },
    projectRoot: root, routeSelector: async () => ({ model: 'actual-npx:fixture', provider: 'actual-npx', reason: 'actual validator fixture' }),
    decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager }),
    createEngine: (input) => createOrchestrationEngine({ agentManager: runtime.agentManager, configManager: config, runtimeBus: bus, projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace, initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority, contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts, runWorktreeSetup: () => undefined }),
    fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }), priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-04' }), store: storeObject,
    readAccessFilter: async (path) => await runtime.permissionManager.readAccess(path) === 'allow',
  });
  runtime.agentManager.setContractRunner(runner);
  runtime.agentOrchestrator.setDependencies({ ...runtime, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: runtime.workflow, contractRunner: runner,
    contractHooks: { onTurnEnd: (record, turn) => { for (const result of turn.results) results.set(result.callId, result); runner.hooks().onTurnEnd(record, turn); },
      holdCompletion: async (record) => { if (record.contractRole === 'unit') { assertOwner(); checked = true; } return runner.hooks().holdCompletion(record); } },
  });
  let id: string | undefined;
  try {
    id = runner.start({ ask: 'Add a CSV parser module', sessionId: 'actual-npx-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' }).contract.id;
    await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'actual Node/npm validator settlement', 180_000);
    await runner.join(id); const result = runner.get(id)!;
    expect(result.status, JSON.stringify({ error: result.error, results: [...results], calls })).toBe('passed'); expect(calls).toBe(4); expect(checked).toBe(true);
    expect(result.commit?.status, result.commit?.note).toBe('applied'); expect(readFileSync(join(root, 'src/csv.ts'), 'utf8')).toBe(changed);
    expect(readFileSync(join(root, 'lint-proof.txt'), 'utf8')).toBe('REAL_CONTAINED_ESLINT\n');
    expect(readFileSync(join(root, 'node-proof.txt'), 'utf8')).toBe('REAL_CONTAINED_DIRECT_NODE\n');
    expect(readFileSync(join(root, 'owner.txt'), 'utf8')).toBe('unstaged\n'); expect(readFileSync(join(root, '.git/index'))).toEqual(index); expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  } finally {
    if (id) { runner.cancel(id, 'fixture cleanup'); await runner.join(id); }
    runner.dispose(); storeObject.dispose(); runtime.dispose(); installJudgmentPort(previous); rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
