/**
 * Fleet-plane adoption: proves that an orchestrator-spawned agent surfaces on
 * the SDK's fleet ProcessRegistry (runtime/fleet/*), and that a background
 * permission ask brokered through the permission manager flips that agent's
 * ProcessNode to needs-input attention, clearing again once the ask is
 * resolved. This is the behavior a user watching the webui's FleetView relies
 * on to see this agent's sub-agents and their blocked-on-input asks.
 *
 * Two tests:
 *  1. `agentManager.spawn()` (the real orchestrator-spawning path, the same
 *     AgentManager instance the production fleet ProcessRegistry is built
 *     over, see runtime/services.ts's createArchivableFleetRegistry call)
 *     registers a node the registry can query.
 *  2. A `write`-tool call under permissions.mode:'prompt' brokers its ask
 *     through the real ApprovalBroker with `metadata.agentId` attached (the
 *     bootstrap-core.ts `approvalMetadataForRequest` wiring this round adds)
 *    , the fleet registry attributes the pending approval to that agent's
 *     node (`state:'awaiting-approval'`, `needsAttention:{reason:'approval'}`)
 *     while it's pending, and clears once the approval resolves.
 */
import { describe, test, expect, mock } from 'bun:test';
import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentOrchestrator } from '@goodvibes-jev/engine/sdk/platform/agents';
import type { AgentRecord } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { LLMProvider, ChatRequest, ChatResponse } from '@goodvibes-jev/engine/sdk/platform/providers';
import { FileStateCache } from '@goodvibes-jev/engine/sdk/platform/state';
import { MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { ProjectIndex } from '@goodvibes-jev/engine/sdk/platform/state';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { createArchivableFleetRegistry } from '@goodvibes-jev/engine/terminal-shell';
import { PolicyRuntimeState } from '@/runtime/index.ts';
import { approvalMetadataForRequest } from '../../runtime/bootstrap-core.ts';
import { getTestRuntimeServices, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { forgetCatastrophicReadings } from '@goodvibes-jev/engine/sdk/platform/gate';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

/** Build a minimal AgentRecord for testing (mirrors orchestrator.test.ts's helper). */
function makeRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'agent-fleet-01',
    task: 'Write a hello world program',
    template: 'general',
    tools: [],
    status: 'pending',
    startedAt: Date.now(),
    orchestrationDepth: 0,
    toolCallCount: 0,
    executionProtocol: 'gather-plan-apply',
    reviewMode: 'contract',
    communicationLane: 'direct',
    ...overrides,
  };
}

/** Build a mock LLMProvider that returns pre-programmed responses in order. */
function makeMockProvider(
  responses: Array<{ content: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }>,
): LLMProvider {
  let idx = 0;
  return {
    name: 'mock',
    models: ['mock-model'],
    chat: mock(async (_params: ChatRequest): Promise<ChatResponse> => {
      const resp = responses[idx] ?? responses[responses.length - 1];
      idx++;
      const toolCalls = resp.toolCalls ?? [];
      return {
        content: resp.content,
        toolCalls,
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: toolCalls.length > 0 ? 'tool_call' : 'completed',
      };
    }),
  };
}

const MOCK_MODEL = {
  id: 'mock-model',
  provider: 'mock',
  registryKey: 'mock:mock-model',
  displayName: 'Mock',
  description: '',
  capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
  contextWindow: 128000,
  selectable: true,
};

