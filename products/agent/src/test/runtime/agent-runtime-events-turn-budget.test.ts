import { describe, expect, test } from 'bun:test';
import { RuntimeEventBus, createEventEnvelope } from '@/runtime/index.ts';
import { AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { AgentMessageBus } from '@goodvibes-jev/engine/sdk/platform/agents';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createDomainDispatch } from '../../runtime/store/index.ts';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const flushMicrotasks = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

/**
 * The typed turn-budget-exhaustion outcome (SDK 1.8.0, agents/turn-budget.ts):
 * the real orchestrator stamps AgentRecord.failureReason === 'max_turns' plus
 * turnBudget { limit, source } on the record when a run spends its whole
 * budget. Exercising the REAL orchestrator to genuinely exhaust a budget here
 * would be slow and indirect; instead this stamps those two fields onto the
 * live record the same way the orchestrator does (AgentRecord is a mutable,
 * shared instance, see src/test/agents/orchestrator.test.ts directly
 * mutating `record.status` for the same reason) and verifies
 * registerAgentRuntimeEvents renders the honest budget line from those typed
 * fields alone, never touching the (irrelevant, generic) child-failure
 * envelope path.
 */
describe('registerAgentRuntimeEvents: AGENT_FAILED typed turn-budget outcome (SDK 1.8.0)', () => {
  function makeHarness() {
    const configDir = makeProjectTempDir('gv-turn-budget');
    const configManager = new ConfigManager({ surfaceRoot: 'tui', configDir });
    const agentMessageBus = new AgentMessageBus();
    const agentManager = new AgentManager({
      configManager,
      messageBus: agentMessageBus,
      executor: { runAgent: () => Promise.reject(new Error('turn budget exhausted')) },
    });
    return { configManager, agentManager };
  }

  test('renders an honest budget line with the applied limit and its source, distinct from a generic failure', async () => {
    const { configManager, agentManager } = makeHarness();
    const record = agentManager.spawn({ mode: 'spawn', outsideContract: true, task: 'summarize the quarterly report', template: 'engineer' });
    await flushMicrotasks();
    expect(record.status).toBe('failed');

    // Stamp the typed outcome the real orchestrator would have set.
    record.failureReason = 'max_turns';
    record.turnBudget = { limit: 25, source: 'spawn-override' };

    let toolRegistryCalled = false;
    const runtimeBus = new RuntimeEventBus();
    const domainDispatch = createDomainDispatch(createRuntimeStore());
    const lowMessages: string[] = [];
    const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
      runtimeBus,
      domainDispatch,
      contractRunner: { get: () => null, list: () => [] },
      getSystemMessageRouter: () => ({ contract: () => {}, high: () => {}, low: (message: string) => { lowMessages.push(message); } }),
      requestRender: () => {},
      configManager,
      agentManager,
      toolRegistry: { execute: async () => { toolRegistryCalled = true; throw new Error('should not be called for the typed max_turns outcome'); } },
    });
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);

    runtimeBus.emit('agents', createEventEnvelope('AGENT_FAILED', {
      type: 'AGENT_FAILED',
      agentId: record.id,
      error: record.error ?? 'turn budget exhausted',
      durationMs: 1500,
    }, { sessionId: 'session-1', source: 'test-suite' }));
    await flushMicrotasks();

    expect(lowMessages).toHaveLength(1);
    expect(lowMessages[0]).toContain('[Delegated task]');
    expect(lowMessages[0]).toContain('spent its turn budget');
    expect(lowMessages[0]).toContain('25 turns');
    expect(lowMessages[0]).toContain('a per-spawn override');
    // Distinct from the generic infrastructure-failure rendering.
    expect(lowMessages[0]).not.toContain('failed in');
    expect(lowMessages[0]).not.toContain('reason:');
    // Never consulted the child-failure envelope's tool round-trip for this outcome.
    expect(toolRegistryCalled).toBe(false);

    for (const unsub of unsubs) unsub();
  });

  test('names the config default and the policy cap distinctly from a spawn override', async () => {
    const { configManager, agentManager } = makeHarness();
    const record = agentManager.spawn({ mode: 'spawn', outsideContract: true, task: 'draft release notes', template: 'engineer' });
    await flushMicrotasks();
    record.failureReason = 'max_turns';
    record.turnBudget = { limit: 40, source: 'default' };

    const runtimeBus = new RuntimeEventBus();
    const domainDispatch = createDomainDispatch(createRuntimeStore());
    const lowMessages: string[] = [];
    const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
      runtimeBus,
      domainDispatch,
      contractRunner: { get: () => null, list: () => [] },
      getSystemMessageRouter: () => ({ contract: () => {}, high: () => {}, low: (message: string) => { lowMessages.push(message); } }),
      requestRender: () => {},
      configManager,
      agentManager,
      toolRegistry: { execute: async () => { throw new Error('unused'); } },
    });
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);

    runtimeBus.emit('agents', createEventEnvelope('AGENT_FAILED', {
      type: 'AGENT_FAILED',
      agentId: record.id,
      error: record.error ?? 'turn budget exhausted',
      durationMs: 900,
    }, { sessionId: 'session-1', source: 'test-suite' }));
    await flushMicrotasks();

    expect(lowMessages[0]).toContain('40 turns');
    expect(lowMessages[0]).toContain('the default agents.maxTurns');

    for (const unsub of unsubs) unsub();
  });

  test('a non-max_turns failure still uses the generic child-failure envelope path', async () => {
    const { configManager, agentManager } = makeHarness();
    const record = agentManager.spawn({ mode: 'spawn', outsideContract: true, task: 'reconcile the ledger', template: 'engineer' });
    await flushMicrotasks();
    expect(record.status).toBe('failed');
    expect(record.failureReason).not.toBe('max_turns');

    const runtimeBus = new RuntimeEventBus();
    const domainDispatch = createDomainDispatch(createRuntimeStore());
    const lowMessages: string[] = [];
    const { unsubs, agentStatusIntervalRef } = registerAgentRuntimeEvents({
      runtimeBus,
      domainDispatch,
      contractRunner: { get: () => null, list: () => [] },
      getSystemMessageRouter: () => ({ contract: () => {}, high: () => {}, low: (message: string) => { lowMessages.push(message); } }),
      requestRender: () => {},
      configManager,
      agentManager,
      toolRegistry: { execute: async () => ({ success: false, output: '', callId: 'call-1' }) },
    });
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);

    runtimeBus.emit('agents', createEventEnvelope('AGENT_FAILED', {
      type: 'AGENT_FAILED',
      agentId: record.id,
      error: record.error ?? 'turn budget exhausted',
      durationMs: 900,
    }, { sessionId: 'session-1', source: 'test-suite' }));
    await flushMicrotasks();

    expect(lowMessages).toHaveLength(1);
    expect(lowMessages[0]).toContain('failed in');
    expect(lowMessages[0]).not.toContain('spent its turn budget');

    for (const unsub of unsubs) unsub();
  });
});
