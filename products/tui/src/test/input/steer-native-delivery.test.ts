import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentTask, type AgentOrchestratorRunContext } from '@goodvibes-jev/engine/sdk/platform/agents';
import { AgentMessageBus } from '@goodvibes-jev/engine/sdk/platform/agents';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createProcessRegistry, STEER_TTL_MS } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { AgentRecord } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { LLMProvider, ChatResponse } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ModelDefinition } from '@goodvibes-jev/engine/sdk/platform/providers';
import type { ProviderRegistry } from '@goodvibes-jev/engine/sdk/platform/providers';


function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeRecord(overrides: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    task: 'do work',
    template: 'engineer',
    tools: [],
    status: 'pending',
    startedAt: Date.now(),
    toolCallCount: 0,
    orchestrationDepth: 0,
    executionProtocol: 'direct',
    reviewMode: 'none',
    communicationLane: 'parent-only',
    ...overrides,
  };
}

const FAKE_MODEL: ModelDefinition = {
  id: 'fake-model',
  provider: 'fake',
  registryKey: 'fake:fake-model',
  displayName: 'Fake Model',
  description: 'test-only stub model',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false },
  contextWindow: 0, // 0 short-circuits context-window-awareness bookkeeping (see applyContextWindowAwareness)
  selectable: true,
};

function makeProviderRegistry(
  provider: LLMProvider,
): Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels' | 'getContextWindowForModel' | 'getKnownContextWindowForModel' | 'recordContextWindowRejection'> {
  return {
    getCurrentModel: () => FAKE_MODEL,
    getForModel: () => provider,
    listModels: () => [FAKE_MODEL],
    getContextWindowForModel: () => 0,
    getKnownContextWindowForModel: () => 0,
    recordContextWindowRejection: () => {},
  };
}

function makeContext(opts: {
  workingDirectory: string;
  runtimeBus: RuntimeEventBus;
  messageBus: Pick<AgentMessageBus, 'getMessages'>;
  provider: LLMProvider;
}): AgentOrchestratorRunContext {
  return {
    workingDirectory: opts.workingDirectory,
    surfaceRoot: undefined,
    runtimeBus: opts.runtimeBus,
    featureFlagManager: null,
    emitterContext: () => ({ sessionId: 'test-session', traceId: 'test-trace', source: 'test' }),
    emitAgentProgress: () => {},
    emitAgentStarted: () => {},
    emitAgentCancelledEvent: () => {},
    emitAgentFailedEvent: () => {},
    emitAgentCompletedEvent: () => {},
    emitStreamDelta: () => {},
    processManager: undefined,
    messageBus: opts.messageBus,
    knowledgeService: undefined,
    memoryRegistry: undefined,
    archetypeLoader: undefined,
    providerOptimizer: undefined,
    providerRegistry: makeProviderRegistry(opts.provider),
    getFullRegistry: () => new ToolRegistry(),
    buildScopedRegistry: (_allowedNames, fullRegistry) => fullRegistry,
    resolveProviderForRecord: (_registry, _record, currentModel) => ({
      provider: opts.provider,
      modelId: currentModel.id,
      requestedModelId: currentModel.registryKey,
    }),
    resolveFallbackModelRoutes: () => [],
  };
}

function makeRegistryDeps(record: AgentRecord, messageBus: Pick<AgentMessageBus, 'send'>) {
  return {
    agentManager: { list: () => [record], cancel: () => false },
    contractRunner: { list: () => [], cancel: () => false },
    processManager: { list: () => [], stop: () => false, getStatus: () => undefined },
    watcherRegistry: { list: () => [], stopWatcher: () => null },
    workflow: {
      workflowManager: { list: () => [], cancel: () => false },
      triggerManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
      scheduleManager: { list: () => [], remove: () => false, disable: () => false, enable: () => false },
    },
    messageBus,
  };
}

function userMessageContents(messages: readonly unknown[]): string[] {
  return messages
    .filter((m): m is { role: string; content: unknown } => typeof m === 'object' && m !== null && 'role' in m)
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content as string);
}


import { AgentsModal } from '../../input/agents-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { createFleetReadModel } from '../../views/fleet-read-model.ts';
import { reconcileSteerBadges, STEER_BADGE_LINGER_MS } from '../../views/fleet-steer.ts';

test('a steer already present in an in-flight native chat remains unknown until its late consumed acknowledgement', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'independent-native-ttl-'));
  const messageBus = new AgentMessageBus(); const bus = new RuntimeEventBus();
  const record = makeRecord({id:'synthetic-native-ttl'});
  const registry = createProcessRegistry(makeRegistryDeps(record, messageBus));
  const modal = new AgentsModal({readModel:createFleetReadModel(registry,bus), actions:{interrupt:()=>false,resume:()=>false,kill:()=>[],getConversationSnapshot:()=>[],resolveSessionLogPath:()=>'',steer:(id,text)=>registry.steer(id,text)}, tickMs:0,requestRender:()=>{}});
  const host = new SurfaceModalHost(); host.push(modal);
  const consumed:unknown[]=[]; const off=bus.onDomain('communication',e=>{if(e.payload.type==='COMMUNICATION_CONSUMED') consumed.push(e.payload)});
  let calls=0;
  const observed: { status: string | undefined; note: string | undefined; messageId: string | undefined }[] = [];
  const provider:LLMProvider = {name:'fake',models:['fake-model'],async chat(request):Promise<ChatResponse>{
    calls++;
    if(calls===1){
      modal.reveal({id:record.id});
      host.handleToken({type:'text',value:'s'}); host.handleToken({type:'text',value:'Synthetic TTL edge input'});
      host.handleToken({type:'key',name:'enter',logicalName:'enter',ctrl:false,meta:false,shift:false});
      expect(modal.tabs.tabs[0]?.steerBadge?.status).toBe('queued');
      return {content:'',toolCalls:[{id:'call1',name:'nonexistent_tool',arguments:{}}],usage:{inputTokens:1,outputTokens:1},stopReason:'tool_call'};
    }
    expect(userMessageContents(request.messages)).toContain('Synthetic TTL edge input');
    expect(consumed).toHaveLength(0);
    const tab=modal.tabs.tabs[0]!; const at=tab.steerBadge!.queuedAt!+STEER_TTL_MS+1;
    reconcileSteerBadges(modal.tabs.tabs,id=>registry.getNode(id),at);
    observed.push({status: tab.steerBadge?.status, note: tab.steerBadge?.note, messageId: tab.steerBadge?.messageId});
    reconcileSteerBadges(modal.tabs.tabs,id=>registry.getNode(id),at+STEER_BADGE_LINGER_MS+1);
    observed.push({status: tab.steerBadge?.status, note: tab.steerBadge?.note, messageId: tab.steerBadge?.messageId});
    return {content:'Synthetic done',toolCalls:[],usage:{inputTokens:1,outputTokens:1},stopReason:'completed'};
  }};
  try {
    await runAgentTask(makeContext({workingDirectory:tmp,runtimeBus:bus,messageBus,provider}),record); await flushMicrotasks();
    expect(calls).toBe(2); expect(consumed).toHaveLength(1);
    expect(observed.map(value => value.status)).toEqual(['unknown', 'unknown']);
    expect(observed[0]?.note).toBe('no consumption acknowledgement before the tracking deadline');
    expect(observed[0]?.messageId).toBeDefined(); expect(observed[1]?.messageId).toBe(observed[0]?.messageId); expect(modal.tabs.tabs[0]?.steerBadge?.status).toBe('consumed');
  }finally{host.clear();registry.dispose();off();rmSync(tmp,{recursive:true,force:true});}
});
