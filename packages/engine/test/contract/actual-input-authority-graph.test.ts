import { createRequire } from 'node:module';
import { probeCapturedExecAvailability } from '../../sdk/src/platform/tools/exec/captured-exec.js';
import { MemoryStore } from '../../sdk/src/platform/state/memory-store.js';
import { MemoryRegistry } from '../../sdk/src/platform/state/memory-registry.js';
import { MemoryEmbeddingProviderRegistry } from '../../sdk/src/platform/state/memory-embeddings.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import {
  getContractInputAuthority,
  assertContractInputAuthority,
} from '../../sdk/src/platform/contract/input-authority.js';
/** Real contract -> planner/member -> AgentManager -> AgentOrchestrator -> tools -> scripted provider. */
import { expect, test } from 'bun:test';
import { writeFileSync, readFileSync, rmSync, mkdirSync, copyFileSync, symlinkSync } from 'node:fs';
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

const capturedExecAvailable = (await probeCapturedExecAvailability()).available;
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !capturedExecAvailable)
  throw new Error('required captured runner execution backend is unavailable');

for (const mode of ['normal', 'revoke-map', 'resume'] as const)
  test.skipIf(!capturedExecAvailable && mode !== 'revoke-map')(
    `actual contract input authority through all construction handoffs (${mode})`,
    async () => {
      const root = makeRepo();
      writeFileSync(join(root, '.gitignore'), '.goodvibes/\nnode_modules/\n');
      const dependencyRoot = join(root, 'node_modules', 'typescript');
      mkdirSync(dependencyRoot, { recursive: true });
      copyFileSync(createRequire(import.meta.url).resolve('typescript'), join(dependencyRoot, 'index.js'));
      writeFileSync(join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'typescript', main: 'index.js' }));
      const workspacePackage = join(root, 'packages', 'fixture-library');
      mkdirSync(workspacePackage, { recursive: true });
      writeFileSync(
        join(workspacePackage, 'package.json'),
        JSON.stringify({ name: '@fixture/library', main: 'index.ts', type: 'module' }),
      );
      writeFileSync(join(workspacePackage, 'index.ts'), "export const compilerInput = 'const value: number = 1;';\n");
      mkdirSync(join(root, 'node_modules', '@fixture'));
      symlinkSync(workspacePackage, join(root, 'node_modules', '@fixture', 'library'), 'dir');
      const skillPath = join(root, '.goodvibes', 'skills', 'fixture.md');
      mkdirSync(join(root, '.goodvibes', 'skills'), { recursive: true });
      writeFileSync(skillPath, '---\nname: Fixture skill\ndescription: Local fixture\n---\nREGISTRY_OWNED_MARKER\n');
      writeFileSync(join(root, 'private.ts'), 'export const PRIVATE_GRAPH_MARKER = 1;\n');
      writeFileSync(join(root, 'allowed.ts'), 'export const ALLOWED_GRAPH_MARKER = 1;\n');
      const commit = spawnSync('git', ['-C', root, 'add', '.']);
      expect(commit.status).toBe(0);
      expect(spawnSync('git', ['-C', root, 'commit', '-qm', 'fixture sources']).status).toBe(0);
      // Dirty user input must remain outside automatic apply-back.
      writeFileSync(join(root, 'allowed.ts'), 'export const ALLOWED_GRAPH_MARKER = 2;\n');
      const config = new ConfigManager({
        surfaceRoot: 'agent',
        configDir: join(root, '.goodvibes', 'cfg'),
        workingDir: root,
        homeDir: root,
      });
      config.set('permissions.engine', 'policy-engine');
      config.set('permissions.mode', 'prompt');
      config.set('behavior.autoApprove', false);
      config.set('contract.isolation', 'worktree');
      config.set('tools.autoHeal', false);
      config.set('agents.passiveInjection.knowledge', true);
      config.set('agents.passiveInjection.code', true);
      const bus = new RuntimeEventBus();
      const runtime = createClientRuntimeServices({
        surfaceRoot: 'agent',
        configManager: config,
        workingDir: root,
        homeDirectory: root,
        runtimeBus: bus,
        runtimeStore: createRuntimeStore(),
        modelDiscovery: 'skip',
        providerRegistryFactory: createLaunchTolerantProviderRegistry,
        requestApproval: async () => ({ approved: true }),
      });
      // Finish the runtime's startup scan before this fixture replaces its runner.
      await resumeContracts(runtime.contractRunner, root);
      const previous = installJudgmentPort(
        runnerPort((context) =>
          context.name === 'family' ? choiceAnswer(context.question, 'file-mutation', 0.99) : undefined,
        ).port,
      );
      await runtime.userPermissionRuleStore.add({
        rule: {
          id: 'deny-original-private',
          type: 'path-scope',
          origin: 'user',
          effect: 'deny',
          toolPattern: 'read',
          pathPatterns: [join(root, 'private.ts')],
        },
        createdAt: Date.now(),
        tier: 'path',
        tool: 'read',
      });
      const requests: { planner: boolean; text: string }[] = [];
      let plannerCalls = 0;
      let memberCalls = 0;
      let resumed = false;
      let paused = false;
      let resumedRequestsStart = 0;
      let memoryReads = 0;
      let ownerIndexReads = 0;
      let ownerReindexes = 0;
      const memoryStore = new MemoryStore(':memory:', {
        embeddingRegistry: new MemoryEmbeddingProviderRegistry({
          configManager: config,
        }),
        enableVectorIndex: false,
      });
      await memoryStore.init();
      const memoryRegistry = new MemoryRegistry(memoryStore);
      const getAllMemory = memoryRegistry.getAll.bind(memoryRegistry);
      memoryRegistry.getAll = (...args: Parameters<typeof memoryRegistry.getAll>) => {
        memoryReads++;
        return getAllMemory(...args);
      };
      const passiveSources = {
        memoryRegistry,
        codeIndex: {
          stats: () => {
            ownerIndexReads++;
            return {
              available: true,
              indexedChunks: 1,
              embeddingProviderMismatch: undefined,
              semanticRetrievalAvailable: true,
            };
          },
          search: async () => {
            ownerIndexReads++;
            return [];
          },
        },
        isCodeInjectionSettingEnabled: () => true,
        codeIndexReindexScheduler: {
          onToolExecuted: () => {
            ownerReindexes++;
          },
        },
      };
      const provider: LLMProvider = {
        name: 'graph-fixture',
        models: ['fixture'],
        isConfigured: () => true,
        async chat(request) {
          const planner = !request.tools?.some((tool) => tool.name === 'write');
          const turn = planner ? ++plannerCalls : ++memberCalls;
          requests.push({ planner, text: JSON.stringify(request) });
          if (mode === 'resume' && !resumed && !planner && turn === 3) {
            paused = true;
            return new Promise<never>((_, reject) => {
              if (!request.signal) return reject(new Error('fixture member has no owned cancellation signal'));
              const abort = () => reject(new DOMException('fixture interrupted for restart', 'AbortError'));
              if (request.signal.aborted) abort();
              else request.signal.addEventListener('abort', abort, { once: true });
            });
          }
          if (!planner && turn === 6)
            writeFileSync(
              join(workspacePackage, 'index.ts'),
              "export const compilerInput = 'const value: number = 999;';\n",
            );
          const toolCalls =
            turn === 1
              ? [
                  {
                    id: `${planner ? 'planner' : 'member'}-find`,
                    name: 'find',
                    arguments: {
                      queries: [
                        {
                          id: 'all',
                          mode: 'files',
                          patterns: ['private.ts', 'allowed.ts'],
                        },
                      ],
                      output: { format: 'with_preview' },
                    },
                  },
                ]
              : !planner && turn === 2
                ? [
                    {
                      id: 'member-write',
                      name: 'write',
                      arguments: {
                        files: [
                          {
                            path: 'src/csv.ts',
                            mode: 'overwrite',
                            content:
                              'import ts from "typescript"; import { compilerInput } from "@fixture/library"; export const parse = () => [];\n',
                          },
                          {
                            path: 'schema.prisma',
                            mode: 'overwrite',
                            content: 'model CapturedRecord {\n  id Int @id\n}\n',
                          },
                          {
                            path: 'src/csv.test.ts',
                            mode: 'overwrite',
                            content:
                              'import { test, expect } from "bun:test"; import { parse } from "./csv"; test("captured parser", () => expect(parse()[0]).toContain("value = 1"));\n',
                          },
                        ],
                      },
                    },
                  ]
                : !planner && turn === 3
                  ? [
                      {
                        id: 'member-edit',
                        name: 'edit',
                        arguments: {
                          edits: [
                            {
                              path: 'src/csv.ts',
                              find: '[]',
                              replace: '[ts.transpileModule(compilerInput, {}).outputText]',
                            },
                          ],
                        },
                      },
                    ]
                  : !planner && turn === 4
                    ? [
                        { id: 'member-registry', name: 'registry', arguments: { mode: 'content', path: skillPath } },
                        {
                          id: 'member-inspect',
                          name: 'inspect',
                          arguments: { mode: 'database', projectRoot: '.', schemaPath: 'schema.prisma' },
                        },
                        {
                          id: 'member-analyze',
                          name: 'analyze',
                          arguments: {
                            mode: 'preview',
                            projectRoot: '.',
                            files: ['src/csv.ts'],
                            find: 'parse',
                            replace: 'parsePreview',
                          },
                        },
                      ]
                    : !planner && turn === 5
                      ? [
                          {
                            id: 'member-read-generated',
                            name: 'read',
                            arguments: { files: [{ path: 'src/csv.ts' }] },
                          },
                        ]
                      : !planner && turn === 6
                        ? [
                            {
                              id: 'member-build-test',
                              name: 'exec',
                              arguments: {
                                commands: [
                                  {
                                    cmd: 'bun build ./src/csv.ts --target bun --outdir ./dist && bun test ./src/csv.test.ts && echo CAPTURED_BUILD_TEST_OK',
                                  },
                                ],
                              },
                            },
                          ]
                        : [];
          return {
            content: toolCalls.length
              ? mode === 'resume' && !resumed && !planner
                ? '[unmet] unfinished fixture'
                : ''
              : planner
                ? plannerOutput(oneUnitPlan(1))
                : 'Created src/csv.ts. The parser works.',
            toolCalls,
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: toolCalls.length ? 'tool_call' : 'completed',
          };
        },
      };
      runtime.providerRegistry.registerRuntimeProvider({
        provider,
        models: [
          {
            id: 'fixture',
            provider: provider.name,
            registryKey: `${provider.name}:fixture`,
            displayName: 'Fixture',
            description: 'Synthetic',
            capabilities: {
              toolCalling: true,
              codeEditing: true,
              reasoning: false,
              multimodal: false,
            },
            contextWindow: 100_000,
            selectable: true,
            tier: 'standard',
          },
        ],
        replace: true,
      });
      await runtime.providerRegistry.ready();
      let store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
      const buildRunner = () =>
        createContractRunner({
          agentManager: runtime.agentManager,
          messageBus: runtime.agentMessageBus,
          runtimeBus: bus,
          configManager: {
            get: config.get.bind(config),
            getCategory: ((name: string) =>
              name === 'contract'
                ? { ...config.getCategory('contract'), gates: [] }
                : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory,
          },
          projectRoot: root,
          routeSelector: async () => ({
            model: 'graph-fixture:fixture',
            provider: 'graph-fixture',
            reason: 'in-process fixture',
          }),
          decompositionRunner: createAgentManagerDecompositionRunner({
            agentManager: runtime.agentManager,
          }),
          createEngine: (input) =>
            createOrchestrationEngine({
              agentManager: runtime.agentManager,
              configManager: config,
              runtimeBus: bus,
              projectRoot: input.projectRoot,
              stateRoot: input.stateRoot,
              stateNamespace: input.stateNamespace,
              initializeWorktree: input.initializeWorktree,
              prepareInputAuthority: input.prepareInputAuthority,
              contractUnitSettlement: input.contractUnitSettlement,
              fleetCapacity: input.fleetCapacity,
              judgeAttempts: input.judgeAttempts,
              runWorktreeSetup: () => undefined,
            }),
          fleetCapacity: () => ({
            active: 0,
            maxSize: 8,
            capKey: 'fleet.maxSize',
          }),
          priceUsage: () => 0,
          priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-03' }),
          store,
          readAccessFilter: async (path) => (await runtime.permissionManager.readAccess(path)) === 'allow',
        });
      let runner = buildRunner();
      const bindRunner = () => {
        runtime.agentManager.setContractRunner(runner);
        runtime.agentOrchestrator.setDependencies({
          ...runtime,
          ...passiveSources,
          configManager: config,
          workingDirectory: root,
          surfaceRoot: 'agent',
          workflowServices: runtime.workflow,
          contractRunner: runner,
          contractHooks: runner.hooks(),
        });
      };
      bindRunner();
      let admittedMap = '';
      runtime.agentManager.setExecutor({
        async runAgent(record) {
          if (mode === 'revoke-map' && record.template === 'planner') {
            admittedMap = record.task;
            await runtime.userPermissionRuleStore.add({
              rule: {
                id: 'revoke-map-source',
                type: 'path-scope',
                origin: 'user',
                effect: 'deny',
                toolPattern: 'read',
                pathPatterns: [join(root, 'allowed.ts')],
              },
              createdAt: Date.now(),
              tier: 'path',
              tool: 'read',
            });
          }
          await runtime.agentOrchestrator.runAgent(record);
        },
      });
      let id: string | undefined;
      try {
        const started = runner.start({
          ask: 'Add a CSV parser module',
          sessionId: 'fixture',
          origin: 'cli',
          projectRoot: root,
          isolation: 'worktree',
        });
        id = started.contract.id;
        if (mode === 'resume') {
          await waitFor(() => paused, 'member provider interrupted', 15_000);
          const oldMember = runtime.agentManager.list().find((record) => record.contractRole === 'unit')!;
          const oldAuthority = getContractInputAuthority(oldMember)!;
          expect(oldAuthority).toBeDefined();
          runner.dispose();
          await runner.join(id);
          await expect(assertContractInputAuthority(oldAuthority)).rejects.toThrow();
          store.dispose();
          writeFileSync(join(root, 'allowed.ts'), 'export const ALLOWED_GRAPH_MARKER = 99;\n');
          resumed = true;
          memberCalls = 0;
          resumedRequestsStart = requests.length;
          store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
          runner = buildRunner();
          bindRunner();
          await runner.resumeAll();
          await waitFor(
            () =>
              ['failed', 'passed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status) ||
              runtime.agentManager
                .list()
                .some((record) => record.contractRole === 'unit' && record.id !== oldMember.id),
            'resumed member admitted',
            15_000,
          );
          if (['failed', 'passed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status))
            console.log(
              JSON.stringify({
                resumeStatus: runner.get(id!)!.status,
                error: runner.get(id!)!.error,
              }),
            );
          const rebound = runtime.agentManager
            .list()
            .find((record) => record.contractRole === 'unit' && record.id !== oldMember.id)!;
          expect(rebound.workingDirectory).toBe(oldMember.workingDirectory);
          expect(getContractInputAuthority(rebound)).toBeDefined();
          expect(getContractInputAuthority(rebound)).not.toBe(oldAuthority);
        }
        await waitFor(
          () => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status),
          'actual contract settlement',
          30_000,
        );
        const result = runner.get(id)!;
        if (mode === 'revoke-map') {
          expect(admittedMap).toContain('ALLOWED_GRAPH_MARKER');
          expect(admittedMap).not.toContain('PRIVATE_GRAPH_MARKER');
          expect(result.status).toBe('failed');
          expect(plannerCalls).toBe(0);
          expect(memberCalls).toBe(0);
          return;
        }
        if (result.status !== 'passed')
          console.log(
            JSON.stringify({
              error: result.error,
              memberCalls,
              lastCheck: result.units[0]?.checks.at(-1),
              lastToolMessages: requests.slice(-2).map((entry) => JSON.parse(entry.text).messages.slice(-2)),
            }),
          );
        expect(result.status, result.error).toBe('passed');
        expect(plannerCalls).toBe(2);
        expect(memberCalls).toBe(7);
        expect(requests.some((request) => request.text.includes('PRIVATE_GRAPH_MARKER'))).toBe(false);
        expect(requests.some((request) => request.planner && request.text.includes('ALLOWED_GRAPH_MARKER'))).toBe(true);
        expect(requests.some((request) => !request.planner && request.text.includes('ALLOWED_GRAPH_MARKER'))).toBe(
          true,
        );
        if (mode === 'resume') {
          const resumedMemberRequests = requests.slice(resumedRequestsStart).filter((request) => !request.planner);
          expect(resumedMemberRequests.some((request) => request.text.includes('ALLOWED_GRAPH_MARKER = 2'))).toBe(true);
          expect(resumedMemberRequests.every((request) => !request.text.includes('ALLOWED_GRAPH_MARKER = 99'))).toBe(
            true,
          );
        }
        expect(runtime.featureFlags.isEnabled('agent-passive-code-injection')).toBe(true);
        expect(memoryReads).toBeGreaterThan(0);
        expect(ownerIndexReads).toBe(0);
        expect(ownerReindexes).toBe(0);
        expect(requests.some((request) => !request.planner && request.text.includes('export const parse'))).toBe(true);
        expect(requests.some((request) => !request.planner && request.text.includes('ts.transpileModule'))).toBe(true);
        const toolMessages = requests.flatMap(
          (request) => JSON.parse(request.text).messages as Array<{ role: string; name?: string; content?: string }>,
        );
        const executed = toolMessages
          .filter((message) => message.role === 'tool' && message.name === 'exec')
          .flatMap((message) => {
            try {
              return [
                JSON.parse(message.content ?? '') as {
                  success?: boolean;
                  stdout?: string;
                  sandboxed?: boolean;
                  exit_code?: number;
                },
              ];
            } catch {
              return [];
            }
          });
        expect(
          executed.some(
            (result) =>
              result.success === true &&
              result.exit_code === 0 &&
              result.sandboxed === true &&
              result.stdout?.includes('CAPTURED_BUILD_TEST_OK'),
          ),
          JSON.stringify(executed),
        ).toBe(true);
        expect(
          toolMessages.some(
            (message) =>
              message.role === 'tool' && message.name === 'inspect' && message.content?.includes('CapturedRecord'),
          ),
        ).toBe(true);
        expect(
          toolMessages.some(
            (message) =>
              message.role === 'tool' &&
              message.name === 'registry' &&
              message.content?.includes('REGISTRY_OWNED_MARKER'),
          ),
        ).toBe(true);
        expect(result.commit?.note).toContain('not applied');
        expect(readFileSync(join(root, 'allowed.ts'), 'utf8')).toContain(mode === 'resume' ? '= 99' : '= 2');
        await runner.join(id);
      } finally {
        if (id) {
          runner.cancel(id, 'fixture cleanup');
          await runner.join(id);
        }
        runner.dispose();
        store.dispose();
        runtime.dispose();
        memoryStore.close();
        installJudgmentPort(previous);
        rmSync(root, { recursive: true, force: true });
      }
    },
    40_000,
  );
