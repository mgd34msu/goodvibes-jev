/** Actual AgentManager wake -> new Orchestrator run -> default captured REPL registry. */
import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { TURN_BUDGET_EXHAUSTED } from '../../sdk/src/platform/agents/turn-budget.js';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { createContractInputAuthority, getContractInputAuthority } from '../../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../../sdk/src/platform/contract/types.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import type { LLMProvider, ProviderMessage } from '../../sdk/src/platform/providers/interface.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import { probeCapturedExecAvailability } from '../../sdk/src/platform/tools/exec/captured-exec.js';
import { makeRepo, runnerPort, waitFor } from './runner-support.js';

const availability = await probeCapturedExecAvailability();
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('required captured REPL wake execution backend is unavailable');

test.skipIf(!availability.available)('actual wakeWithSteer reuses captured authority but starts empty REPL run history', async () => {
  const root = makeRepo();
  writeFileSync(join(root, 'input.txt'), 'CAPTURED_FIRST_RUN_RESULT\n');
  expect(childProcess.spawnSync('git', ['-C', root, 'add', '.']).status).toBe(0);
  expect(childProcess.spawnSync('git', ['-C', root, 'commit', '-qm', 'REPL wake source']).status).toBe(0);
  const inputSnapshot = await captureContractInput(root);
  const view = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  expect(childProcess.spawnSync('git', ['-C', root, 'worktree', 'add', '--no-checkout', '-b', branch, view, inputSnapshot.inputCommit]).status).toBe(0);
  await materializeContractInput(inputSnapshot, view);
  const contract = { projectRoot: root, inputSnapshot } as Contract;
  const authority = await createContractInputAuthority(contract, view, { mutable: true, branch });
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
  config.set('permissions.engine', 'policy-engine');
  config.set('permissions.mode', 'prompt');
  config.set('behavior.autoApprove', false);
  config.set('tools.autoHeal', false);
  config.set('agents.maxTurns', 2);
  const runtime = createClientRuntimeServices({
    surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
    runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
    providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }),
  });
  await resumeContracts(runtime.contractRunner, root);
  const previous = installJudgmentPort(runnerPort((context) => {
    if (context.name === 'family') return choiceAnswer(context.question, 'shell-read', 0.99);
    if (context.name === 'kind') return choiceAnswer(context.question, 'shell', 0.99);
    return undefined;
  }).port);
  const requests: ProviderMessage[][] = [];
  const expression = 'require("node:fs").readFileSync("input.txt", "utf8").trim()';
  const steps = [
    { id: 'first-run-eval', name: 'repl', arguments: { mode: 'eval', expression } },
    { id: 'first-run-history', name: 'repl', arguments: { mode: 'history' } },
    { id: 'new-run-history', name: 'repl', arguments: { mode: 'history' } },
  ];
  const provider: LLMProvider = {
    name: 'repl-wake-fixture', models: ['fixture'], isConfigured: () => true,
    async chat(request) {
      requests.push(structuredClone(request.messages));
      expect(request.tools?.map((tool) => tool.name)).toEqual(['repl']);
      const step = steps[requests.length - 1];
      return {
        content: step ? '' : 'The new run has no previous REPL attempts.',
        toolCalls: step ? [step] : [], usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: step ? 'tool_call' : 'completed',
      };
    },
  };
  runtime.providerRegistry.registerRuntimeProvider({ provider, models: [{
    id: 'fixture', provider: provider.name, registryKey: `${provider.name}:fixture`, displayName: 'Fixture', description: 'Synthetic',
    capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard',
  }], replace: true });
  await runtime.providerRegistry.ready();
  const processes = spyOn(childProcess, 'spawn');
  let agentId: string | undefined;
  try {
    const record = runtime.agentManager.spawn({
      mode: 'spawn', task: 'Read captured input and inspect this run’s REPL history.', template: 'engineer',
      workingDirectory: view, outsideContract: true, tools: ['repl'], restrictTools: true,
      executionProtocol: 'direct', reviewMode: 'none', model: 'repl-wake-fixture:fixture',
    }, { inputReadAuthority: authority });
    agentId = record.id;
    await waitFor(() => record.status === 'failed' || record.status === 'completed', 'first captured REPL run settlement', 60_000);
    await runtime.agentManager.join(record.id);
    expect(record.status, record.error).toBe('failed');
    expect(record.failureReason).toBe(TURN_BUDGET_EXHAUSTED);
    expect(getContractInputAuthority(record)).toBe(authority);
    expect(requests).toHaveLength(2);
    const firstHistory = runtime.agentManager.getConversationSnapshot(record.id).find((message) =>
      message.role === 'tool' && message.callId === 'first-run-history');
    expect(firstHistory).toBeDefined();
    const firstHistoryOutput = typeof firstHistory?.content === 'string' ? firstHistory.content : '';
    expect(firstHistoryOutput).toContain('"count":1');
    expect(JSON.parse(firstHistoryOutput)).toMatchObject({
      count: 1, history: [{ expression, result: 'CAPTURED_FIRST_RUN_RESULT\n', sessionId: expect.any(String) }],
    });

    expect(runtime.agentManager.wakeWithSteer(record.id, 'Inspect the REPL history of this new run, then finish.').woke).toBe(true);
    await runtime.agentManager.join(record.id);
    expect(runtime.agentManager.getStatus(record.id)).toBe(record);
    expect(getContractInputAuthority(record)).toBe(authority);
    expect(record.status, record.error).toBe('completed');
    expect(requests).toHaveLength(4);
    const newHistory = requests[3]!.find((message) => message.role === 'tool' && message.callId === 'new-run-history');
    expect(newHistory).toBeDefined();
    expect(JSON.parse(typeof newHistory?.content === 'string' ? newHistory.content : '')).toEqual({ count: 0, history: [] });
    expect(processes.mock.calls.filter(([command, args]) => command === '/usr/bin/bwrap' && Array.isArray(args) &&
      args.some((argument) => argument.includes('--print') && argument.includes(expression)))).toHaveLength(1);
  } finally {
    if (agentId) { runtime.agentManager.cancel(agentId); await runtime.agentManager.join(agentId); }
    processes.mockRestore(); runtime.dispose(); installJudgmentPort(previous);
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
