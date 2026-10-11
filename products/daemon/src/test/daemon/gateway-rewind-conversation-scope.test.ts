/** Pinned daemon 493ccb2d2a99d86b0af3c1e90ad4d4a2c3a388d1.
 * Reconstructed after executor replacement; see the bounded source-proof audit.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { recordTurnAnchor, clearTurnAnchors } from '@goodvibes-jev/engine/sdk/platform/rewind';
import { registerSessionConversation, unregisterSessionConversation, type RewindableConversation } from '../../runtime/conversation-rewind-port.ts';
import { useGatewayFixture } from '../helpers/gateway-fixture.js';

const fixture = useGatewayFixture();
const SESSION = 's-daemon-rewind';
const WIRE_SESSION = 's-client-hosted';
afterAll(() => { clearTurnAnchors(SESSION); unregisterSessionConversation(SESSION); });

function conversation(count: number): RewindableConversation {
  let messages = Array.from({ length: count }, (_, index) => `m${index}`);
  return {
    getMessageCount: () => messages.length,
    toJSON: () => [...messages],
    fromJSON(value) {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Invalid fixture snapshot');
      messages = [...value] as string[];
    },
    removeMessagesAfter: keep => { messages = messages.slice(0, keep); },
    rebuildHistory: () => {},
  };
}
interface Plan {
  conversation: { available: boolean; messagesToDrop: number; messagesRemaining: number } | null;
  token: string;
  warnings: readonly string[];
}
interface Applied {
  refused: boolean;
  receipt: { conversation: { rewound: boolean; droppedMessages: number } | null; warnings: readonly string[] } | null;
}
function invoke(methodId: string, body: unknown): Promise<unknown> {
  return fixture().services.gatewayMethods.invoke(methodId, { methodId, body } as never);
}

describe('product-composed conversation rewind', () => {
  test('plan and apply descriptors are registered', () => {
    expect(fixture().services.gatewayMethods.get('rewind.plan')).toBeTruthy();
    expect(fixture().services.gatewayMethods.get('rewind.apply')).toBeTruthy();
  });
  test('plan resolves live conversation and reports 2 dropped, 3 retained', async () => {
    registerSessionConversation(SESSION, conversation(5));
    recordTurnAnchor(SESSION, { turnId: 't-preview', label: 'preview', messageCount: 3, at: Date.now() });
    const plan = await invoke('rewind.plan', { sessionId: SESSION, turnId: 't-preview', scope: 'conversation' }) as Plan;
    expect(plan.conversation).toBeTruthy();
    expect(plan.conversation?.available).toBe(true);
    expect(plan.conversation?.messagesToDrop).toBe(2);
    expect(plan.conversation?.messagesRemaining).toBe(3);
    expect(typeof plan.token).toBe('string');
  });
  test('apply drops 3 messages and leaves the live conversation at 2', async () => {
    const conv = conversation(5);
    registerSessionConversation(SESSION, conv);
    recordTurnAnchor(SESSION, { turnId: 't-apply', label: 'apply', messageCount: 2, at: Date.now() });
    const applied = await invoke('rewind.apply', { sessionId: SESSION, turnId: 't-apply', scope: 'conversation', confirm: true }) as Applied;
    expect(applied.refused).toBe(false);
    expect(applied.receipt?.conversation?.rewound).toBe(true);
    expect(applied.receipt?.conversation?.droppedMessages).toBe(3);
    expect(conv.getMessageCount()).toBe(2);
  });
  test('unhosted plan reports unavailable with reason, not successful zero', async () => {
    const plan = await invoke('rewind.plan', { sessionId: 's-unhosted', scope: 'conversation' }) as Plan;
    expect(plan.conversation?.available).toBe(false);
    expect(plan.conversation?.messagesToDrop).toBe(0);
    expect(plan.warnings.join(' ')).toContain('holds no live conversation for that session');
  });
  test('unhosted apply gives a skipped receipt', async () => {
    const applied = await invoke('rewind.apply', { sessionId: 's-unhosted', scope: 'conversation', confirm: true }) as Applied;
    expect(applied.refused).toBe(false);
    expect(applied.receipt?.conversation?.rewound).toBe(false);
    expect(applied.receipt?.warnings.join(' ')).toContain('conversation rewind skipped');
  });
});

describe('in-process exchange through actual product host broker verbs', () => {
  test('all five host verbs have descriptors and handlers', () => {
    for (const id of ['rewind.conversation.host.register', 'rewind.conversation.host.release',
      'rewind.conversation.hosts.list', 'rewind.conversation.requests.take', 'rewind.conversation.requests.answer']) {
      expect(fixture().services.gatewayMethods.get(id), id).toBeTruthy();
      expect(fixture().services.gatewayMethods.hasHandler(id), id).toBe(true);
    }
  });
  test('offered host answers with its own 4 dropped, 9 retained counts', async () => {
    const registered = await invoke('rewind.conversation.host.register', { sessionId: WIRE_SESSION, label: 'client fixture' }) as { host: { hostId: string } };
    const hostId = registered.host.hostId;
    // Same protocol exchange as pinned original; no OS-level second process.
    const planned = invoke('rewind.plan', { sessionId: WIRE_SESSION, scope: 'conversation' }) as Promise<Plan>;
    void planned.catch(() => {});
    try {
      let requestId = '';
      for (let attempt = 0; attempt < 200 && !requestId; attempt++) {
        const taken = await invoke('rewind.conversation.requests.take', { hostId, waitMs: 50 }) as { requests: readonly { requestId: string }[] };
        requestId = taken.requests[0]?.requestId ?? '';
      }
      expect(requestId).not.toBe('');
      await invoke('rewind.conversation.requests.answer', { hostId, requestId, messagesToDrop: 4, messagesRemaining: 9 });
      const plan = await planned;
      expect(plan.conversation?.available).toBe(true);
      expect(plan.conversation?.messagesToDrop).toBe(4);
      expect(plan.conversation?.messagesRemaining).toBe(9);
    } finally {
      await invoke('rewind.conversation.host.release', { sessionId: WIRE_SESSION, hostId });
    }
  });
});
