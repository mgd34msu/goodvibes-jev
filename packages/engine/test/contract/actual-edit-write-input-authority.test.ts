/** Real contract -> default AgentOrchestrator -> registerAllTools -> contained validators. */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { probeCapturedExecAvailability } from '../../sdk/src/platform/tools/exec/captured-exec.js';
import type { LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import type { ToolCall, ToolResult } from '../../sdk/src/platform/types/tools.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

const capturedExecAvailable = (await probeCapturedExecAvailability()).available;
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !capturedExecAvailable)
  throw new Error('required actual edit/write captured execution backend is unavailable');

const originalSource = 'export const parse = () => "ORIGINAL_CAPTURED";\n';
const editedSource = originalSource.replace('ORIGINAL_CAPTURED', 'EDITED_CAPTURED');
const deliveredSource = originalSource.replace('ORIGINAL_CAPTURED', 'BACKUP_CAPTURED');
const originalNotebook = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [{
    id: 'parser-cell', cell_type: 'code', source: ['NOTEBOOK_ORIGINAL\n'], metadata: {},
    outputs: [{ output_type: 'stream', name: 'stdout', text: ['OLD_CELL_OUTPUT\n'] }], execution_count: 7,
  }],
}) + '\n';

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function notebookStep(source: string, dryRun = false): ToolCall {
  return {
    id: dryRun ? 'notebook-preview' : 'notebook-replace', name: 'edit', arguments: {
      notebook_operations: {
        path: 'parser.ipynb',
        operations: [{ op: 'replace', cell_id: 'parser-cell', source, clear_outputs: true }],
      },
      dry_run: dryRun,
      output: { format: 'with_diff' },
    },
  };
}

