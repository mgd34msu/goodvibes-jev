/** Real temporary-Git contract -> AgentManager -> AgentOrchestrator -> default REPL registry. */
import { expect, spyOn, test } from 'bun:test';
import * as asyncFs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { getContractInputAuthority, revokeContractInputAuthority } from '../../sdk/src/platform/contract/input-authority.js';
import { createContractRunner } from '../../sdk/src/platform/contract/runner.js';
import { ContractStore } from '../../sdk/src/platform/contract/store.js';
import { createAgentManagerDecompositionRunner } from '../../sdk/src/platform/agents/planner-decomposition-runner.js';
import { createOrchestrationEngine } from '../../sdk/src/platform/orchestration/engine.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import type { LLMProvider, ProviderMessage } from '../../sdk/src/platform/providers/interface.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import { probeCapturedExecAvailability } from '../../sdk/src/platform/tools/exec/captured-exec.js';
import { makeRepo, oneUnitPlan, runnerPort, waitFor } from './runner-support.js';
import { plannerOutput } from './plan-support.js';

const availability = await probeCapturedExecAvailability();
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('required captured REPL integration execution backend is unavailable');

for (const scenario of ['allowed', 'revoke-after-eval'] as const) {
  test.skipIf(!availability.available)(`actual default contract REPL honors captured input authority (${scenario})`, async () => {
    const root = makeRepo();
    const denied = join(root, 'private.mjs');
    writeFileSync(join(root, 'input.txt'), 'COMMITTED_REPL_INPUT\n');
    writeFileSync(join(root, 'allowed.mjs'), 'export const value = "COMMITTED_REPL_MODULE";\n');
    writeFileSync(join(root, 'allowed.ts'), 'export const value: number = 1;\n');
    writeFileSync(denied, 'export const secret = "PRIVATE_REPL_BYTE_MARKER";\n');
    expect(spawnSync('git', ['-C', root, 'add', '.']).status).toBe(0);
    expect(spawnSync('git', ['-C', root, 'commit', '-qm', 'REPL fixture sources']).status).toBe(0);
    // The contract must evaluate the admitted dirty snapshot, not HEAD or a later owner edit.
    writeFileSync(join(root, 'input.txt'), 'DIRTY_CAPTURED_REPL_INPUT\n');
    writeFileSync(join(root, 'allowed.mjs'), 'export const value = "DIRTY_CAPTURED_REPL_MODULE";\n');
    writeFileSync(join(root, 'allowed.ts'), 'export const value: number = 40;\n');
    // Use the supported local archetype configuration to request REPL. The
    // real registerAllTools still constructs every tool and its authority.
    const archetypeDirectory = join(root, '.goodvibes', 'agents');
    mkdirSync(archetypeDirectory, { recursive: true });
    writeFileSync(join(archetypeDirectory, 'engineer.md'), '---\nname: engineer\ndescription: REPL integration engineer\ntools: [read, write, edit, find, exec, analyze, inspect, fetch, registry, repl]\n---\nImplement the assigned unit.\n');
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
    config.set('permissions.engine', 'policy-engine');
    config.set('permissions.mode', 'prompt');
    config.set('behavior.autoApprove', false);
    config.set('contract.isolation', 'worktree');
    config.set('tools.autoHeal', false);
    const bus = new RuntimeEventBus();
    const runtime = createClientRuntimeServices({
      surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
      runtimeBus: bus, runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
      providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }),
    });
    await resumeContracts(runtime.contractRunner, root);
    const previous = installJudgmentPort(runnerPort((context) => {
      if (context.name === 'family') return choiceAnswer(context.question, context.state.tool === 'repl' ? 'shell-read' : 'file-mutation', 0.99);
      if (context.name === 'kind') return choiceAnswer(context.question, 'shell', 0.99);
      return undefined;
    }).port);
    await runtime.userPermissionRuleStore.add({
      rule: { id: 'deny-original-repl-private', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns: [denied] },
      createdAt: Date.now(), tier: 'path', tool: 'read',
    });
    expect(runtime.userPermissionRuleStore.rules().some((rule) => rule.id === 'deny-original-repl-private')).toBe(true);
    expect(await runtime.permissionManager.readAccess(denied)).toBe('restricted');
    expect(await runtime.permissionManager.readAccess(join(root, 'input.txt'))).toBe('allow');

    const requests: { planner: boolean; text: string; messages: ProviderMessage[] }[] = [];
    const executed: { name: string; success: boolean }[] = [];
    const opened: string[] = [];
    const read = asyncFs.readFile;
    const tap = spyOn(asyncFs, 'readFile').mockImplementation(((...args: Parameters<typeof read>) => {
      opened.push(String(args[0]));
      return read(...args);
    }) as typeof read);
    let plannerCalls = 0;
    let memberCalls = 0;
    let revoked = false;
    const steps = [
      { name: 'repl', arguments: {
        mode: 'eval', runtime: 'typescript', bindings: { label: 'PROVIDER_BINDING', increment: 2 },
        expression: [
          'const fs = await import("node:fs");',
          'const module = await import("./allowed.mjs");',
          'const total: number = (await import("./allowed.ts")).value + increment;',
          'const denied: string[] = [];',
          `for (const path of ["./private.mjs", ${JSON.stringify(denied)}]) { try { denied.push(fs.readFileSync(path, "utf8")); } catch { denied.push("DENIED_READ"); } }`,
          'try { denied.push((await import("./private.mjs")).secret); } catch { denied.push("DENIED_IMPORT"); }',
          'JSON.stringify({ captured: fs.readFileSync("input.txt", "utf8").trim(), imported: module.value, total, binding: label, denied })',
        ].join('\n'),
      } },
      { name: 'write', arguments: { files: [{ path: 'src/csv.ts', mode: 'overwrite', content: 'export const parse = () => [];\n' }] } },
    ];
    const provider: LLMProvider = {
      name: 'repl-fixture', models: ['fixture'], isConfigured: () => true,
      async chat(request) {
        const planner = !request.tools?.some((tool) => tool.name === 'write');
        requests.push({ planner, text: JSON.stringify(request), messages: structuredClone(request.messages) });
        if (planner) {
          plannerCalls++;
          return { content: plannerOutput(oneUnitPlan(1)), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
        }
        const turn = ++memberCalls;
        expect(request.tools?.some((tool) => tool.name === 'repl')).toBe(true);
        if (turn === 1) {
          // Observe tool projection reads separately from initial contract capture and maps.
          opened.length = 0;
          writeFileSync(join(root, 'input.txt'), 'LATE_OWNER_REPL_INPUT\n');
          writeFileSync(join(root, 'allowed.mjs'), 'export const value = "LATE_OWNER_REPL_MODULE";\n');
          writeFileSync(join(root, 'allowed.ts'), 'export const value: number = 900;\n');
        }
        const step = steps[turn - 1];
        return {
          content: step ? '' : 'Created src/csv.ts. The parser works.',
          toolCalls: step ? [{ id: `repl-step-${turn}`, name: step.name, arguments: step.arguments }] : [],
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
      routeSelector: async () => ({ model: 'repl-fixture:fixture', provider: 'repl-fixture', reason: 'in-process captured REPL fixture' }),
      decompositionRunner: createAgentManagerDecompositionRunner({ agentManager: runtime.agentManager }),
      createEngine: (input) => createOrchestrationEngine({
        agentManager: runtime.agentManager, configManager: config, runtimeBus: bus,
        projectRoot: input.projectRoot, stateRoot: input.stateRoot, stateNamespace: input.stateNamespace,
        initializeWorktree: input.initializeWorktree, prepareInputAuthority: input.prepareInputAuthority,
        contractUnitSettlement: input.contractUnitSettlement, fleetCapacity: input.fleetCapacity, judgeAttempts: input.judgeAttempts,
        runWorktreeSetup: () => undefined,
      }),
      fleetCapacity: () => ({ active: 0, maxSize: 8, capKey: 'fleet.maxSize' }),
      priceUsage: () => 0, priceProvenance: () => ({ source: 'catalog', asOf: '2026-10-05' }), store,
      readAccessFilter: async (path) => await runtime.permissionManager.readAccess(path) === 'allow',
    });
    runtime.agentManager.setContractRunner(runner);
    runtime.agentOrchestrator.setDependencies({
      ...runtime, configManager: config, workingDirectory: root, surfaceRoot: 'agent', workflowServices: runtime.workflow,
      contractRunner: runner, contractHooks: runner.hooks(),
      toolExecutionObserver(name, _args, success) {
        executed.push({ name, success });
        if (scenario === 'revoke-after-eval' && name === 'repl' && success && !revoked) {
          const member = runtime.agentManager.list().find((record) => record.contractRole === 'unit');
          const authority = member && getContractInputAuthority(member);
          if (!authority) throw new Error('actual REPL member is missing its input authority');
          // This existing observer runs after the real tool result, before the next provider admission.
          revokeContractInputAuthority(authority);
          revoked = true;
        }
      },
    });
    let id: string | undefined;
    try {
      const started = runner.start({ ask: 'Add a CSV parser module', sessionId: 'repl-fixture', origin: 'cli', projectRoot: root, isolation: 'worktree' });
      id = started.contract.id;
      try {
        await waitFor(() => ['passed', 'failed', 'cancelled', 'awaiting-owner'].includes(runner.get(id!)!.status), 'actual captured REPL contract settlement', 60_000);
      } catch (error) {
        throw new Error(JSON.stringify({ error: String(error), status: runner.get(id)?.status, memberCalls, executed, agents: runtime.agentManager.list().map((agent) => ({ role: agent.contractRole, status: agent.status, progress: agent.progress, error: agent.error })), toolMessages: requests.at(-1)?.messages.filter((message) => message.role === 'tool') }));
      }
      const result = runner.get(id)!;
      const member = runtime.agentManager.list().find((record) => record.contractRole === 'unit');
      expect(member?.workingDirectory).toBeDefined();
      expect(member!.workingDirectory).not.toBe(root);
      expect(plannerCalls).toBe(1);
      expect(executed[0], JSON.stringify({ status: result.status, error: result.error, memberError: member?.error, memberCalls, toolMessages: requests.at(-1)?.messages.filter((message) => message.role === 'tool') })).toEqual({ name: 'repl', success: true });
      // A real byte-open tap must see allowed projection reads, but no denied source read.
      expect(opened).toContain(join(member!.workingDirectory!, 'input.txt'));
      expect(opened).toContain(join(member!.workingDirectory!, 'allowed.mjs'));
      expect(opened).toContain(join(member!.workingDirectory!, 'allowed.ts'));
      expect(opened.some((path) => path.endsWith('/private.mjs'))).toBe(false);
      for (const request of requests) {
        expect(request.text).not.toContain('PRIVATE_REPL_BYTE_MARKER');
        expect(request.text).not.toContain('LATE_OWNER_REPL_INPUT');
        expect(request.text).not.toContain('LATE_OWNER_REPL_MODULE');
      }
      const memberRequests = requests.filter((request) => !request.planner);
      if (scenario === 'revoke-after-eval') {
        expect(revoked).toBe(true);
        expect(memberCalls).toBe(1);
        expect(result.status).not.toBe('passed');
        expect(memberRequests.flatMap((request) => request.messages).some((message) => message.role === 'tool' && message.name === 'repl')).toBe(false);
      } else {
        expect(result.status, result.error).toBe('passed');
        expect(memberCalls).toBe(3);
        expect(executed).toEqual([{ name: 'repl', success: true }, { name: 'write', success: true }]);
        const message = memberRequests[1]?.messages.find((entry) => entry.role === 'tool' && entry.name === 'repl');
        expect(message).toBeDefined();
        const output = JSON.parse(typeof message?.content === 'string' ? message.content : '') as { runtime: string; result: string; isolated: boolean; stateless: boolean; error?: string };
        expect(output.runtime).toBe('typescript');
        expect(output.isolated).toBe(true);
        expect(output.stateless).toBe(true);
        expect(output.error).toBeUndefined();
        expect(output.result.length).toBeGreaterThan(0);
        expect(JSON.parse(output.result)).toEqual({
          captured: 'DIRTY_CAPTURED_REPL_INPUT', imported: 'DIRTY_CAPTURED_REPL_MODULE',
          total: 42, binding: 'PROVIDER_BINDING', denied: ['DENIED_READ', 'DENIED_READ', 'DENIED_IMPORT'],
        });
      }
      expect(readFileSync(join(root, 'input.txt'), 'utf8')).toBe('LATE_OWNER_REPL_INPUT\n');
      expect(readFileSync(denied, 'utf8')).toContain('PRIVATE_REPL_BYTE_MARKER');
    } finally {
      tap.mockRestore();
      if (id) runner.cancel(id, 'fixture cleanup');
      runner.dispose();
      if (id) await runner.join(id);
      store.dispose(); runtime.dispose(); installJudgmentPort(previous);
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
}
