import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { AgentManager, ToolRegistry, createAgentTool } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentMessageBus } from '@goodvibes-jev/engine/sdk/platform/agents';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createDomainDispatch } from '../../runtime/store/index.ts';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// Drain queued microtasks, the child-failure-envelope enrichment awaits a
// real ToolRegistry.execute() call before rendering, so assertions must wait
// for that promise chain to settle, not just one flush.
const flushMicrotasks = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

const readings = fakePort((name, question, state) => {
  if (name !== 'reason' || !JSON.stringify(state).includes('agent went silent for 30s')) {
    throw new Error('Unexpected synthetic child-failure reading');
  }
  return choiceAnswer(question, 'watchdog_timeout', 0.97);
});
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(readings.port); });
afterEach(() => { installJudgmentPort(previousPort); });

describe('registerAgentRuntimeEvents: AGENT_FAILED child-failure envelope enrichment (SDK 1.6.1)', () => {
  test('AGENT_FAILED renders a compact suffix with the real classified reason from the agent tool\'s own status action', async () => {
    const configDir = makeProjectTempDir('gv-child-failure');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir });
    const agentMessageBus = new AgentMessageBus();
    const agentManager = new AgentManager({
      configManager,
      messageBus: agentMessageBus,
      // The actual registered reading receives this synthetic failure text.
      executor: { runAgent: () => Promise.reject(new Error('agent went silent for 30s')) },
    });
    const record = agentManager.spawn({ mode: 'spawn', outsideContract: true, task: 'investigate the flaky test', template: 'engineer' });
    await flushMicrotasks();
    expect(record.status).toBe('failed');

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createAgentTool({ manager: agentManager, messageBus: agentMessageBus, configManager }));

    const runtimeBus = new RuntimeEventBus();
    const domainDispatch = createDomainDispatch(createRuntimeStore());
    const lowMessages: string[] = [];
    let resolveDelivery!: () => void;
    const delivered = new Promise<void>(resolve => { resolveDelivery = resolve; });
    const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
      runtimeBus,
      domainDispatch,
      getSystemMessageRouter: () => ({ high: () => {}, low: (message: string) => { lowMessages.push(message); resolveDelivery(); } }),
      requestRender: () => {},
      configManager,
      agentManager,
      toolRegistry,
    });
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);

    runtimeBus.emit('agents', createEventEnvelope('AGENT_FAILED', {
      type: 'AGENT_FAILED',
      agentId: record.id,
      error: record.error ?? 'agent went silent for 30s',
      durationMs: 1500,
    }, { sessionId: 'session-1', source: 'test-suite' }));
    await flushMicrotasks();

    await delivered;
    expect(lowMessages).toHaveLength(1);
    expect(lowMessages[0]).toContain('[Delegated task]');
    expect(lowMessages[0]).toContain('failed in');
    expect(lowMessages[0]).toContain('reason: watchdog_timeout');

    for (const unsub of unsubs) unsub();
  });
});
