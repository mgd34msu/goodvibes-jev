/**
 * The consumers of the `contracts` event domain (design 8.2) that the
 * channel, replay and store tests do not already cover: the Slack and Discord
 * notifier, the webhook notifier's cancel line, the lifecycle hook bridge, the
 * host runtime event bridge (its `[Contract]` operator lines, the
 * conversation follow-ups, the store dispatch, and the cohort check), the UI
 * event feed, the system-message tag and transcript classification, and the
 * domain lists that subscribe to the domain.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { RuntimeEventBus } from '../../sdk/src/platform/runtime/events/index.js';
import { emitContractEvent } from '../../sdk/src/platform/contract/events.js';
import { Notifier } from '../../sdk/src/platform/integrations/notifier.js';
import { WebhookNotifier } from '../../sdk/src/platform/integrations/webhooks.js';
import { registerBootstrapHookBridge } from '../../sdk/src/platform/runtime/bootstrap-hook-bridge.js';
import { registerHostRuntimeEvents } from '../../sdk/src/platform/runtime/bootstrap-runtime-events.js';
import { createDomainDispatch, createRuntimeStore } from '../../sdk/src/platform/runtime/store/index.js';
import { createUiRuntimeEvents } from '../../sdk/src/platform/runtime/ui-events.js';
import { classifySystemMessageKind } from '../../sdk/src/platform/runtime/system-message-policy.js';
import { classifyTranscriptMessages } from '../../sdk/src/platform/core/transcript-events/classify.js';
import { ALL_DOMAINS } from '../../sdk/src/platform/runtime/telemetry/api-helpers.js';
import { resetWorkstreamLabelsForTests } from '../../sdk/src/platform/channels/workstream-labels.js';
import type { HookEvent } from '../../sdk/src/platform/hooks/types.js';
import type { ConversationFollowUpItem } from '../../sdk/src/platform/core/conversation-follow-ups.js';
import type { ContractView } from '../../sdk/src/platform/contract/types.js';
import { ALL_CONTRACT_EVENTS, CTR, SAMPLES } from './event-samples.js';
import { waitFor } from '../_helpers/test-timeout.js';

/** The bus delivers on a later microtask. */
const delivered = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

describe('the notifier posts contract outcomes', () => {
  test('passed, failed and cancelled each post one plain line; other contract events post nothing', async () => {
    resetWorkstreamLabelsForTests();
    const posted: string[] = [];
    const slack = { postWebhook: async (text: string) => { posted.push(text); } };
    const notifier = new Notifier({ slack: slack as never });
    const bus = new RuntimeEventBus();
    notifier.attachToRuntimeBus(bus);
    try {
      emitContractEvent(bus, 's1', SAMPLES.CONTRACT_CREATED);
      emitContractEvent(bus, 's1', SAMPLES.CONTRACT_NUDGED);
      emitContractEvent(bus, 's1', SAMPLES.CONTRACT_PASSED);
      emitContractEvent(bus, 's1', { ...SAMPLES.CONTRACT_FAILED, contractId: 'ctr-00000002' });
      emitContractEvent(bus, 's1', { ...SAMPLES.CONTRACT_CANCELLED, contractId: 'ctr-00000003' });
      await waitFor(() => posted.length >= 3);
      await delivered();
      expect(posted).toEqual([
        'The workstream is done: 4 of 4 requirements met',
        'The workstream could not be finished: unit u1 spent its turn budget',
        'The workstream was cancelled: stopped by the owner',
      ]);
      // Never the contract id: the notification is read outside the machine.
      expect(posted.join('\n')).not.toContain('ctr-');
    } finally {
      notifier.detach();
    }
  });
});

describe('the webhook notifier', () => {
  test('a cancelled contract is reported as cancelled, not as a failure', async () => {
    const sent: string[] = [];
    const bus = new RuntimeEventBus();
    const notifier = new WebhookNotifier(['https://example.com/webhook']);
    const sendSpy = spyOn(notifier, 'send').mockImplementation(async (text: string) => {
      sent.push(text);
      return { attempted: 1, delivered: 1, failed: 0, results: [] };
    });
    try {
      notifier.attachToRuntimeBus(bus);
      emitContractEvent(bus, 's1', SAMPLES.CONTRACT_CANCELLED);
      await waitFor(() => sent.length >= 1);
      expect(sent).toEqual(['The workstream was cancelled: stopped by the owner']);
    } finally {
      sendSpy.mockRestore();
      notifier.detach();
    }
  });
});

