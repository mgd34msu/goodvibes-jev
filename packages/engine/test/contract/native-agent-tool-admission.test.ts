/** Actual native durable contract -> phase runner -> AgentManager -> AgentOrchestrator -> prepared tool admission. */
import { expect, spyOn, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createSystemOnePort, PINNED_MODEL, SqliteDecisionLog, withDecisionLog,
  type JudgmentPort, type JudgmentRequest, type Questions,
} from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { createAgentManagerDecompositionRunner } from '../../sdk/src/platform/agents/planner-decomposition-runner.js';
import { ContractStore, createContractRunner, type NativeContractSource } from '../../sdk/src/platform/contract/index.js';
import { getContractInputAuthority } from '../../sdk/src/platform/contract/input-authority.js';
import { getContractActionSource } from '../../sdk/src/platform/tools/agent/contract-binding.js';
import { createOrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import { PermissionManager, createPermissionConfigReader, type GateOptions } from '../../sdk/src/platform/permissions/manager.js';
import { PolicyRuntimeState } from '../../sdk/src/platform/runtime/permissions/policy-runtime.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import type { LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import { ReadTool } from '../../sdk/src/platform/tools/read/index.js';
import { hasCapturedToolInvocation } from '../../sdk/src/platform/tools/shared/captured-input-tools.js';
import type { ToolResult } from '../../sdk/src/platform/types/tools.js';
import { forgetGateReadings, gateReadingsPort } from '../_helpers/gate-readings.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

const SOURCE: NativeContractSource = {
  sourceId: 'original-native-tool-source', sourceRevision: 'source-3', inputRevision: 'input-2',
  criteriaId: 'ordered-original-criteria', criteriaRevision: 'criteria-4',
  goal: '  Inspect the original captured project.\nPreserve exact source ☃. ',
  criteria: [' First exact requirement. ', 'Second requirement\nwith its complete second line.'],
};
const ORIGINAL_MARKER = 'CAPTURED_ORIGINAL_READ_BODY';
const LATER_MARKER = 'LATER_OWNER_BYTES_MUST_NOT_BE_READ';
const REVISED_MARKER = 'HOST_REVISED_READ_BODY';
const TOOL_SITE = 'engine.gate.autonomous-tool';
const readArgs = (path = 'README.md') => ({ files: [{ path }] });

for (const scenario of ['act', 'reject', 'defer', 'revise', 'unrecorded', 'cancel-retry', 'planner-act'] as const) {
  test(`actual native sub-agent tool admission ${scenario} retains source, recording and captured authority`, async () => {
    forgetGateReadings();
    const root = makeRepo();
    writeFileSync(join(root, 'README.md'), `${ORIGINAL_MARKER}\n`);
    writeFileSync(join(root, 'alternative.txt'), `${REVISED_MARKER}\n`);
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
    config.set('permissions.mode', 'prompt');
    config.set('behavior.autoApprove', false);
    config.set('contract.isolation', 'worktree');
    config.set('tools.autoHeal', false);
    const log = new SqliteDecisionLog(':memory:');
    const bus = new RuntimeEventBus();
    let humanPrompts = 0;
    const runtime = createClientRuntimeServices({
      surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
      runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
      providerRegistryFactory: createLaunchTolerantProviderRegistry,
      requestApproval: async () => { humanPrompts++; return { approved: false }; },
    });
    await resumeContracts(runtime.contractRunner, root);
    const gate = gateReadingsPort();
    const planning = runnerPort();
    const semanticRequests: JudgmentRequest<Questions>[] = [];
    let semanticCalls = 0;
    const semantic = fakePort((_name, question) => {
      const choice = scenario === 'revise' ? ++semanticCalls === 1 ? 'revise_0' : 'act'
        : scenario === 'defer' ? 'defer_0' : scenario === 'reject' ? 'reject' : 'act';
      return choiceAnswer(question, choice, 0.99);
    });
    const rawPort: JudgmentPort = {
      model: planning.port.model,
      async ask(request) {
        request.signal?.throwIfAborted(); request.beforeAttempt?.();
        if (request.context?.site === TOOL_SITE) {
          semanticRequests.push(request as JudgmentRequest<Questions>);
          return semantic.port.ask(request);
        }
        if (request.context?.site?.startsWith('engine.gate')) return gate.port.ask(request);
        return planning.port.ask(request);
      },
    };
    const previous = installJudgmentPort(withDecisionLog(rawPort, log));
    const choices: GateOptions = scenario === 'revise' ? { autonomousChoices: () => ({ revisions: [{
      ref: { id: 'read-alternative', revision: '1', kind: 'revise-action' }, toolName: 'read', args: readArgs('alternative.txt'),
    }] }) } : {};
    const permissions = new PermissionManager(async () => { humanPrompts++; return { approved: false, remember: false }; },
      createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, choices);
    const bodies: { args: Record<string, unknown>; captured: boolean; claimIds: string[] }[] = [];
    const read = ReadTool.prototype.execute;
    const intercepted = spyOn(ReadTool.prototype, 'execute').mockImplementation(async function(this: ReadTool, args) {
      const claims = log.query({ site: TOOL_SITE }).filter(entry => entry.status === 'answered'
        && entry.notes.some(note => note.kind === 'action' && note.action.startsWith('autonomous:claim:')));
      bodies.push({ args: structuredClone(args), captured: hasCapturedToolInvocation(), claimIds: claims.map(entry => entry.id) });
      return read.call(this, args);
    });
    const results: ToolResult[] = [];
    const providerRequests: string[] = [];
    let modelCalls = 0;
    const provider: LLMProvider = {
      name: 'native-tool-fixture', models: ['fixture'], isConfigured: () => true,
      async chat(request) {
        providerRequests.push(JSON.stringify(request));
        const turn = ++modelCalls;
        if (scenario === 'planner-act' && turn === 2) {
          return { content: plannerOutput(plan), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
        }
        if (turn === 1 || (scenario === 'planner-act' && turn === 3)) {
          // Capture has already happened. The real reader must still see the admitted generation.
          writeFileSync(join(root, 'README.md'), `${LATER_MARKER}\n`);
          return { content: '', toolCalls: [{ id: `original-native-read-${turn}`, name: 'read', arguments: readArgs() }],
            usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call' };
        }
        return new Promise<never>((_resolve, reject) => {
          if (!request.signal) { reject(new Error('Actual native provider lacks its owned signal')); return; }
          if (request.signal.aborted) { reject(request.signal.reason); return; }
          request.signal.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
        });
      },
    };
    runtime.providerRegistry.registerRuntimeProvider({ provider, models: [{
      id: 'fixture', provider: provider.name, registryKey: `${provider.name}:fixture`, displayName: 'Native tool fixture', description: 'Synthetic bounded provider',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard',
    }], replace: true });
    await runtime.providerRegistry.ready();
    const plan = oneUnitPlan(2);
    plan.goal = SOURCE.goal;
    plan.criteria = SOURCE.criteria.map((text, index) => ({ id: `c${index + 1}`, text, quote: text }));
    plan.groups[0]!.units[0]!.criteria = SOURCE.criteria.map((_text, index) => ({ id: `u1.c${index + 1}`, text: `Original requirement ${index + 1} holds`, serves: [`c${index + 1}`] }));
    const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
    const runner = createContractRunner({
      agentManager: runtime.agentManager, messageBus: runtime.agentMessageBus, runtimeBus: bus,
      configManager: {
        get: config.get.bind(config),
        getCategory: ((name: string) => name === 'contract' ? { ...config.getCategory('contract'), gates: [] }
          : config.getCategory(name as Parameters<typeof config.getCategory>[0])) as typeof config.getCategory,
      },
      projectRoot: root, store,
      nativeDecisions: { authorityOf: () => ({ authorityId: 'native-owner', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' }),
        onRetry(contractId) {
          if (scenario !== 'cancel-retry') return;
          sawWaiting = runner.get(contractId)?.nativeWaiting?.requests.length === 1;
          runner.cancel(contractId, 'cancel actual native tool admission backoff');
        },
      },
      durableAdmission: { withCurrent: (_admission, launch) => launch(() => undefined) },
      decompositionRunner: scenario === 'planner-act' ? createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager })
        : { run: async () => ({ status: 'completed', output: plannerOutput(plan), elapsedMs: 1 }) },
      routeSelector: async () => ({ model: `${provider.name}:fixture`, provider: provider.name, reason: 'actual native tool fixture' }),
      repositoryMap: async () => 'Fixture repository',
      createEngine: input => createOrchestrationEngine({
        agentManager: runtime.agentManager, configManager: config, runtimeBus: bus,
        projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace,
        initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
        contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
        runWorktreeSetup: () => undefined,
      }),
      fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }),
      priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-04' }),
      readAccessFilter: async path => await permissions.readAccess(path) === 'allow',
    });
    runtime.agentManager.setContractRunner(runner);
    runtime.agentOrchestrator.setDependencies({
      ...runtime, permissionManager: permissions, configManager: config, workingDirectory: root,
      surfaceRoot: 'agent', workflowServices: runtime.workflow, contractRunner: runner,
      contractHooks: { ...runner.hooks(), onTurnEnd(record, turn) { results.push(...turn.results); runner.hooks().onTurnEnd(record, turn); } },
    });
    let attempts = 0; let sawWaiting = false; let sourceBound = false; let inputBound = false; let agentId: string | undefined;
    const boundRoles: string[] = [];
    runtime.agentManager.setExecutor({ runAgent: async record => {
      agentId = record.id;
      boundRoles.push(record.template === 'planner' ? 'planner' : 'unit');
      if (record.template === 'planner') {
        expect(record.tools).not.toContain('write'); expect(record.tools).not.toContain('edit'); expect(record.tools).not.toContain('exec');
      }
      // Keep this regression on the actual native tool admission path, independent of the exec sandbox backend.
      record.tools = ['read'];
      sourceBound = getContractActionSource(record) !== undefined;
      inputBound = getContractInputAuthority(record) !== undefined;
      expect(getContractActionSource(record)?.()).toEqual({ goal: SOURCE.goal, criteria: [...SOURCE.criteria] });
      expect(getContractActionSource({ ...record })).toBeUndefined();
      expect(getContractInputAuthority({ ...record })).toBeUndefined();
      if (scenario === 'unrecorded') installJudgmentPort(rawPort);
      if (scenario === 'cancel-retry') {
        const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' },
          model: PINNED_MODEL, timeoutMs: 1000, retry: { backoffInitialMs: 2, backoffMaxMs: 2, backoffJitter: 0 },
          fetch: async (_url, init) => {
            const wire = JSON.parse(String(init?.body)) as JudgmentRequest<Questions>;
            if ('disposition' in wire.questions) {
              attempts++;
              return Response.json({}, { status: 503 });
            }
            const response = await gate.port.ask(wire);
            return Response.json({ model: PINNED_MODEL, answers: response.answers, usage: { input_tokens: 1, output_tokens: 1 } });
          },
        });
        installJudgmentPort(withDecisionLog(transport, log));
      }
      await runtime.agentOrchestrator.runAgent(record);
    } });
    let id: string | undefined;
    try {
      const admitted = await runner.startDurable({
        key: { workId: 'owning-work', criteriaId: SOURCE.criteriaId, criteriaRevision: SOURCE.criteriaRevision, attemptId: 'attempt-1' },
        binding: { sourceId: SOURCE.sourceId, inputRevision: SOURCE.inputRevision, actionId: 'start-native', actionRevision: '1',
          authorityId: 'native-owner', authorityRevision: '1', scopeId: 'project', scopeRevision: '1' },
        input: { ask: 'A short display ask without the complete source.', nativeSource: SOURCE, sessionId: 'actual-native-tool', origin: 'cli', projectRoot: root, isolation: 'worktree' },
      });
      id = admitted.admission.contractId;
      await waitFor(() => results.length > 0 || ['failed', 'cancelled'].includes(runner.get(id!)!.status), 'actual native tool settlement', 15_000);
      expect(sourceBound).toBe(true); expect(inputBound).toBe(true); expect(humanPrompts).toBe(0);
      expect(modelCalls).toBeGreaterThan(0);
      if (scenario === 'cancel-retry') {
        await runner.join(id);
        expect(attempts).toBe(1); expect(bodies).toHaveLength(0);
        expect(sawWaiting).toBe(true); expect(runner.get(id)!.nativeWaiting).toBeUndefined();
        expect(runtime.agentManager.getStatus(agentId!)?.status).toBe('cancelled');
        expect(log.query({ site: TOOL_SITE })).toMatchObject([{ status: 'failed' }]);
      } else {
        expect(results).toHaveLength(1);
        const result = results[0]!;
        if (scenario === 'unrecorded') {
          expect(result.success).toBe(false); expect(result.error).toContain('record');
          expect(result.autonomousDecision).toBeUndefined(); expect(bodies).toHaveLength(0);
        } else {
          expect(result.autonomousDecision?.outcome, JSON.stringify(result)).toBe(scenario === 'revise' || scenario === 'planner-act' ? 'act' : scenario);
          expect(semanticRequests).toHaveLength(scenario === 'revise' || scenario === 'planner-act' ? 2 : 1);
          for (const request of semanticRequests) expect((request.state as { input: { source: unknown } }).input.source).toEqual({ goal: SOURCE.goal, criteria: [...SOURCE.criteria] });
          for (const decisionId of result.autonomousDecision!.judgmentDecisionIds) expect(log.get(decisionId)?.status).toBe('answered');
          if (scenario === 'act' || scenario === 'revise' || scenario === 'planner-act') {
            expect(result.success, result.error).toBe(true); expect(bodies).toHaveLength(scenario === 'planner-act' ? 2 : 1);
            for (const [index, body] of bodies.entries()) {
              expect(body.args).toEqual(readArgs(scenario === 'revise' ? 'alternative.txt' : 'README.md'));
              expect(body.captured).toBe(true); expect(body.claimIds).toHaveLength(index + 1);
            }
            expect(result.output).toContain(scenario === 'revise' ? REVISED_MARKER : ORIGINAL_MARKER);
            expect(result.output).not.toContain(LATER_MARKER);
            expect(bodies.at(-1)!.claimIds.some(id => result.autonomousDecision!.judgmentDecisionIds.includes(id))).toBe(true);
          } else {
            expect(result.success).toBe(false); expect(result.denial?.scope).toBe('jev_decision'); expect(bodies).toHaveLength(0);
          }
        }
      }
      expect(boundRoles).toEqual(scenario === 'planner-act' ? ['planner', 'unit'] : ['unit']);
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(`${LATER_MARKER}\n`);
      expect(providerRequests.some(text => text.includes(LATER_MARKER))).toBe(false);
    } finally {
      if (id) runner.cancel(id, 'bounded native tool fixture complete');
      runner.dispose(); if (id) await runner.join(id);
      intercepted.mockRestore(); store.dispose(); runtime.dispose(); installJudgmentPort(previous);
      log[Symbol.dispose](); forgetGateReadings(); rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
}
