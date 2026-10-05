/** Real captured eval, then history cancellation through AgentManager and its registered tool pipeline. */
import { expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../../errors/src/index.js';
import { ConfigManager } from '../../sdk/src/platform/config/index.js';
import { createContractInputAuthority, getContractInputAuthority, registerContractInputReadAssertion } from '../../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../../sdk/src/platform/contract/types.js';
import { createLaunchTolerantProviderRegistry } from '../../sdk/src/platform/providers/index.js';
import type { LLMProvider, ProviderMessage } from '../../sdk/src/platform/providers/interface.js';
import { createClientRuntimeServices } from '../../sdk/src/platform/runtime/bootstrap.js';
import { resumeContracts } from '../../sdk/src/platform/runtime/contract-composition.js';
import { RuntimeEventBus, createRuntimeStore } from '../../sdk/src/platform/runtime/state.js';
import { probeCapturedExecAvailability } from '../../sdk/src/platform/tools/exec/captured-exec.js';
import { makeRepo, runnerPort } from './runner-support.js';

const availability = await probeCapturedExecAvailability();
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !availability.available)
  throw new Error('required captured REPL cancellation execution backend is unavailable');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
async function observed<T>(promise: Promise<T>, ms: number) {
  return Promise.race([promise.then(value => ({ state: 'settled', value })), Bun.sleep(ms).then(() => ({ state: 'pending' }))]);
}