describe('the lifecycle hook bridge', () => {
  test('contract events fire the Lifecycle:contract hooks, and the spawn guard fires Change:contract:spawn-guard', async () => {
    const bus = new RuntimeEventBus();
    const fired: Array<Pick<HookEvent, 'path' | 'category' | 'specific' | 'payload'>> = [];
    const unsubs = registerBootstrapHookBridge({
      runtimeBus: bus,
      hookDispatcher: { fire: (event: HookEvent) => { fired.push({ path: event.path, category: event.category, specific: event.specific, payload: event.payload }); return Promise.resolve({ ok: true }); } } as never,
      runtime: { sessionId: 'session-1' } as never,
    });
    try {
      for (const event of ALL_CONTRACT_EVENTS) emitContractEvent(bus, 's1', event);
      await delivered();
      expect(fired.map((event) => event.path)).toEqual([
        'Lifecycle:contract:created',
        'Lifecycle:contract:planned',
        'Lifecycle:contract:checked',
        'Lifecycle:contract:nudged',
        'Lifecycle:contract:escalated',
        'Lifecycle:contract:passed',
        'Lifecycle:contract:failed',
        'Lifecycle:contract:cancelled',
        'Change:contract:spawn-guard',
      ]);
      expect(fired.every((event) => event.category === 'contract')).toBe(true);
      expect(fired.find((event) => event.specific === 'created')?.payload).toEqual({ contractId: CTR, origin: 'turn', ask: 'Add a parser', ownerAgentId: 'a-owner' });
      expect(fired.find((event) => event.specific === 'checked')?.payload).toEqual({
        contractId: CTR, scope: 'unit', targetId: 'u1', checkId: 'u1.k1', trigger: 'completion', result: 'nudge',
        criteria: [{ criterionId: 'u1.c1', verdict: 'unmet' }],
      });
      expect(fired.find((event) => event.specific === 'failed')?.payload).toEqual({ contractId: CTR, reason: 'unit u1 spent its turn budget', failureKind: 'max_turns' });
      expect(fired.find((event) => event.specific === 'spawn-guard')?.payload).toEqual({
        contractId: CTR, agentId: 'a1', depth: 2, activeAgents: 5, reason: 'units are leaves; the contract plans sub-work',
      });
    } finally {
      for (const unsub of unsubs) unsub();
    }
  });
});

