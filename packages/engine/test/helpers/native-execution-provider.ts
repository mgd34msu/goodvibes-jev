import { runAgentTask, type AgentOrchestratorRunContext } from '../../sdk/src/platform/agents/orchestrator-runner.js';
import { ToolRegistry } from '../../sdk/src/platform/tools/registry.js';
import type { ChatRequest, LLMProvider } from '../../sdk/src/platform/providers/interface.js';
import type { ModelDefinition } from '../../sdk/src/platform/providers/registry-types.js';
import { emitAgentCompleted, emitAgentFailed, emitAgentRunning } from '../../sdk/src/platform/runtime/emitters/agents.js';
import type { HarnessOptions } from '../contract/runner-support.js';

/** Entirely offline provider; the normal agent turn loop and runner hooks execute. */
export function nativeExecutionProvider(replies: readonly string[]) {
  const requests: ChatRequest[] = [];
  const model: ModelDefinition = { id: 'native-fixture', provider: 'fixture', registryKey: 'fixture:native-fixture', displayName: 'Native fixture', description: 'Offline synthetic provider', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 0, selectable: true };
  const provider: LLMProvider = { name: 'fixture', models: [model.id], async chat(request) {
    requests.push({ ...request, messages: structuredClone(request.messages) });
    const content = replies[requests.length - 1];
    if (content === undefined) throw new Error('Unscripted native fixture call');
    return { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'completed' };
  } };
  const executeAgent: NonNullable<HarnessOptions['executeAgent']> = async (record, host) => {
    const emitter = { sessionId: 'fixture', traceId: 'fixture', source: 'fixture' };
    const context: AgentOrchestratorRunContext = {
      workingDirectory: host.root, surfaceRoot: undefined, runtimeBus: host.bus, featureFlagManager: null,
      emitterContext: () => emitter, emitAgentProgress: () => {}, emitStreamDelta: () => {},
      emitAgentStarted: agentId => emitAgentRunning(host.bus, emitter, { agentId }),
      emitAgentCancelledEvent: () => {},
      emitAgentFailedEvent: (agentId, error, durationMs) => emitAgentFailed(host.bus, emitter, { agentId, error, durationMs }),
      emitAgentCompletedEvent: (agentId, durationMs) => emitAgentCompleted(host.bus, emitter, { agentId, durationMs }),
      messageBus: host.messageBus, contractHooks: host.runner.hooks(),
      providerRegistry: { getCurrentModel: () => model, getForModel: () => provider, listModels: () => [model], getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => 0, recordContextWindowRejection: () => {} },
      getFullRegistry: () => new ToolRegistry(), buildScopedRegistry: (_names, registry) => registry,
      resolveProviderForRecord: () => ({ provider, modelId: model.id, requestedModelId: model.registryKey }), resolveFallbackModelRoutes: () => [],
    };
    await runAgentTask(context, record);
  };
  return { requests, executeAgent };
}
