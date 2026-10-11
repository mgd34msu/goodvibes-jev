import { recordedEffectFixture } from '../helpers/recorded-effect-admission.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createShellPathService } from '@/runtime/index.ts';
import { readAgentChannelDeliveryReceipts } from '../../agent/channel-delivery-receipts.ts';
import {
  createAgentChannelSendTool,
  registerAgentChannelSendTool,
} from '../../tools/agent-channel-send-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fakeRouter(requests: ChannelDeliveryRequest[]) {
  const strategies = [{ id: 'fake-channel', canHandle: () => true, deliver: async () => ({}) }];
  return {
    listStrategies: () => strategies,
    deliver: async (request: ChannelDeliveryRequest) => {
      request.signal?.throwIfAborted(); request.assertCurrent?.();
      requests.push(request);
      return 'channel-response-1';
    },
  };
}

let prior: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
beforeEach(() => {
  log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((name, question) => {
    if (question.type === 'choice') {
      const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (!label) throw new Error(`Unexpected fixture question ${name}`);
      return choiceAnswer(question, label, 0.999);
    }
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected fixture question ${name}`);
  });
  prior = installJudgmentPort(withDecisionLog(fake.port, log));
});
afterEach(() => { installJudgmentPort(prior); log[Symbol.dispose](); });

describe('agent_channel_send tool', () => {
  test('explicit preview stays read-only without recorded admission', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentChannelSendTool(fakeRouter(requests));

    const result = await tool.execute({
      message: 'Review the approvals',
      channel: 'slack:ops:Ops',
      preview: true,
      explicitUserRequest: 'Send a Slack message to ops.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent channel delivery preview');
    expect(requests).toEqual([]);
  });

  test('caller flags cannot grant delivery admission', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentChannelSendTool(fakeRouter(requests));

    const result = await tool.execute({
      message: 'Review the approvals',
      channel: 'slack:ops:Ops',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('held');
    expect(requests).toEqual([]);
  });

  test('sends one message under recorded synthetic admission without caller flags', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentChannelSendTool(fakeRouter(requests));

    const result = await recordedEffectFixture(tool).run({
      message: 'Review the approvals',
      title: 'Approvals',
      channel: 'slack:ops:Ops',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent channel delivery sent');
    expect(result.output).toContain('channel-response-1');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.target).toMatchObject({ kind: 'surface', surfaceKind: 'slack', routeId: 'ops', label: 'Ops' });
    expect(requests[0]?.body).toBe('Review the approvals');
  });

  test('records a redacted receipt when shell paths are available', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const root = makeProjectTempDir('goodvibes-agent-channel-tool-receipts');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const tool = createAgentChannelSendTool(fakeRouter(requests), { shellPaths });

    const result = await recordedEffectFixture(tool).run({
      message: 'Review token=super-secret-value before posting',
      title: 'Webhook Delivery',
      webhook: 'https://hooks.example.test/services/T000/B000/secret-token',
      confirm: true,
      explicitUserRequest: 'Send this webhook message.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('receipt channel-delivery-');
    const snapshot = readAgentChannelDeliveryReceipts(shellPaths);
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.receipts[0]?.target.display).toBe('webhook https://hooks.example.test/...');
    expect(snapshot.receipts[0]?.target.addressDigest).toBeTruthy();
    expect(snapshot.receipts[0]?.messagePreview).toContain('token=[redacted]');
    expect(JSON.stringify(snapshot)).not.toContain('secret-token');
    expect(JSON.stringify(snapshot)).not.toContain('super-secret-value');
  });

  test('rejects ambiguous targets without sending', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentChannelSendTool(fakeRouter(requests));

    const result = await tool.execute({
      message: 'Review the approvals',
      channel: 'slack:ops:Ops',
      webhook: 'https://example.test/hook',
      confirm: true,
      explicitUserRequest: 'Send a message.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Choose exactly one delivery target');
    expect(requests).toEqual([]);
  });

  test('is registered in the model tool registry', () => {
    const registry = new ToolRegistry();

    registerAgentChannelSendTool(registry, fakeRouter([]));

    expect(registry.has('agent_channel_send')).toBe(true);
  });
});
