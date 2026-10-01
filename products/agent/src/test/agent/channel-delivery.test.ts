import { describe, expect, test } from 'bun:test';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import {
  buildAgentChannelDeliveryPreview,
  deliverAgentChannelMessage,
  formatAgentChannelDeliveryResult,
} from '../../agent/channel-delivery.ts';

describe('Agent channel delivery', () => {
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
