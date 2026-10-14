import { useSecurityReadings } from '../helpers/security-readings.ts';
import { describe, expect, setSystemTime, test } from 'bun:test';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryResult,
} from '../../agent/channel-delivery.ts';

useSecurityReadings();

describe('Agent channel delivery', () => {
  test('same-instant delivery IDs stay distinct and admissible at a card-shaped native clock', () => {
    setSystemTime(new Date(1_791_684_509_006));
    try {
      const first = buildAgentChannelDeliveryPreview({ message: 'Review approvals', channel: 'slack:ops:Ops' });
      const second = buildAgentChannelDeliveryPreview({ message: 'Review approvals', channel: 'slack:ops:Ops' });
      expect(first.request.runId).not.toBe(second.request.runId);
      expect(snapshotJudgmentInput(first.request)).toEqual(first.request);
      expect(snapshotJudgmentInput(second.request)).toEqual(second.request);
    } finally { setSystemTime(); }
  });

  test('builds explicit surface delivery requests', () => {
    const preview = buildAgentChannelDeliveryPreview({
      title: 'Approvals',
      message: 'Review approvals',
      channel: 'slack:ops:Ops',
    });

    expect(preview.request.target).toMatchObject({
      kind: 'surface',
      surfaceKind: 'slack',
      routeId: 'ops',
      label: 'Ops',
    });
    expect(preview.request.body).toBe('Review approvals');
    expect(preview.request.title).toBe('Approvals');
    expect(preview.request.metadata).toMatchObject({
      product: 'goodvibes-agent',
      source: 'agent-channel-send',
    });
  });

  test('rejects missing or ambiguous targets', () => {
    expect(() => buildAgentChannelDeliveryPreview({
      message: 'Review approvals',
    })).toThrow('Choose one delivery target');
    expect(() => buildAgentChannelDeliveryPreview({
      message: 'Review approvals',
      channel: 'slack',
      webhook: 'https://example.test/hook',
    })).toThrow('Choose exactly one delivery target');
  });

  test('delivers through the supplied router and formats the response', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const result = await deliverAgentChannelMessage({
      listStrategies: () => [{ id: 'fake', canHandle: () => true, deliver: async () => ({}) }],
      deliver: async (request) => {
        requests.push(request);
        return 'response-1';
      },
    }, {
      title: 'Delivery',
      message: 'Review the inbox',
      webhook: 'https://example.test/hook',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.target).toMatchObject({ kind: 'webhook', address: 'https://example.test/hook' });
    expect(result.responseId).toBe('response-1');
    expect(formatAgentChannelDeliveryResult(result)).toContain('Agent channel delivery sent');
  });
});