async function waitFor(predicate: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('fleet plane adoption', () => {
  test('an orchestrator-spawned agent appears on the fleet surface', () => {
    resetTestRuntimeServices();
    const runtime = getTestRuntimeServices();
    // 'Stuck task' is AgentManager's own test hook: spawn() still registers
    // and tracks the record, it just skips invoking the executor (see
    // streaming.test.ts). That is exactly what this test needs, a real
    // record registered through the real orchestrator-spawning path
    // (agentManager.spawn), with no LLM/tool plumbing required to observe it
    // on the fleet surface.
    const record = runtime.agentManager.spawn({ mode: 'spawn', task: 'Stuck task', template: 'general', tools: [] });

    const snapshot = runtime.processRegistry.query({ kinds: ['agent'] });
    const node = snapshot.nodes.find((n) => n.id === record.id);

    expect(node).toBeDefined();
    expect(node?.kind).toBe('agent');
    expect(node?.task).toBe('Stuck task');
  });

  test('an ask-mode permission ask flips the spawned agent to needs-input attention and clears on resolution', async () => {
    resetTestRuntimeServices();
    const runtime = getTestRuntimeServices();

    const memoryDbPath = join(makeProjectTempDir('fleet-attention-db'), `fleet-attention-${randomUUID()}.db`);
    // The helper already adds a unique suffix. UUID digit runs can look like
    // card material to the real privacy guard and prevent this ordinary write's ask.
    const projectIndexRoot = makeProjectTempDir('fleet-attention-project');
    const memoryStore = new MemoryStore(memoryDbPath, { embeddingRegistry: runtime.memoryEmbeddingRegistry });
    const memoryRegistry = new MemoryRegistry(memoryStore);
    const fileCache = new FileStateCache();
    const projectIndex = new ProjectIndex(projectIndexRoot);
    await Promise.all([memoryStore.init(), projectIndex.load()]);

    // Install after runtime construction: the real gate sees an ordinary
    // state-changing write and therefore brokers the normal preset's ask.
    forgetCatastrophicReadings();
    const previousJudgmentPort = installJudgmentPort(fakePort((name, question) => {
      if (name === 'family') return choiceAnswer(question, 'file-mutation', 0.97);
      if (name === 'kind') return choiceAnswer(question, 'write', 0.97);
      if (name === 'capability') return choiceAnswer(question, 'generic', 0.97);
      if (question.type === 'noul') return noulAnswer(name === 'mutates' ? 0.97 : 0.03);
      throw new Error(`Unexpected fleet-attention reading: ${name}`);
    }).port);
    try {
      runtime.configManager.set('permissions.mode', 'prompt');
      runtime.configManager.set('behavior.autoApprove', false);
      const policyRuntimeState = new PolicyRuntimeState();
      const permissionManager = new PermissionManager(
        (request) => {
          // The production wiring under test (bootstrap-core.ts): forward
          // request.attribution.agentId into the shared approval's metadata
          // so the fleet registry can attach the pending ask to this agent's
          // ProcessNode instead of leaving it unattributed.
          const metadata = approvalMetadataForRequest(request);
          return runtime.approvalBroker.requestApproval({
            request,
            sessionId: 'fleet-attention-test-session',
            ...(metadata ? { metadata } : {}),
          });
        },
        createPermissionConfigReader(runtime.configManager),
        policyRuntimeState,
        null,
        runtime.featureFlags,
      );

      // A fresh AgentOrchestrator (mirrors orchestrator.test.ts's proven
      // wiring recipe) rather than runtime.agentOrchestrator, so this test
      // owns the permissionManager wiring directly instead of depending on
      // bootstrap-core.ts's full daemon boot sequence.
      const orchestrator = new AgentOrchestrator();
      orchestrator.setRuntimeBus(runtime.runtimeBus);
      orchestrator.setFeatureFlagManager(runtime.featureFlags);
      orchestrator.setDependencies({
        surfaceRoot: 'tui',
        fileCache,
        projectIndex,
        fileUndoManager: runtime.fileUndoManager,
        modeManager: runtime.modeManager,
        processManager: runtime.processManager,
        agentMessageBus: runtime.agentMessageBus,
        agentManager: runtime.agentManager,
        contractRunner: runtime.contractRunner,
        contractHooks: runtime.contractRunner.hooks(),
        webSearchService: runtime.webSearchService,
        channelRegistry: runtime.channelPlugins,
        remoteRunnerRegistry: runtime.remoteRunnerRegistry,
        knowledgeService: runtime.knowledgeService,
        memoryRegistry,
        archetypeLoader: runtime.archetypeLoader,
        configManager: runtime.configManager,
        providerRegistry: runtime.providerRegistry,
        providerOptimizer: runtime.providerOptimizer,
        toolLLM: runtime.toolLLM,
        serviceRegistry: runtime.serviceRegistry,
        sessionOrchestration: runtime.sessionOrchestration,
        featureFlags: runtime.featureFlags,
        overflowHandler: runtime.overflowHandler,
        sandboxSessionRegistry: runtime.sandboxSessionRegistry,
        workflowServices: runtime.workflow,
        workingDirectory: projectIndexRoot,
        permissionManager,
      });

      const record = makeRecord({ id: 'agent-fleet-attention-01', tools: ['write'] });

      // A narrow, SDK-real fleet registry: the same createArchivableFleetRegistry
      // seam production composes through (runtime/services.ts), fed a stub
      // agentManager that lists this one live record (mutated in place by
      // orchestrator.runAgent, see AgentRecord semantics in orchestrator.test.ts)
      // plus the runtime's REAL approvalBroker, which is what actually carries
      // the pending ask's metadata.agentId to the registry.
      const fleetRegistry = createArchivableFleetRegistry({
        agentManager: { list: () => [record], cancel: () => false },
        contractRunner: { list: () => [], cancel: () => false },
        processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
        watcherRegistry: { list: () => [], stopWatcher: () => null },
        workflow: {
          workflowManager: { list: () => [], cancel: () => false },
          triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
          scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
        },
        approvalBroker: runtime.approvalBroker,
      });

      const approvedWritePath = join(projectIndexRoot, 'fleet-attention-test.txt');
      const provider = makeMockProvider([
        {
          content: '',
          toolCalls: [{ id: 'call-write-1', name: 'write', arguments: { files: [{ path: approvedWritePath, content: 'hi' }] } }],
        },
        { content: 'Done.' },
      ]);
      const origGetForModel = runtime.providerRegistry.getForModel.bind(runtime.providerRegistry);
      const origGetCurrentModel = runtime.providerRegistry.getCurrentModel.bind(runtime.providerRegistry);
      runtime.providerRegistry.registerRuntimeProvider({
        provider: { ...provider, name: 'mock', models: ['mock-model'] },
        replace: true,
        models: [{
          id: 'mock-model',
          provider: 'mock',
          registryKey: 'mock:mock-model',
          displayName: 'Mock',
          description: 'Test model',
          capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
          contextWindow: 128000,
          selectable: true,
        }],
      });
      runtime.providerRegistry.getForModel = mock(() => provider);
      runtime.providerRegistry.getCurrentModel = mock(() => MOCK_MODEL);

      let runPromise: Promise<void>;
      try {
        // Not awaited yet: the tool call inside runAgent blocks on the
        // permission ask, which stays genuinely pending (no localPrompt is
        // wired) until this test resolves it below.
        runPromise = orchestrator.runAgent(record);

        await waitFor(() => runtime.approvalBroker.listApprovals()
          .some((approval) => approval.status === 'pending' && approval.metadata['agentId'] === record.id));

        const pendingSnapshot = fleetRegistry.query({ kinds: ['agent'] });
        const pendingNode = pendingSnapshot.nodes.find((n) => n.id === record.id);
        expect(pendingNode?.state).toBe('awaiting-approval');
        expect(pendingNode?.needsAttention).toEqual({ reason: 'approval' });
        expect(existsSync(approvedWritePath)).toBe(false);

        const pendingApproval = runtime.approvalBroker.listApprovals()
          .find((approval) => approval.status === 'pending' && approval.metadata['agentId'] === record.id);
        expect(pendingApproval).toBeDefined();
        await runtime.approvalBroker.resolveApproval(pendingApproval!.id, { approved: true, actor: 'test' });

        await runPromise;

        expect(record.status).toBe('completed');
        expect(readFileSync(approvedWritePath, 'utf8')).toBe('hi');
        const resolvedSnapshot = fleetRegistry.query({ kinds: ['agent'] });
        const resolvedNode = resolvedSnapshot.nodes.find((n) => n.id === record.id);
        expect(resolvedNode?.state).not.toBe('awaiting-approval');
        expect(resolvedNode?.needsAttention).toBeUndefined();
      } finally {
        runtime.providerRegistry.getForModel = origGetForModel;
        runtime.providerRegistry.getCurrentModel = origGetCurrentModel;
      }
    } finally {
      installJudgmentPort(previousJudgmentPort);
      forgetCatastrophicReadings();
      memoryStore.close();
      await projectIndex.dispose();
      if (existsSync(memoryDbPath)) unlinkSync(memoryDbPath);
      if (existsSync(projectIndexRoot)) rmSync(projectIndexRoot, { recursive: true, force: true });
      runtime.configManager.set('permissions.mode', 'prompt');
      runtime.configManager.set('behavior.autoApprove', false);
    }
  });
});
