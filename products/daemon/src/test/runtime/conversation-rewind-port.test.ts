import { afterEach, expect, test } from 'bun:test';
import { clearTurnAnchors, recordTurnAnchor } from '@goodvibes-jev/engine/sdk/platform/rewind';
import { createConversationRewindPort, createSessionConversationRewindPort, registerSessionConversation, unregisterSessionConversation, type RewindableConversation } from '../../runtime/conversation-rewind-port.ts';

const SESSION = 'fixture-product-rewind';
afterEach(() => { clearTurnAnchors(SESSION); unregisterSessionConversation(SESSION); });
function conversation(count: number) {
  let messages = Array.from({ length: count }, (_, index) => `fixture-${index}`); let rebuilt = 0;
  const port: RewindableConversation = {
    getMessageCount: () => messages.length,
    toJSON: () => [...messages],
    fromJSON(value) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('Invalid fixture snapshot');
      messages = [...value] as string[];
    },
    rebuildHistory: () => { rebuilt++; },
    removeMessagesAfter: (keep) => { messages = messages.slice(0, keep); },
  };
  return { port, get messages() { return [...messages]; }, get rebuilt() { return rebuilt; } };
}

test('an unhosted conversation is unavailable rather than a successful zero-count answer', async () => {
  const port = createConversationRewindPort(() => null); const anchor = { sessionId: SESSION, turnId: 'fixture' };
  expect(await port.preview(anchor)).toMatchObject({ available: false, messagesToDrop: 0, messagesRemaining: 0 });
  expect((await port.preview(anchor)).unavailableReason).toContain('holds no live conversation');
  expect(await port.rewind(anchor)).toMatchObject({ available: false, droppedMessages: 0, undoSnapshotId: '' });
});

test('recorded boundaries drive real truncation with reversible before/after snapshots', async () => {
  const fixture = conversation(5); const port = createConversationRewindPort(() => fixture.port);
  const anchor = { sessionId: SESSION, turnId: 'fixture-turn' };
  recordTurnAnchor(SESSION, { turnId: anchor.turnId, label: 'fixture', messageCount: 2, at: 1 });
  expect(await port.preview(anchor)).toEqual({ messagesToDrop: 3, messagesRemaining: 2 });
  const result = await port.rewind(anchor); expect(result.droppedMessages).toBe(3); expect(result.undoSnapshotId.length).toBeGreaterThan(0);
  expect(fixture.messages).toEqual(['fixture-0', 'fixture-1']);
  expect(port.restoreBefore(result.undoSnapshotId)).toBe(true); expect(fixture.messages).toHaveLength(5);
  expect(port.restoreAfter(result.undoSnapshotId)).toBe(true); expect(fixture.messages).toHaveLength(2);
  expect(fixture.rebuilt).toBe(3);
  expect(port.restoreBefore('unknown')).toBe(false); expect(port.restoreAfter('unknown')).toBe(false);
});

test('a boundary beyond the live count is clamped and absent boundaries preserve messages', async () => {
  const fixture = conversation(2); const port = createConversationRewindPort(() => fixture.port);
  recordTurnAnchor(SESSION, { turnId: 'future', label: 'fixture', messageCount: 20, at: 1 });
  expect(await port.preview({ sessionId: SESSION, turnId: 'future' })).toEqual({ messagesToDrop: 0, messagesRemaining: 2 });
  expect((await port.rewind({ sessionId: SESSION, turnId: 'missing' })).droppedMessages).toBe(0);
  expect(fixture.messages).toHaveLength(2);
});

test('the session registry resolves live ownership and unregister withdraws it', async () => {
  const port = createSessionConversationRewindPort(); const fixture = conversation(3);
  registerSessionConversation(SESSION, fixture.port);
  expect(await port.preview({ sessionId: SESSION })).toEqual({ messagesToDrop: 0, messagesRemaining: 3 });
  unregisterSessionConversation(SESSION);
  expect(await port.preview({ sessionId: SESSION })).toMatchObject({ available: false });
});
