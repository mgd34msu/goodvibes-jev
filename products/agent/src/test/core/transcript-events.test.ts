import { TranscriptReadingLifetime } from '@goodvibes-jev/engine/sdk/platform/core';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ConversationManager } from '../../core/conversation';

let prior: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { prior = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); });
afterEach(() => installJudgmentPort(prior));

describe('transcript event index', () => {
  test('classifies tool runs and system notices into grouped transcript events', async () => {
    const conversation = new ConversationManager(() => 100);
    conversation.addUserMessage('review the file');
    conversation.addAssistantMessage('Running checks.', {
      toolCalls: [{ id: 'call-1', name: 'exec', arguments: { command: 'git diff --stat' } }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([{ callId: 'call-1', success: true, output: '1 file changed' }]);
    conversation.addSystemMessage('[Remote] Attached to runner pool alpha');

    const index = await conversation.getTranscriptEventIndex();
    expect(index.events).toContainEqual(expect.objectContaining({ kind: 'user_input' }));
    expect(index.events).toContainEqual(expect.objectContaining({
      kind: 'tool_call',
      relatedCallId: 'call-1',
    }));
    expect(index.events).toContainEqual(expect.objectContaining({
      kind: 'tool_result',
      relatedCallId: 'call-1',
    }));
    expect(index.events).toContainEqual(expect.objectContaining({ kind: 'remote_status' }));
    expect(index.groups).toContainEqual(expect.objectContaining({ key: 'tool:call-1' }));
    expect(index.events.find((event) => event.kind === 'tool_result' && event.relatedCallId === 'call-1')?.title).toBe('exec');
  });

  test('navigates to next and previous transcript event lines by kind', async () => {
    const conversation = new ConversationManager(() => 100);
    conversation.addUserMessage('review the file');
    conversation.addAssistantMessage('Running checks.', {
      toolCalls: [{ id: 'call-1', name: 'exec', arguments: { command: 'git diff --stat' } }],
      model: 'gpt-5.4',
      provider: 'openai',
    });
    conversation.addToolResults([{ callId: 'call-1', success: true, output: '1 file changed' }]);
    conversation.addSystemMessage('[Approval] Waiting for operator input');

    conversation.flushHistory();
    const nextTool = await conversation.nextTranscriptEventLine(0, 'tool_result');
    const prevTool = await conversation.prevTranscriptEventLine(999, 'tool_result');

    expect(nextTool).toBeGreaterThanOrEqual(0);
    expect(prevTool).toBe(nextTool);
    expect(await conversation.nextTranscriptEventLine(0, 'diagnostic_notice')).toBe(-1);
  });
});

for (const direction of ['next', 'prev']) test(`${direction} navigation rejects owner retirement after manager settles`, async () => {
  const manager = new ConversationManager(() => 100); manager.addSystemMessage('[Approval] Waiting');
  let checks = 0;
  class Lifetime extends TranscriptReadingLifetime {
    override assertCurrent() {
      super.assertCurrent();
      if (++checks === 3) queueMicrotask(() => { const previous = installJudgmentPort(undefined); installJudgmentPort(previous); });
    }
  }
  const options = { lifetime: new Lifetime() };
  await expect(direction === 'next' ? manager.nextTranscriptEventLine(0, 'all', options) : manager.prevTranscriptEventLine(0, 'all', options)).rejects.toBeDefined();
  expect(checks).toBe(3);
});
