import { describe, expect, spyOn, test } from 'bun:test';
import type { ContractEvent } from '@goodvibes-jev/engine/sdk/events';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { emitContractEvent, type ContractView } from '@goodvibes-jev/engine/sdk/platform/contract';
import type { ConversationFollowUpItem } from '@goodvibes-jev/engine/sdk/platform/core';
import { DiscordIntegration, SlackIntegration } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createDomainDispatch, createRuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/store';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';
import { createRuntimeNotifier } from '../../runtime/bootstrap-notifier.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const delivered = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

async function waitForNotices(condition: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for notifications: ${describe()}`);
    await Bun.sleep(10);
  }
}

let sequence = 0;
function harness(contracts: ContractView[] = []) {
  const runtimeBus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const domainDispatch = createDomainDispatch(store);
  const dispatch = spyOn(domainDispatch, 'dispatchContractEvent');
  const lines: Array<{ channel: string; text: string }> = [];
  const followUps: ConversationFollowUpItem[] = [];
  const configDir = makeProjectTempDir('agent-contract-events');
  const configManager = new ConfigManager({ surfaceRoot: 'agent', configDir, homeDir: configDir, workingDir: configDir });
  const agent = { id: 'a1', status: 'completed', cohort: 'batch', startedAt: 1, completedAt: 2, template: 'engineer', toolCallCount: 3, task: 'unit work' };
  let renderCount = 0;
  const intervals = spyOn(globalThis, 'setInterval');
  const bridge = registerAgentRuntimeEvents({
    runtimeBus, domainDispatch, configManager,
    getSystemMessageRouter: () => ({
      low: text => lines.push({ channel: 'low', text }),
      high: text => lines.push({ channel: 'high', text }),
      contract: text => lines.push({ channel: 'contract', text }),
    }),
    queueConversationFollowUp: item => followUps.push(item),
    requestRender: () => { renderCount += 1; },
    agentManager: { getStatus: () => agent, list: () => [agent], listByCohort: () => [agent] } as never,
    contractRunner: { get: id => contracts.find(contract => contract.id === id) ?? null, list: () => contracts },
    toolRegistry: { execute: async () => ({ success: false, output: '', callId: 'unused' }) },
  });
  const intervalCount = intervals.mock.calls.length;
  intervals.mockRestore();
  let stopped = false;
  return {
    runtimeBus, store, dispatch, lines, followUps, intervalCount,
    renderCount: () => renderCount,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const unsub of bridge.unsubs) unsub();
      if (bridge.agentStatusIntervalRef.value) clearInterval(bridge.agentStatusIntervalRef.value);
    },
    dispose() { this.stop(); dispatch.mockRestore(); },
  };
}

function lifecycle(ask: string): readonly ContractEvent[] {
  const contractId = `ctr-agent-label-${++sequence}`;
  return [
    { type: 'CONTRACT_CREATED', contractId, sessionId: 's1', origin: 'turn', ask, ownerAgentId: 'agent-owner' },
    { type: 'CONTRACT_PASSED', contractId, criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 },
    { type: 'CONTRACT_FAILED', contractId, reason: 'fixture failure detail', failureKind: 'other', membersSettled: true },
    { type: 'CONTRACT_CANCELLED', contractId, reason: 'fixture cancellation detail', filesModified: 0 },
  ];
}

const registry = {
  resolveSecret: async (service: string, key: string) => key === 'webhookUrl' ? `https://${service}.example/fixture` : null,
};