describe('the host runtime event bridge', () => {
  function host(options: { contracts?: readonly ContractView[]; agents?: ReadonlyArray<{ id: string; status: string; cohort?: string; startedAt: number; template: string; toolCallCount: number; task: string }> } = {}) {
    const bus = new RuntimeEventBus();
    const store = createRuntimeStore();
    const lines: Array<{ channel: 'low' | 'high' | 'contract'; text: string }> = [];
    const followUps: ConversationFollowUpItem[] = [];
    const agents = options.agents ?? [];
    const agentManager = {
      getStatus: (id: string) => agents.find((agent) => agent.id === id) ?? null,
      listByCohort: (cohort: string) => agents.filter((agent) => agent.cohort === cohort),
      list: () => agents,
    };
    const contracts = options.contracts ?? [];
    const { unsubs, agentStatusIntervalRef } = registerHostRuntimeEvents({
      runtimeBus: bus,
      domainDispatch: createDomainDispatch(store),
      getSystemMessageRouter: () => ({
        low: (text) => lines.push({ channel: 'low', text }),
        high: (text) => lines.push({ channel: 'high', text }),
        contract: (text) => lines.push({ channel: 'contract', text }),
      }),
      queueConversationFollowUp: (item) => followUps.push(item),
      requestRender: () => {},
      agentManager: agentManager as never,
      contractRunner: {
        get: (id: string) => contracts.find((contract) => contract.id === id) ?? null,
        list: () => [...contracts],
      },
    });
    return {
      bus, store, lines, followUps,
      stop(): void {
        for (const unsub of unsubs) unsub();
        if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);
      },
    };
  }

  test('every operator line is a [Contract] line on the contract router, and the store follows the domain', async () => {
    resetWorkstreamLabelsForTests();
    const h = host();
    try {
      for (const event of ALL_CONTRACT_EVENTS) emitContractEvent(h.bus, 's1', event);
      await delivered();
      const contractLines = h.lines.filter((line) => line.channel === 'contract').map((line) => line.text);
      expect(contractLines.every((text) => text.startsWith('[Contract] '))).toBe(true);
      expect(contractLines).toEqual([
        `[Contract] ${CTR} started: Add a parser`,
        `[Contract] ${CTR} queued -> shaping`,
        '[Contract] ✗ Check u1.k1 of unit u1: 0/1 criteria met, nudge',
        '[Contract] Nudged unit u1 (unmet, gate) on u1.c1',
        '[Contract] Criterion u1.c2 of unit u1 regressed (met at u1.k1)',
        '[Contract] unit u1 stalled, routed to split: three checks without progress',
        `[Contract] ${CTR} needs the owner: Contract needs your decision.`,
        '[Contract]   ✓ Gate: lint skipped',
        `[Contract] Commit committed for ${CTR} (abc123): committed on main`,
        `[Contract] ✓ ${CTR} PASSED: 4 of 4 criteria met, 2 corrections`,
        `[Contract] ✗ ${CTR} FAILED: unit u1 spent its turn budget`,
        `[Contract] ${CTR} cancelled: stopped by the owner (3 files modified)`,
      ]);
      // The person reads follow-ups in words, keyed by id for dedupe only.
      expect(h.followUps).toEqual([
        { key: `contract:${CTR}:passed`, summary: '"Add a parser" passed all its checks.' },
        { key: `contract:${CTR}:failed`, summary: '"Add a parser" could not be finished: unit u1 spent its turn budget' },
        { key: `contract:${CTR}:cancelled`, summary: '"Add a parser" was cancelled: stopped by the owner' },
      ]);
      expect(h.store.getState().contracts.contracts.get(CTR)?.status).toBe('cancelled');
    } finally {
      h.stop();
    }
  });

  test('a turn-end check that only records history writes no line', async () => {
    const h = host();
    try {
      emitContractEvent(h.bus, 's1', { ...SAMPLES.CONTRACT_CHECKED, trigger: 'turn-end', result: 'recorded' });
      await delivered();
      expect(h.lines).toEqual([]);
    } finally {
      h.stop();
    }
  });

  test('a cohort is reported once its agents and every contract they worked on have ended', async () => {
    const agents = [
      { id: 'a1', status: 'completed', cohort: 'batch', startedAt: 1, completedAt: 2, template: 'engineer', toolCallCount: 3, task: 'unit work' },
      { id: 'a2', status: 'completed', cohort: 'batch', startedAt: 1, completedAt: 2, template: 'engineer', toolCallCount: 1, task: 'other work' },
    ];
    const running = { id: CTR, status: 'running', units: [{ id: 'u1', agentIds: ['a1'] }] } as unknown as ContractView;
    const pending = host({ agents, contracts: [running] });
    try {
      emitContractEvent(pending.bus, 's1', SAMPLES.CONTRACT_PASSED);
      await delivered();
      // The contract a1 worked on is still running in the runner's view: no cohort report yet.
      expect(pending.lines.some((line) => line.text.includes("Cohort 'batch' complete"))).toBe(false);
    } finally {
      pending.stop();
    }
    const ended = { ...running, status: 'passed' } as unknown as ContractView;
    const done = host({ agents, contracts: [ended] });
    try {
      emitContractEvent(done.bus, 's1', SAMPLES.CONTRACT_PASSED);
      await delivered();
      expect(done.lines.filter((line) => line.channel === 'low').map((line) => line.text)).toEqual([
        expect.stringContaining("[Agents] Cohort 'batch' complete: 2 completed, 0 failed, 0 cancelled (2 total)"),
      ]);
      expect(done.followUps.map((item) => item.key)).toContain('cohort:batch:complete');
    } finally {
      done.stop();
    }
  });
});

describe('surfaces that classify or subscribe', () => {
  test('the UI contracts feed carries contract events', async () => {
    const bus = new RuntimeEventBus();
    const feeds = createUiRuntimeEvents(bus);
    const seen: string[] = [];
    const off = feeds.contracts.on('CONTRACT_PASSED', (payload) => { seen.push(payload.contractId); });
    emitContractEvent(bus, 's1', SAMPLES.CONTRACT_PASSED);
    await delivered();
    off();
    expect(seen).toEqual([CTR]);
  });

  test('[Contract] messages are the contract kind, and the transcript shows them as contract state', () => {
    expect(classifySystemMessageKind(`[Contract] ${CTR} started: Add a parser`)).toBe('contract');
    const [event] = classifyTranscriptMessages([{ role: 'system', content: `[Contract] ${CTR} PASSED` } as never]);
    expect(event?.kind).toBe('contract_state');
  });

  test('the telemetry domain list subscribes to contracts', () => {
    expect(ALL_DOMAINS).toContain('contracts');
  });
});
