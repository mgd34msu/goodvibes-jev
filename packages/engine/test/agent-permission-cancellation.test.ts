/** Engine-only probe. Imports public APIs; all stores and writes are synthetic temporary data. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ApprovalBroker } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createClientRuntimeServices } from '@goodvibes-jev/engine/sdk/platform/runtime/bootstrap';
import { createRuntimeStore, RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createLaunchTolerantProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';
import { UserPermissionRuleStore } from '@goodvibes-jev/engine/sdk/platform/permissions';

async function waitFor(predicate: () => boolean, label: string, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test.each(['active', 'pending', 'handoff'] as const)('actual Agent permission lifecycle, mode=%s', async (mode) => {
  const cancel = mode !== 'active';
  const root = mkdtempSync(join(tmpdir(), 'engine-permission-cancel-'));
  // Isolate project discovery from the enclosing checkout. No shell tool executes.
  execFileSync('git', ['init', '-q'], { cwd: root });
  const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(root, 'cfg'), workingDir: root, homeDir: root });
  config.set('permissions.mode', 'prompt');
  config.set('behavior.autoApprove', false);
  const broker = new ApprovalBroker({ storePath: join(root, 'approvals.json') });
  await broker.start();
  const runtime = createClientRuntimeServices({
    surfaceRoot: 'agent', configManager: config, workingDir: root, homeDirectory: root,
    runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), modelDiscovery: 'skip',
    providerRegistryFactory: createLaunchTolerantProviderRegistry,
    requestApproval: (input) => broker.requestApproval({ ...input, sessionId: 'fixture-session' }),
  });
  let agentId: string | undefined;
  if (mode === 'handoff') {
    const check = runtime.permissionManager.checkDetailed.bind(runtime.permissionManager);
    runtime.permissionManager.checkDetailed = async (...input) => {
      const decision = await check(...input);
      if (decision.approved && agentId !== undefined) queueMicrotask(() => runtime.agentManager.cancel(agentId!));
      return decision;
    };
  }
  const path = 'synthetic-permission-write.txt';
  const args = { files: [{ path, content: 'synthetic content' }] };
  let calls = 0;
  const providerEntered = Promise.withResolvers<void>();
  const providerRelease = Promise.withResolvers<void>();
  runtime.providerRegistry.registerRuntimeProvider({
    provider: {
      name: 'permission-fixture', models: ['fixture'], isConfigured: () => true,
      async chat() {
        calls++;
        if (calls === 1 && mode === 'pending') { providerEntered.resolve(); await providerRelease.promise; }
        return { content: calls === 1 ? '' : 'Synthetic task ended.',
          toolCalls: calls === 1 ? [{ id: 'fixture-write', name: 'write', arguments: args }] : [],
          usage: { inputTokens: 1, outputTokens: 1 }, stopReason: calls === 1 ? 'tool_call' : 'completed' };
      },
    },
    models: [{ id: 'fixture', provider: 'permission-fixture', registryKey: 'permission-fixture:fixture', displayName: 'Fixture', description: 'Synthetic provider', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 4096, selectable: true, tier: 'standard' }],
    replace: true,
  });
  await runtime.providerRegistry.ready();
  const previous = installJudgmentPort(fakePort((name, question, state) => {
    expect(state).toMatchObject({ tool: 'write', arguments: args });
    if (name === 'family') return choiceAnswer(question, 'file-mutation', 0.99);
    if (name === 'mutates') return noulAnswer(0.99);
    if (['outward', 'secrets', 'irreversible', 'beyondProject', 'weakensSecurity', 'cardDetails'].includes(name)) return noulAnswer(0.01);
    throw new Error(`Unscripted synthetic reading: ${name}`);
  }).port);
  let finished!: () => void;
  const done = new Promise<void>((resolve) => { finished = resolve; });
  let settled = false;
  let executionError: unknown;
  runtime.agentManager.setExecutor({ async runAgent(record) {
    try { await runtime.agentOrchestrator.runAgent(record); }
    catch (error) { executionError = error; throw error; }
    finally { settled = true; finished(); }
  } });
  try {
    const record = runtime.agentManager.spawn({ mode: 'spawn', outsideContract: true, template: 'general', task: 'Write the synthetic permission fixture', tools: ['write'], model: 'permission-fixture:fixture', provider: 'permission-fixture' });
    agentId = record.id;
    if (mode === 'pending') {
      await providerEntered.promise;
      expect(runtime.agentManager.cancel(record.id)).toBe(true);
      providerRelease.resolve();
    }
    await waitFor(() => settled, 'the agent execution to finish'); await done;
    expect(broker.listApprovals()).toEqual([]);
    expect(existsSync(join(root, path))).toBe(!cancel);
    const persisted = new UserPermissionRuleStore(join(config.getControlPlaneConfigDir(), 'permission-rules.json'));
    await persisted.init(); expect(persisted.list()).toEqual([]);
    expect(record.status).toBe(cancel ? 'cancelled' : 'completed');
    expect(await runtime.permissionManager.checkDetailed('write', args)).toMatchObject({ approved: true, persisted: false, sourceLayer: 'config_policy' });
    if (!cancel) expect(executionError).toBeUndefined();
  } finally {
    providerRelease.resolve();
    for (const item of broker.listApprovals()) if (item.status === 'pending' || item.status === 'claimed') await broker.cancelApproval(item.id, 'fixture-cleanup');
    await done;
    installJudgmentPort(previous);
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