describe('the Agent uses canonical contract lifecycle consumers', () => {
  test('created captures the task for enabled Slack and Discord passed, failed and cancelled notifications', async () => {
    const h = harness();
    const slack: string[] = [];
    const discord: string[] = [];
    const slackSpy = spyOn(SlackIntegration.prototype, 'postWebhook').mockImplementation(async text => { slack.push(text); });
    const discordSpy = spyOn(DiscordIntegration.prototype, 'postWebhook').mockImplementation(async text => { discord.push(text); });
    const notifier = await createRuntimeNotifier(registry, () => false);
    // The production bootstrap registers the Agent bridge before attaching its notifier.
    notifier.attachToRuntimeBus(h.runtimeBus);
    try {
      const events = lifecycle('Name the Agent contract task');
      for (const event of events) emitContractEvent(h.runtimeBus, 's1', event);
      await waitForNotices(() => slack.length === 3 && discord.length === 3, () => JSON.stringify({ slack, discord }));
      expect(slack).toEqual([
        '"Name the Agent contract task" is done: 1 of 1 requirements met',
        '"Name the Agent contract task" could not be finished: fixture failure detail',
        '"Name the Agent contract task" was cancelled: fixture cancellation detail',
      ]);
      expect(discord).toEqual(slack);
      expect(h.lines.map(line => line.channel)).toEqual(['contract', 'contract', 'contract', 'contract']);
      expect(h.lines[0]?.text).toBe(`[Contract] ${events[0]!.contractId} started: Name the Agent contract task`);
      expect(h.followUps.map(item => item.summary)).toEqual([
        '"Name the Agent contract task" passed all its checks.',
        '"Name the Agent contract task" could not be finished: fixture failure detail',
        '"Name the Agent contract task" was cancelled: fixture cancellation detail',
      ]);
      expect(h.store.getState().contracts.contracts.get(events[0]!.contractId!)?.status).toBe('cancelled');
      expect(h.dispatch).toHaveBeenCalledTimes(events.length);
      expect(h.intervalCount).toBe(1);
      expect(h.renderCount()).toBe(events.length);
    } finally {
      await notifier.close(); h.dispose(); slackSpy.mockRestore(); discordSpy.mockRestore();
    }
  });

  for (const setting of [true, undefined, 'false']) {
    test(`restricted delivery omits remembered task and event details for setting ${JSON.stringify(setting)}`, async () => {
      const h = harness();
      const sent: string[] = [];
      const slackSpy = spyOn(SlackIntegration.prototype, 'postWebhook').mockImplementation(async text => { sent.push(text); });
      const discordSpy = spyOn(DiscordIntegration.prototype, 'postWebhook').mockImplementation(async () => {});
      const notifier = await createRuntimeNotifier(registry, () => setting);
      notifier.attachToRuntimeBus(h.runtimeBus);
      try {
        const events = lifecycle(`Private contract task ${String(setting)}`);
        for (const event of events) emitContractEvent(h.runtimeBus, 's1', event);
        await waitForNotices(() => sent.length === 3, () => JSON.stringify(sent));
        expect(sent).toEqual(Array(3).fill('GoodVibes: notification available'));
        // Local lifecycle presentation still knows the canonical task.
        expect(h.followUps[0]?.summary).toContain(`"Private contract task ${String(setting)}"`);
      } finally {
        await notifier.close(); h.dispose(); slackSpy.mockRestore(); discordSpy.mockRestore();
      }
    });
  }

  test('contract completion retains the shared cohort check and follow-up', async () => {
    const events = lifecycle('Complete the Agent cohort');
    const contract = { id: events[0]!.contractId, status: 'running', units: [{ id: 'u1', agentIds: ['a1'] }] } as unknown as ContractView;
    const contracts = [contract];
    const h = harness(contracts);
    try {
      emitContractEvent(h.runtimeBus, 's1', events[0]!);
      emitContractEvent(h.runtimeBus, 's1', events[1]!);
      await delivered();
      expect(h.lines.filter(line => line.channel === 'low')).toEqual([]);
      expect(h.followUps.some(item => item.key === 'cohort:batch:complete')).toBe(false);
      contracts[0] = { ...contract, status: 'passed' };
      emitContractEvent(h.runtimeBus, 's1', events[1]!);
      await delivered();
      expect(h.lines.filter(line => line.channel === 'low').map(line => line.text)).toEqual([
        expect.stringContaining("[Agents] Cohort 'batch' complete: 1 completed, 0 failed, 0 cancelled (1 total)"),
      ]);
      expect(h.followUps.filter(item => item.key === 'cohort:batch:complete')).toHaveLength(1);
    } finally { h.dispose(); }
  });

  test('teardown stops contract lines, follow-ups, state dispatch and render requests', async () => {
    const h = harness();
    try {
      const events = lifecycle('Detach the Agent contract bridge');
      emitContractEvent(h.runtimeBus, 's1', events[0]!);
      await delivered();
      h.stop();
      for (const event of events) emitContractEvent(h.runtimeBus, 's1', event);
      await delivered();
      expect(h.lines).toHaveLength(1);
      expect(h.followUps).toHaveLength(0);
      expect(h.dispatch).toHaveBeenCalledTimes(1);
      expect(h.renderCount()).toBe(1);
      expect(h.store.getState().contracts.contracts.get(events[0]!.contractId!)?.status).toBe('queued');
    } finally { h.dispose(); }
  });
});