for (const scenario of ['deliver', 'deny-original', 'deny-copy'] as const) {
  test.skipIf(!capturedExecAvailable)(
    `actual captured edit/write modes and embedded validators retain owner authority (${scenario})`,
    async () => {
      const root = makeRepo();
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/csv.ts'), originalSource);
      writeFileSync(join(root, 'parser.ipynb'), originalNotebook);
      writeFileSync(join(root, 'owner.txt'), 'OWNER_COMMITTED\n');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'bun build-fixture.ts' } }));
      // This is a real Bun build validator. Its reads and generated artifact must
      // occur in the contained copy, then publish to the member under its lease.
      writeFileSync(join(root, 'build-fixture.ts'), [
        'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
        `if (existsSync(${JSON.stringify(join(root, 'owner.txt'))})) throw Error("validator escaped its projection");`,
        'if (existsSync(".git") || existsSync(".goodvibes")) throw Error("runtime files leaked into validator");',
        'if (process.env.HOME !== "/home/captured") throw Error("validator lacks captured runtime");',
        'const source = readFileSync("src/csv.ts", "utf8");',
        'const book = JSON.parse(readFileSync("parser.ipynb", "utf8"));',
        'if (book.cells[0].source.join("") !== "NOTEBOOK_APPLIED\\n") throw Error("notebook edit is missing");',
        'appendFileSync("validator-artifact.jsonl", JSON.stringify({ source, cell: book.cells[0].source.join("") }) + "\\n");',
      ].join('\n'));
      writeFileSync(join(root, 'source.test.ts'), [
        'import { expect, test } from "bun:test";',
        'import { existsSync, readFileSync } from "node:fs";',
        'test("validator reads the new member files", () => {',
        `  expect(existsSync(${JSON.stringify(join(root, 'owner.txt'))})).toBe(false);`,
        '  expect(existsSync(".git")).toBe(false);',
        '  expect(existsSync(".goodvibes")).toBe(false);',
        '  expect(process.env.HOME).toBe("/home/captured");',
        '  expect(readFileSync("src/csv.ts", "utf8")).toContain("BACKUP_CAPTURED");',
        '  expect(readFileSync("member-only.txt", "utf8")).toBe("MEMBER_ONLY\\n");',
        '  expect(readFileSync("validator-artifact.jsonl", "utf8")).toContain("BACKUP_CAPTURED");',
        '});',
      ].join('\n'));
      git(root, 'add', '.');
      git(root, 'commit', '-qm', 'actual captured edit write fixture');
      // Preserve a staged edit, a different working-tree edit and an untracked
      // file. The member consumes this dirty snapshot without staging it again.
      writeFileSync(join(root, 'owner.txt'), 'OWNER_STAGED\n');
      git(root, 'add', 'owner.txt');
      writeFileSync(join(root, 'owner.txt'), 'OWNER_UNSTAGED\n');
      writeFileSync(join(root, 'owner-untracked.txt'), 'OWNER_UNTRACKED\n');
      const ownerIndex = readFileSync(join(root, '.git/index'));
      const ownerHead = git(root, 'rev-parse', 'HEAD');
      const config = new ConfigManager({
        surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root,
      });
      config.set('permissions.engine', 'policy-engine');
      config.set('permissions.mode', 'prompt');
      config.set('behavior.autoApprove', false);
      config.set('contract.isolation', 'worktree');
      config.set('tools.autoHeal', false);
      const bus = new RuntimeEventBus();
      const runtime = createClientRuntimeServices({
        surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
        runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
        providerRegistryFactory: createLaunchTolerantProviderRegistry,
        requestApproval: async () => ({ approved: true }),
      });
      await resumeContracts(runtime.contractRunner, root);
      const previous = installJudgmentPort(runnerPort((context) =>
        context.name === 'family' ? choiceAnswer(context.question, 'file-mutation', 0.99) : undefined,
      ).port);
      const steps: ToolCall[] = [
        notebookStep('NOTEBOOK_DRY_RUN\n', true),
        notebookStep('NOTEBOOK_APPLIED\n'),
        {
          id: 'edit-with-validators', name: 'edit', arguments: {
            edits: [{ path: 'src/csv.ts', find: 'ORIGINAL_CAPTURED', replace: 'EDITED_CAPTURED' }],
            validate: { before: ['build'], after: ['build'] },
          },
        },
        {
          id: 'backup-dry-run', name: 'write', arguments: {
            files: [{ path: 'src/csv.ts', mode: 'backup', content: deliveredSource }],
            transaction: { mode: 'atomic' }, dry_run: true, verbosity: 'standard',
          },
        },
        {
          id: 'atomic-rollback', name: 'write', arguments: {
            files: [
              { path: 'src/csv.ts', mode: 'overwrite', content: 'ROLLBACK_SENTINEL\n' },
              { path: 'rollback-only.txt', content: 'ROLLBACK_CREATED\n' },
              { path: 'rollback-parent', content: 'A_FILE_CANNOT_BE_A_DIRECTORY\n' },
              { path: 'rollback-parent/child.txt', content: 'MUST_FAIL_AFTER_PRIOR_WRITES\n' },
            ],
            transaction: { mode: 'atomic' }, verbosity: 'standard',
          },
        },
        {
          id: 'backup-atomic-with-validators', name: 'write', arguments: {
            files: [
              { path: 'src/csv.ts', mode: 'backup', content: deliveredSource },
              { path: 'member-only.txt', content: 'MEMBER_ONLY\n' },
            ],
            transaction: { mode: 'atomic' }, validate: { after: ['build', 'test'] }, verbosity: 'standard',
          },
        },
        {
          id: 'edit-validator-rollback', name: 'edit', arguments: {
            edits: [{ path: 'src/csv.ts', find: 'BACKUP_CAPTURED', replace: 'REJECTED_CAPTURED' }],
            validate: { after: ['test'] }, transaction: { mode: 'atomic' },
          },
        },
      ];
      let plannerCalls = 0;
      let memberCalls = 0;
      let memberRoot = '';
      let checkedBeforeDelivery = false;
      let memberArtifact = '';
      let checkedDeniedMutation = false;
      const results = new Map<string, ToolResult>();
      const requests: string[] = [];
      const assertOwnerUnchanged = (): void => {
        expect(readFileSync(join(root, 'src/csv.ts'), 'utf8')).toBe(originalSource);
        expect(readFileSync(join(root, 'parser.ipynb'), 'utf8')).toBe(originalNotebook);
        expect(existsSync(join(root, 'member-only.txt'))).toBe(false);
        expect(existsSync(join(root, 'validator-artifact.jsonl'))).toBe(false);
        expect(existsSync(join(root, '.goodvibes', '.backups'))).toBe(false);
        expect(readFileSync(join(root, 'owner.txt'), 'utf8')).toBe('OWNER_UNSTAGED\n');
        expect(readFileSync(join(root, '.git/index'))).toEqual(ownerIndex);
        expect(git(root, 'rev-parse', 'HEAD')).toBe(ownerHead);
      };
      const artifactSources = (): string[] => readFileSync(join(memberRoot, 'validator-artifact.jsonl'), 'utf8')
        .trim().split('\n').map((line) => (JSON.parse(line) as { source: string }).source);
      const provider: LLMProvider = {
        name: 'edit-write-fixture', models: ['fixture'], isConfigured: () => true,
        async chat(request) {
          if (!request.tools?.some((tool) => tool.name === 'write')) {
            plannerCalls++;
            return {
              content: plannerOutput(oneUnitPlan(1)), toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed',
            };
          }
          const turn = ++memberCalls;
          requests.push(JSON.stringify(request));
          memberRoot = runtime.agentManager.list().find((record) => record.contractRole === 'unit')!.workingDirectory!;
          expect(memberRoot).not.toBe(root);
          const editDefinition = JSON.stringify(request.tools.find((tool) => tool.name === 'edit')?.parameters);
          const writeDefinition = JSON.stringify(request.tools.find((tool) => tool.name === 'write')?.parameters);
          expect(editDefinition).toContain('notebook_operations');
          expect(editDefinition).toContain('validate');
          expect(writeDefinition).toContain('backup');
          expect(writeDefinition).toContain('atomic');
          expect(writeDefinition).toContain('validate');
          assertOwnerUnchanged();
          if (turn === 2) {
            expect(readFileSync(join(memberRoot, 'parser.ipynb'), 'utf8')).toBe(originalNotebook);
            expect(results.get('notebook-preview')?.success).toBe(true);
            expect(results.get('notebook-preview')?.output).toContain('dry run');
            expect(results.get('notebook-preview')?.output).toContain('NOTEBOOK_DRY_RUN');
            if (scenario !== 'deliver') {
              const deniedRoot = scenario === 'deny-original' ? root : memberRoot;
              await runtime.userPermissionRuleStore.add({
                rule: {
                  id: `deny-notebook-${scenario}`, type: 'path-scope', origin: 'user', effect: 'deny',
                  toolPattern: 'read', pathPatterns: [join(deniedRoot, 'parser.ipynb')],
                },
                createdAt: Date.now(), tier: 'path', tool: 'read',
              });
            }
          }
          if (turn === 3) {
            expect(results.get('notebook-replace')?.success).toBe(true);
            const book = JSON.parse(readFileSync(join(memberRoot, 'parser.ipynb'), 'utf8'));
            expect(book.cells[0].source.join('')).toBe('NOTEBOOK_APPLIED\n');
            expect(book.cells[0].outputs).toEqual([]);
            expect(book.cells[0].execution_count).toBeNull();
          }
          if (turn === 4) {
            expect(results.get('edit-with-validators')?.success).toBe(true);
            expect(artifactSources()).toEqual([originalSource, editedSource]);
          }
          if (turn === 5 || turn === 6) {
            expect(readFileSync(join(memberRoot, 'src/csv.ts'), 'utf8')).toBe(editedSource);
            expect(existsSync(join(memberRoot, '.goodvibes', '.backups'))).toBe(false);
            if (turn === 5) expect(results.get('backup-dry-run')?.success).toBe(true);
            if (turn === 6) {
              expect(results.get('atomic-rollback')?.success).toBe(false);
              expect(existsSync(join(memberRoot, 'rollback-only.txt'))).toBe(false);
              expect(existsSync(join(memberRoot, 'rollback-parent'))).toBe(false);
              expect(readFileSync(join(memberRoot, 'README.md'), 'utf8')).toBe('# demo\n');
            }
          }
          if (turn === 7 || turn === 8) {
            const written = results.get('backup-atomic-with-validators');
            expect(written?.success, written?.error).toBe(true);
            const output = JSON.parse(written!.output!) as { validation_passed?: boolean; files: { backup_path?: string }[] };
            expect(output.validation_passed).toBe(true);
            const backupPath = output.files.find((file) => file.backup_path !== undefined)?.backup_path;
            expect(backupPath).toStartWith(join(memberRoot, '.goodvibes', '.backups'));
            expect(readFileSync(backupPath!, 'utf8')).toBe(editedSource);
            expect(readdirSync(join(memberRoot, '.goodvibes', '.backups', 'src'))).toHaveLength(1);
            expect(readFileSync(join(memberRoot, 'src/csv.ts'), 'utf8')).toBe(deliveredSource);
            expect(artifactSources()).toEqual([originalSource, editedSource, deliveredSource]);
            if (turn === 8) {
              memberArtifact = readFileSync(join(memberRoot, 'validator-artifact.jsonl'), 'utf8');
              expect(results.get('edit-validator-rollback')?.success).toBe(false);
              expect(results.get('edit-validator-rollback')?.error).toContain('Post-edit validation failed, edits rolled back');
            }
          }
          const step = steps[turn - 1];
          return {
            content: step ? '' : 'Created src/csv.ts and updated its notebook. The parser works.',
            toolCalls: step ? [step] : [], usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: step ? 'tool_call' : 'completed',
          };
        },
      };
      runtime.providerRegistry.registerRuntimeProvider({ provider, models: [{
        id: 'fixture', provider: provider.name, registryKey: `${provider.name}:fixture`, displayName: 'Fixture', description: 'Synthetic',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
        contextWindow: 100_000, selectable: true, tier: 'standard',
      }], replace: true });
      await runtime.providerRegistry.ready();
      const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
      const runner = createContractRunner({
        agentManager: runtime.agentManager, messageBus: runtime.agentMessageBus, runtimeBus: bus,
        configManager: {
          get: config.get.bind(config),
          getCategory: ((name: string) => name === 'contract'
            ? { ...config.getCategory('contract'), gates: [] }
            : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory,
        },
        projectRoot: root,
        routeSelector: async () => ({ model: 'edit-write-fixture:fixture', provider: 'edit-write-fixture', reason: 'actual edit/write fixture' }),
        decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager }),
        createEngine: (input) => createOrchestrationEngine({
          agentManager: runtime.agentManager, configManager: config, runtimeBus: bus,
          projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace,
          initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
          contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
          runWorktreeSetup: () => undefined,
        }),
        fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }),
        priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-04' }), store,
        readAccessFilter: async (path) => await runtime.permissionManager.readAccess(path) === 'allow',
      });
      runtime.agentManager.setContractRunner(runner);
      runtime.agentOrchestrator.setDependencies({
        ...runtime, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: runtime.workflow,
        contractRunner: runner, contractHooks: {
          onTurnEnd: (record, turn) => {
            for (const result of turn.results) {
              results.set(result.callId, result);
              if (result.callId === 'atomic-rollback') {
                expect(result.success).toBe(false);
                expect(result.error).toContain('Rolled back 3 file(s)');
                expect(readFileSync(join(record.workingDirectory!, 'src/csv.ts'), 'utf8'), 'atomic failure must restore the earlier overwrite').toBe(editedSource);
                expect(existsSync(join(record.workingDirectory!, 'rollback-only.txt'))).toBe(false);
                expect(existsSync(join(record.workingDirectory!, 'rollback-parent'))).toBe(false);
              }
              if (scenario !== 'deliver' && result.callId === 'notebook-replace') {
                expect(result.success).toBe(false);
                expect(result.output).toBeUndefined();
                expect(result.error).toContain('Output withheld');
                expect(readFileSync(join(record.workingDirectory!, 'parser.ipynb'), 'utf8')).toBe(originalNotebook);
                expect(existsSync(join(record.workingDirectory!, 'validator-artifact.jsonl'))).toBe(false);
                checkedDeniedMutation = true;
              }
            }
            runner.hooks().onTurnEnd(record, turn);
          },
          holdCompletion: async (record) => {
            if (record.contractRole === 'unit' && scenario === 'deliver') {
              assertOwnerUnchanged();
              expect(readFileSync(join(record.workingDirectory!, 'src/csv.ts'), 'utf8')).toBe(deliveredSource);
              expect(readFileSync(join(record.workingDirectory!, 'member-only.txt'), 'utf8')).toBe('MEMBER_ONLY\n');
              checkedBeforeDelivery = true;
            }
            return runner.hooks().holdCompletion(record);
          },
        },
      });
      let id: string | undefined;
      try {
        const started = runner.start({
          ask: 'Add a CSV parser module', sessionId: 'actual-edit-write-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree',
        });
        id = started.contract.id;
        await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'actual captured edit/write settlement', 45_000);
        await runner.join(id);
        const result = runner.get(id)!;
        expect(plannerCalls).toBe(1);
        if (scenario === 'deliver') {
          expect(result.status, JSON.stringify({ error: result.error, results: [...results], memberCalls })).toBe('passed');
          expect(memberCalls).toBe(8);
          expect(checkedBeforeDelivery).toBe(true);
          expect(result.commit?.status, result.commit?.note).toBe('applied');
          expect(result.commit?.hash).toBeUndefined();
          expect(result.commit?.note).toContain('uncommitted');
          expect(readFileSync(join(root, 'src/csv.ts'), 'utf8')).toBe(deliveredSource);
          expect(JSON.parse(readFileSync(join(root, 'parser.ipynb'), 'utf8')).cells[0].source.join('')).toBe('NOTEBOOK_APPLIED\n');
          expect(readFileSync(join(root, 'member-only.txt'), 'utf8')).toBe('MEMBER_ONLY\n');
          expect(readFileSync(join(root, 'validator-artifact.jsonl'), 'utf8')).toBe(memberArtifact);
          expect(existsSync(join(root, 'rollback-only.txt'))).toBe(false);
          expect(existsSync(join(root, '.goodvibes', '.backups'))).toBe(false);
        } else {
          expect(memberCalls, JSON.stringify({ status: result.status, error: result.error, results: [...results] })).toBe(2);
          expect(result.status).not.toBe('passed');
          expect(checkedBeforeDelivery).toBe(false);
          expect(result.error).toContain('captured input path is access-restricted');
          expect(checkedDeniedMutation).toBe(true);
          expect(requests.every((request) => !request.includes('NOTEBOOK_APPLIED'))).toBe(true);
          assertOwnerUnchanged();
        }
        expect(readFileSync(join(root, 'owner.txt'), 'utf8')).toBe('OWNER_UNSTAGED\n');
        expect(readFileSync(join(root, 'owner-untracked.txt'), 'utf8')).toBe('OWNER_UNTRACKED\n');
        expect(readFileSync(join(root, '.git/index'))).toEqual(ownerIndex);
        expect(git(root, 'rev-parse', 'HEAD')).toBe(ownerHead);
      } finally {
        if (id) {
          runner.cancel(id, 'fixture cleanup');
          await runner.join(id);
        }
        runner.dispose();
        store.dispose();
        runtime.dispose();
        installJudgmentPort(previous);
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
}
