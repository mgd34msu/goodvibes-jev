/** Real contract -> AgentManager -> AgentOrchestrator -> registered read workflows. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { createContractRunner } from '../../sdk/src/platform/contract/runner.js';
import { ContractStore } from '../../sdk/src/platform/contract/store.js';
import { createAgentManagerDecompositionRunner } from '../../sdk/src/platform/agents/planner-decomposition-runner.js';
import { createOrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import type { LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import type { ToolCall, ToolResult } from '../../sdk/src/platform/types/tools.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

const PRIVATE = 'PRIVATE_WORKFLOW_BYTES_MUST_NEVER_REACH_PROVIDER';
const ALLOWED = 'ALLOWED_WORKFLOW_SOURCE';
const GENERATED = 'AUTHORIZED_GENERATED_MEMBER';
const OWNER_REGISTRY = 'UNBOUND_OWNER_REGISTRY_RESULT';
type Workflow = 'references' | 'inspection' | 'analysis' | 'edit' | 'write-read';
type Scenario = 'allowed' | 'denied' | 'revoke-after-read' | 'cancel-after-read';
const activeCleanups = new Set<() => Promise<void>>();
afterEach(async () => { for (const cleanup of [...activeCleanups]) await cleanup(); });

for (const workflow of ['references', 'inspection', 'analysis', 'edit', 'write-read'] as const) {
  const scenarios: readonly Scenario[] = workflow === 'references'
    ? ['allowed', 'denied', 'revoke-after-read', 'cancel-after-read'] : ['allowed', 'denied'];
  for (const scenario of scenarios) test(`actual captured ${workflow} workflow enforces original owner (${scenario})`, async () => {
    const root = makeRepo();
    const restorers: (() => void)[] = [];
    let runtime: ReturnType<typeof createClientRuntimeServices> | undefined;
    let runner: ReturnType<typeof createContractRunner> | undefined;
    let store: ContractStore | undefined;
    let previous: ReturnType<typeof installJudgmentPort> | undefined;
    let portInstalled = false;
    let id: string | undefined;
    let disposed = false;
    const cleanup = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      try { if (runner && id) { runner.cancel(id, 'fixture cleanup'); await runner.join(id); } }
      catch (error) { failures.push(error); }
      for (const restore of restorers.splice(0).reverse()) try { restore(); } catch (error) { failures.push(error); }
      try { runner?.dispose(); } catch (error) { failures.push(error); }
      try { store?.dispose(); } catch (error) { failures.push(error); }
      try { runtime?.dispose(); } catch (error) { failures.push(error); }
      try { if (portInstalled) installJudgmentPort(previous!); } catch (error) { failures.push(error); }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
      activeCleanups.delete(cleanup);
      if (failures.length) throw new AggregateError(failures, 'read workflow fixture cleanup failed');
    };
    activeCleanups.add(cleanup);
    try {
      fs.mkdirSync(join(root, 'src'));
      fs.writeFileSync(join(root, 'allowed.ts'), `export function referenceTarget() { return '${ALLOWED}'; }\nreferenceTarget();\n`);
      fs.writeFileSync(join(root, 'usage.ts'), "import { referenceTarget } from './allowed';\nreferenceTarget();\n");
      fs.writeFileSync(join(root, 'private.ts'), `export function referenceTarget() { return '${PRIVATE}'; }\n`);
      fs.writeFileSync(join(root, 'allowed.tsx'), `export function OwnedWidget() { return <div>${ALLOWED}</div>; }\n`);
      fs.writeFileSync(join(root, 'private.tsx'), `export function PrivateWidget() { return <div>${PRIVATE}</div>; }\n`);
      const git = (...args: string[]) => {
        const result = childProcess.spawnSync('git', ['-C', root, ...args]);
        expect(result.status, result.stderr.toString()).toBe(0);
      };
      git('add', '.'); git('commit', '-qm', 'read workflow fixture sources');
      const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
      config.set('permissions.engine', 'policy-engine'); config.set('permissions.mode', 'prompt');
      config.set('behavior.autoApprove', false); config.set('contract.isolation', 'worktree'); config.set('tools.autoHeal', false);
      const bus = new RuntimeEventBus();
      const services = runtime = createClientRuntimeServices({
        surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
        runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
        providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }),
      });
      await resumeContracts(services.contractRunner, root);
      previous = installJudgmentPort(runnerPort(context => {
        if (context.name === 'family') return choiceAnswer(context.question, 'file-mutation', 0.99);
        if (context.name === 'route' && context.question.type === 'choice'
          && Object.keys(context.question.criteria).sort().join(',') === 'fresh,owner,split')
          return choiceAnswer(context.question, 'owner', 0.99);
        return undefined;
      }).port); portInstalled = true;
      const deny = async (path: string, name: string) => services.userPermissionRuleStore.add({
        rule: { id: name, type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [path] },
        createdAt: Date.now(), tier: 'path', tool: 'read',
      });
      await deny(join(root, 'private.ts'), 'deny-original-private-source');
      await deny(join(root, 'private.tsx'), 'deny-original-private-component');
      if (workflow === 'write-read' && scenario === 'denied') await deny(join(root, 'generated.ts'), 'deny-original-generated-path');
      expect(await services.permissionManager.readAccess(join(root, 'allowed.ts'))).toBe('allow');
      expect(await services.permissionManager.readAccess(join(root, 'private.ts'))).toBe('restricted');
      const target = workflow === 'write-read' ? 'generated.ts'
        : `${scenario === 'denied' ? 'private' : 'allowed'}.${workflow === 'inspection' ? 'tsx' : 'ts'}`;
      // This fixture-only witness runs before the subject tool is admitted. It
      // stores a digest, never bytes in the scripted provider's request/result.
      // Backend reads are observed separately while activeTool is true.
      const fixtureRead = fs.readFileSync;
      const fixtureIdentity = (path: string): string | undefined => fs.existsSync(path)
        ? createHash('sha256').update(fixtureRead(path)).digest('hex') : undefined;
      const originalTargetIdentity = fixtureIdentity(join(root, target));
      let subjectTargetIdentity: string | undefined;
      let subjectAdmissionObserved = false;
      let settledTargetIdentity: string | undefined;
      let subjectSettlementObserved = false;
      const steps: ToolCall[] = workflow === 'references' ? [{ id: 'subject', name: 'find', arguments: {
        queries: [{ id: 'refs', mode: 'references', file: target, symbol: 'referenceTarget', line: 0, column: 16 }],
        output: { format: 'locations', max_results: 20 },
      } }] : workflow === 'inspection' ? [{ id: 'subject', name: 'inspect', arguments: { mode: 'components', projectRoot: '.', file: target } }]
        : workflow === 'analysis' ? [{ id: 'subject', name: 'analyze', arguments: { mode: 'preview', projectRoot: '.', files: [target], find: 'referenceTarget', replace: 'reviewedTarget' } }]
          : workflow === 'edit' ? [
            { id: 'subject', name: 'edit', arguments: { edits: [{ path: target, find: 'export function referenceTarget()', replace: 'export function reviewedTarget()' }] } },
            { id: 'readback', name: 'read', arguments: { files: [{ path: target, force: true }] } },
          ] : [
            { id: 'subject', name: 'write', arguments: { files: [{ path: target, mode: 'overwrite', content: `export const generated = '${GENERATED}';\n` }] } },
            { id: 'readback', name: 'read', arguments: { files: [{ path: target, force: true }] } },
          ];
      steps.push({ id: 'complete-unit', name: 'write', arguments: { files: [{ path: 'src/csv.ts', mode: 'overwrite', content: 'export const parse = () => [];\n' }] } });
      const requests: { planner: boolean; text: string }[] = [];
      const results = new Map<string, ToolResult>();
      const opened: string[] = [];
      const processes: string[] = [];
      let memberCalls = 0; let plannerCalls = 0; let memberRoot = ''; let activeTool = false; let lateBoundary = false;
      const provider: LLMProvider = {
        name: 'read-workflow-fixture', models: ['fixture'], isConfigured: () => true,
        async chat(request) {
          const planner = !request.tools?.some(tool => tool.name === 'write');
          requests.push({ planner, text: JSON.stringify(request) });
          if (planner) { plannerCalls++; return { content: plannerOutput(oneUnitPlan(1)), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }; }
          memberRoot = services.agentManager.list().find(record => record.contractRole === 'unit')!.workingDirectory!;
          const step = steps[memberCalls++];
          if (step?.id === 'subject') {
            subjectTargetIdentity = fixtureIdentity(join(memberRoot, target));
            subjectAdmissionObserved = true;
          }
          activeTool = step !== undefined;
          return { content: step ? '' : 'Created src/csv.ts. The parser works.', toolCalls: step ? [step] : [],
            usage: { inputTokens: 1, outputTokens: 1 }, stopReason: step ? 'tool_call' : 'completed' };
        },
      };
      services.providerRegistry.registerRuntimeProvider({ provider, models: [{
        id: 'fixture', provider: provider.name, registryKey: `${provider.name}:fixture`, displayName: 'Fixture', description: 'In-process read workflow acceptance',
        capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard',
      }], replace: true });
      await services.providerRegistry.ready();
      store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
      const contractRunner = runner = createContractRunner({
        agentManager: services.agentManager, messageBus: services.agentMessageBus, runtimeBus: bus,
        configManager: { get: config.get.bind(config), getCategory: ((name: string) => name === 'contract'
          ? { ...config.getCategory('contract'), gates: [] } : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory },
        projectRoot: root, routeSelector: async () => ({ model: `${provider.name}:fixture`, provider: provider.name, reason: 'scripted read workflow acceptance' }),
        decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: services.agentManager }),
        createEngine: input => createOrchestrationEngine({
          agentManager: services.agentManager, configManager: config, runtimeBus: bus,
          projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace,
          initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
          contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
          runWorktreeSetup: () => undefined,
        }), fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }),
        priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-08' }), store,
        readAccessFilter: async path => await services.permissionManager.readAccess(path) === 'allow',
      });
      services.agentManager.setContractRunner(contractRunner);
      services.agentOrchestrator.setDependencies({ ...services, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: services.workflow,
        contractRunner, contractHooks: { ...contractRunner.hooks(), onTurnEnd(record, turn) {
          for (const result of turn.results) results.set(result.callId, result);
          activeTool = false;
          if (turn.results.some(result => result.callId === 'subject')) {
            settledTargetIdentity = fixtureIdentity(join(memberRoot, target));
            subjectSettlementObserved = true;
          }
          contractRunner.hooks().onTurnEnd(record, turn);
        } },
      });
      // An alternate unbound owner registry is armed and exercised once. A
      // captured run must construct its own genuine registered tool backends.
      let ownerRegistryCalls = 0;
      const ownerRegistry = services.agentOrchestrator.getToolRegistry();
      const subjectName = steps[0]!.name;
      const ownerTool = ownerRegistry.list().find(tool => tool.definition.name === subjectName)!;
      const trap = { definition: ownerTool.definition, async execute() { ownerRegistryCalls++; return { success: true, output: OWNER_REGISTRY }; } };
      expect(ownerRegistry.unregister(subjectName, ownerTool)).toBe(true); ownerRegistry.register(trap);
      expect((await trap.execute()).output).toBe(OWNER_REGISTRY); expect(ownerRegistryCalls).toBe(1);

      const recordOpen = (path: unknown) => { if (activeTool && typeof path === 'string' && path.startsWith(`${root}/`)) opened.push(path); };
      const file = Bun.file;
      const fileTap = spyOn(Bun, 'file').mockImplementation(((...args: Parameters<typeof Bun.file>) => {
        const handle = file(...args); const path = String(args[0]);
        const text = handle.text.bind(handle);
        handle.text = async () => {
          recordOpen(path); const value = await text();
          if (!lateBoundary && activeTool && path === join(memberRoot, 'allowed.ts')
            && (scenario === 'revoke-after-read' || scenario === 'cancel-after-read')) {
            lateBoundary = true;
            if (scenario === 'revoke-after-read') await deny(join(root, 'allowed.ts'), 'revoke-after-reference-read');
            else contractRunner.cancel(id!, 'cancel after admitted reference read');
          }
          return value;
        };
        handle.slice = new Proxy(handle.slice, { apply(slice, receiver, sliceArgs): ReturnType<typeof handle.slice> {
          recordOpen(path); return Reflect.apply(slice, receiver, sliceArgs) as ReturnType<typeof handle.slice>;
        } });
        return handle;
      }) as typeof Bun.file); restorers.push(() => fileTap.mockRestore());
      const readSync = fs.readFileSync;
      const syncTap = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        recordOpen(args[0]); return readSync(...args);
      }) as typeof fs.readFileSync); restorers.push(() => syncTap.mockRestore());
      const openSync = fs.openSync;
      const syncOpenTap = spyOn(fs, 'openSync').mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
        recordOpen(args[0]); return openSync(...args);
      }) as typeof fs.openSync); restorers.push(() => syncOpenTap.mockRestore());
      const read = asyncFs.readFile;
      const asyncTap = spyOn(asyncFs, 'readFile').mockImplementation(((...args: Parameters<typeof asyncFs.readFile>) => {
        recordOpen(args[0]); return read(...args);
      }) as typeof asyncFs.readFile); restorers.push(() => asyncTap.mockRestore());
      const open = asyncFs.open;
      const openTap = spyOn(asyncFs, 'open').mockImplementation(((...args: Parameters<typeof asyncFs.open>) => {
        recordOpen(args[0]); return open(...args);
      }) as typeof asyncFs.open); restorers.push(() => openTap.mockRestore());
      const recordProcess = (command: unknown) => {
        if (activeTool && typeof command === 'string' && basename(command) !== 'git') processes.push(command);
      };
      const spawn = childProcess.spawn;
      const processTap = spyOn(childProcess, 'spawn').mockImplementation(((...args: Parameters<typeof childProcess.spawn>) => {
        recordProcess(args[0]); return spawn(...args);
      }) as typeof childProcess.spawn); restorers.push(() => processTap.mockRestore());
      const bunSpawn = Bun.spawn;
      const bunProcessTap = spyOn(Bun, 'spawn').mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
        const input: unknown = args[0];
        recordProcess(Array.isArray(input) ? input[0] : (input as { cmd?: readonly string[] } | undefined)?.cmd?.[0]);
        return bunSpawn(...args);
      }) as typeof Bun.spawn); restorers.push(() => bunProcessTap.mockRestore());
      const spawnSync = childProcess.spawnSync;
      const syncProcessTap = spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof childProcess.spawnSync>) => {
        recordProcess(args[0]); return spawnSync(...args);
      }) as typeof childProcess.spawnSync); restorers.push(() => syncProcessTap.mockRestore());
      const bunSpawnSync = Bun.spawnSync;
      const bunSyncTap = spyOn(Bun, 'spawnSync').mockImplementation(((...args: Parameters<typeof Bun.spawnSync>) => {
        const input: unknown = args[0];
        recordProcess(Array.isArray(input) ? input[0] : (input as { cmd?: readonly string[] } | undefined)?.cmd?.[0]);
        return bunSpawnSync(...args);
      }) as typeof Bun.spawnSync); restorers.push(() => bunSyncTap.mockRestore());

      id = contractRunner.start({ ask: 'Add a CSV parser module', sessionId: 'read-workflow-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' }).contract.id;
      await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(contractRunner.get(id!)!.status), 'actual read workflow settlement', 30_000);
      const outcome = contractRunner.get(id)!;
      // Cancellation marks status before every owned callback has drained.
      // Observe reads/processes/provider calls only after the real join boundary.
      if (outcome.status !== 'awaiting-owner') await contractRunner.join(id);
      expect(plannerCalls).toBe(1); expect(memberRoot).not.toBe(root); expect(ownerRegistryCalls).toBe(1);
      expect(subjectAdmissionObserved).toBe(true);
      expect(subjectTargetIdentity).toBe(originalTargetIdentity);
      if (workflow === 'write-read') expect(subjectTargetIdentity).toBeUndefined();
      else expect(subjectTargetIdentity).toMatch(/^[a-f0-9]{64}$/);
      expect(processes).toEqual([]);
      expect(opened.some(path => path.endsWith('/private.ts') || path.endsWith('/private.tsx'))).toBe(false);
      for (const request of requests) { expect(request.text).not.toContain(PRIVATE); expect(request.text).not.toContain(OWNER_REGISTRY); }
      const subject = results.get('subject');
      if (scenario === 'revoke-after-read' || scenario === 'cancel-after-read') {
        expect(lateBoundary).toBe(true); expect(memberCalls).toBe(1); expect(outcome.status).not.toBe('passed');
        expect(results.get('complete-unit')).toBeUndefined();
        expect(requests.filter(request => !request.planner)).toHaveLength(1);
        expect(opened).toContain(join(memberRoot, 'allowed.ts'));
      } else {
        expect(outcome.status, JSON.stringify({ error: outcome.error, results: [...results] })).toBe('passed');
        expect(memberCalls).toBe(steps.length + 1);
        if (!(workflow === 'analysis' && scenario === 'denied'))
          expect(subject?.success, JSON.stringify(subject)).toBe(scenario === 'allowed');
        if (scenario === 'denied') {
          expect(subjectSettlementObserved).toBe(true);
          expect(settledTargetIdentity).toBe(subjectTargetIdentity);
          if (workflow === 'analysis') {
            // The existing preview envelope carries a structured read refusal.
            // Its transport success flag is not successful analysis evidence.
            const refusal = JSON.parse(subject!.output!);
            expect(refusal.error).toBe(`Cannot read file: ${target}`);
            expect(refusal.diff).toBeUndefined();
          } else {
            expect(subject?.output).toBeUndefined();
            expect(subject?.error).toMatch(/captured input (?:path is access-restricted|tool held:)/i);
          }
          expect(opened).not.toContain(join(memberRoot, target));
        } else {
          expect(opened).toContain(join(memberRoot, target));
          const delivered = requests.filter(request => !request.planner)[1]!.text;
          if (workflow === 'references') {
            const reference = JSON.parse(subject!.output!).refs;
            expect(reference.source).toBe('grep_fallback'); expect(reference.count).toBeGreaterThanOrEqual(3);
            expect(reference.locations.some((location: { file: string }) => location.file === join(memberRoot, 'allowed.ts'))).toBe(true);
            expect(reference.locations.some((location: { file: string }) => location.file === join(memberRoot, 'usage.ts'))).toBe(true);
            expect(reference.locations.every((location: { file: string }) => !location.file.endsWith('/private.ts'))).toBe(true);
            expect(delivered).toContain('grep_fallback');
          } else if (workflow === 'inspection') {
            const inspection = JSON.parse(subject!.output!);
            expect(inspection.count).toBe(1);
            expect(inspection.components).toEqual([expect.objectContaining({ name: 'OwnedWidget', kind: 'function', line: 1 })]);
            expect(delivered).toContain('OwnedWidget');
          } else if (workflow === 'analysis') {
            const analysis = JSON.parse(subject!.output!);
            expect(analysis.error).toBeUndefined(); expect(analysis.file).toBe(target);
            expect(analysis.diff).toContain('-export function referenceTarget');
            expect(analysis.diff).toContain('+export function reviewedTarget');
            expect(analysis.changed_lines).toBeGreaterThan(0); expect(delivered).toContain('reviewedTarget');
          }
          else {
            const readback = results.get('readback'); expect(readback?.success).toBe(true);
            const content = JSON.parse(readback!.output!).files;
            expect(content).toHaveLength(1);
            expect(content[0].content).toContain(workflow === 'edit' ? 'reviewedTarget' : GENERATED);
            expect(requests.filter(request => !request.planner)[2]!.text).toContain(workflow === 'edit' ? 'reviewedTarget' : GENERATED);
          }
        }
      }
    } finally { await cleanup(); }
  }, 45_000);
}
