import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { AgentManager, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentMessageBus } from '@goodvibes-jev/engine/sdk/platform/agents';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createDomainDispatch } from '../../runtime/store/index.ts';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';
import { createTestManagers } from '../helpers/test-managers.ts';

// Drain queued microtasks so bus.emit() listeners (OBS-14 async dispatch) run before assertions.
const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('registerAgentRuntimeEvents: compaction receipt routing (SDK 1.6.1)', () => {
  function setup() {
    const runtimeBus = new RuntimeEventBus();
    const domainDispatch = createDomainDispatch(createRuntimeStore());
    const managers = createTestManagers();
    const agentManager = new AgentManager({ messageBus: new AgentMessageBus(), configManager: managers.configManager });
    const highMessages: string[] = [];
    const lowMessages: string[] = [];
    const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
      runtimeBus,
      domainDispatch,
      contractRunner: { get: () => null, list: () => [] },
      getSystemMessageRouter: () => ({ contract: () => {},
        high: (message: string) => { highMessages.push(message); },
        low: (message: string) => { lowMessages.push(message); },
      }),
      requestRender: () => {},
      configManager: managers.configManager,
      agentManager,
      toolRegistry: new ToolRegistry(),
    });
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);
    return { runtimeBus, highMessages, lowMessages, unsubs };
  }

  test('an applied COMPACTION_RECEIPT surfaces as a high-priority system message naming strategy and tokens reclaimed', async () => {
    const { runtimeBus, highMessages, unsubs } = setup();
    runtimeBus.emit('compaction', createEventEnvelope('COMPACTION_RECEIPT', {
      type: 'COMPACTION_RECEIPT',
      sessionId: 'session-1',
      trigger: 'auto',
      strategy: 'structured',
      tokensBefore: 12_000,
      tokensAfter: 4_000,
      messagesBefore: 40,
      messagesAfter: 6,
      qualityScore: 0.9,
      qualityGrade: 'A',
      lowQuality: false,
      instructionsReinjected: true,
      validationPassed: true,
      sectionsIncluded: [],
      outcome: 'applied',
    }, { sessionId: 'session-1', source: 'test-suite' }));
    await flushMicrotasks();
    expect(highMessages).toHaveLength(1);
    expect(highMessages[0]).toContain('[Compaction]');
    expect(highMessages[0]).toContain('structured');
    expect(highMessages[0]).toContain('applied');
    expect(highMessages[0]).toContain('8,000');
    for (const unsub of unsubs) unsub();
  });

  test('a kept-original COMPACTION_RECEIPT surfaces the fallback reason from `detail`, never a silent revert', async () => {
    const { runtimeBus, highMessages, unsubs } = setup();
    runtimeBus.emit('compaction', createEventEnvelope('COMPACTION_RECEIPT', {
      type: 'COMPACTION_RECEIPT',
      sessionId: 'session-1',
      trigger: 'manual',
      strategy: 'distiller',
      tokensBefore: 12_000,
      tokensAfter: 12_000,
      messagesBefore: 40,
      messagesAfter: 40,
      qualityScore: 0.2,
      qualityGrade: 'D',
      lowQuality: true,
      instructionsReinjected: false,
      validationPassed: false,
      sectionsIncluded: [],
      outcome: 'kept-original',
      detail: 'quality score below floor; reverted to the pre-compaction conversation',
    }, { sessionId: 'session-1', source: 'test-suite' }));
    await flushMicrotasks();
    expect(highMessages).toHaveLength(1);
    expect(highMessages[0]).toContain('distiller');
    expect(highMessages[0]).toContain('kept-original');
    expect(highMessages[0]).toContain('quality score below floor');
    for (const unsub of unsubs) unsub();
  });
});