for (const policy of ['readAccessFilter', 'registeredReadAssertion'] as const) {
  test.skipIf(!availability.available)(`actual captured Agent history cancellation while ${policy} remains pending`, async () => {
    const root = makeRepo();
    // One actual captured file keeps repeated authority/readset checks focused.
    rmSync(join(root, 'README.md'));
    expect(childProcess.spawnSync('git', ['-C', root, 'add', '.']).status).toBe(0);
    expect(childProcess.spawnSync('git', ['-C', root, 'commit', '-qm', 'history cancellation fixture']).status).toBe(0);
    const inputSnapshot = await captureContractInput(root);
    const view = contractInputPath(inputSnapshot);
    const branch = `input/${inputSnapshot.id}`;
    expect(childProcess.spawnSync('git', ['-C', root, 'worktree', 'add', '--no-checkout', '-b', branch, view, inputSnapshot.inputCommit]).status).toBe(0);
    await materializeContractInput(inputSnapshot, view);
    const authority = await createContractInputAuthority({ projectRoot: root, inputSnapshot } as Contract, view, { mutable: true, branch });
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, '.goodvibes', 'cfg'), workingDir: root, homeDir: root });
    config.set('permissions.engine', 'policy-engine');
    config.set('permissions.mode', 'prompt');
    config.set('behavior.autoApprove', false);
    config.set('tools.autoHeal', false);
    config.set('agents.maxTurns', 5);
    const runtime = createClientRuntimeServices({
      surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
      runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
      providerRegistryFactory: createLaunchTolerantProviderRegistry, requestApproval: async () => ({ approved: true }),
    });
    await resumeContracts(runtime.contractRunner, root);
    const previous = installJudgmentPort(runnerPort(context => {
      if (context.name === 'family') return choiceAnswer(context.question, 'shell-read', 0.99);
      if (context.name === 'kind') return choiceAnswer(context.question, 'shell', 0.99);
      return undefined;
    }).port);
    const hold = deferred<void>();
    const entered = deferred<void>();
    const historyRequested = deferred<void>();
    const latePolicyFinished = deferred<void>();
    let armed = false;
    let released = false;
    let callbackCalls = 0;
    const requests: ProviderMessage[][] = [];
    // The callback never resolves in response to cancellation. Explicit cleanup
    // releases it only AFTER the cancellation settlement observation is saved.
    async function maybeHold() {
      if (armed && !released) {
        callbackCalls++;
        if (policy === 'registeredReadAssertion' && callbackCalls === 1) return;
        entered.resolve();
        await hold.promise;
        if (policy === 'registeredReadAssertion') latePolicyFinished.resolve();
      }
    }
    if (policy === 'registeredReadAssertion') registerContractInputReadAssertion(authority, maybeHold);
    const originalRead = runtime.permissionManager.readAccess.bind(runtime.permissionManager);
    const readTap = policy === 'readAccessFilter' ? spyOn(runtime.permissionManager, 'readAccess').mockImplementation(async path => {
      await maybeHold();
      const result = await originalRead(path);
      if (released) latePolicyFinished.resolve();
      return result;
    }) : undefined;
    const expression = '"REAL_HISTORY_CANCELLATION_RESULT"';
    const steps = [
      { id: 'seed-eval', name: 'repl', arguments: { mode: 'eval', expression } },
      { id: 'cancel-history', name: 'repl', arguments: { mode: 'history' } },
    ];
    const provider: LLMProvider = {
      name: 'history-cancellation-fixture', models: ['fixture'], isConfigured: () => true,
      async chat(request) {
        requests.push(structuredClone(request.messages));
        expect(request.tools?.map(tool => tool.name)).toEqual(['repl']);
        if (requests.length === 2) {
          const prior = request.messages.find(message => message.role === 'tool' && message.callId === 'seed-eval');
          expect(prior).toBeDefined();
          expect(JSON.parse(typeof prior?.content === 'string' ? prior.content : '')).toMatchObject({
            result: 'REAL_HISTORY_CANCELLATION_RESULT\n', isolated: true, stateless: true,
          });
          armed = true;
          historyRequested.resolve();
        }
        const step = steps[requests.length - 1];
        return { content: step ? '' : 'Done.', toolCalls: step ? [step] : [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: step ? 'tool_call' : 'completed' };
      },
    };
    runtime.providerRegistry.registerRuntimeProvider({ provider, models: [{
      id: 'fixture', provider: provider.name, registryKey: `${provider.name}:fixture`, displayName: 'Fixture', description: 'Synthetic provider; real REPL',
      capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 100_000, selectable: true, tier: 'standard',
    }], replace: true });
    await runtime.providerRegistry.ready();
    const processes = spyOn(childProcess, 'spawn');
    let agentId: string | undefined;
    try {
      const record = runtime.agentManager.spawn({
        mode: 'spawn', task: 'Evaluate the captured REPL expression, then inspect its history.', template: 'engineer',
        workingDirectory: view, outsideContract: true, tools: ['repl'], restrictTools: true,
        executionProtocol: 'direct', reviewMode: 'none', model: 'history-cancellation-fixture:fixture',
      }, { inputReadAuthority: authority });
      agentId = record.id;
      // Bound the real eval and the pending-policy entry separately: the
      // latter should not inherit time already spent doing contained work.
      expect((await observed(historyRequested.promise, 45_000)).state,
        `real eval did not reach history: ${record.status} ${record.error}`).toBe('settled');
      expect((await observed(entered.promise, 5_000)).state,
        `history policy not entered: callbacks=${callbackCalls} progress=${record.progress}`).toBe('settled');
      expect(getContractInputAuthority(record)).toBe(authority);
      const execution = runtime.agentManager.join(record.id);
      const beforeCancel = await observed(execution, 50);
      expect(beforeCancel.state).toBe('pending');
      const cancelled = runtime.agentManager.cancel(record.id);
      const afterCancel = await observed(execution, 2_000);
      const duringSnapshot = runtime.agentManager.getConversationSnapshot(record.id);
      const pendingCallResult = duringSnapshot.find(message => message.role === 'tool' && message.callId === 'cancel-history');
      expect(cancelled).toBe(true);
      expect(record.status).toBe('cancelled');
      expect(pendingCallResult).toBeDefined();
      expect(JSON.stringify(pendingCallResult)).not.toContain('REAL_HISTORY_CANCELLATION_RESULT');
      expect(requests).toHaveLength(2);
      // A signal-ignoring policy must not strand the actual registered run.
      expect(afterCancel.state).toBe('settled');
      const callsAtCancellation = callbackCalls;
      released = true; hold.resolve();
      expect((await observed(latePolicyFinished.promise, 2_000)).state).toBe('settled');
      await Bun.sleep(20);
      expect(callbackCalls).toBe(callsAtCancellation);
      const finalResult = runtime.agentManager.getConversationSnapshot(record.id).find(message => message.role === 'tool' && message.callId === 'cancel-history');
      expect(JSON.stringify(finalResult)).not.toContain('REAL_HISTORY_CANCELLATION_RESULT');
      expect(requests).toHaveLength(2);
      expect(processes.mock.calls.filter(([command, args]) => command === '/usr/bin/bwrap' && Array.isArray(args) &&
        args.some(argument => argument.includes('--print') && argument.includes(expression)))).toHaveLength(1);
    } finally {
      released = true; hold.resolve();
      if (agentId) { runtime.agentManager.cancel(agentId); await runtime.agentManager.join(agentId); }
      processes.mockRestore(); readTap?.mockRestore(); runtime.dispose(); installJudgmentPort(previous);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}
