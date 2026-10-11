import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ConversationManager } from '../../core/conversation.ts';
import { sessionSummary } from '../../tools/agent-harness-session-metadata.ts';
import type { CommandContext } from '../../input/command-registry.ts';
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => noulAnswer(0.5)).port); });
afterEach(() => installJudgmentPort(previous));
test('unsettled transcript count does not make unrelated saved-session metadata unavailable', async () => {
  const conversation = new ConversationManager(() => 100); conversation.addSystemMessage('[Approval] Waiting for a decision');
  const ctx = { session: { conversationManager: conversation, runtime: { sessionId: 'session', model: 'fixture', provider: 'fixture' }, sessionManager: { list: () => [], search: () => [] } }, workspace: {} } as unknown as CommandContext;
  const summary = await sessionSummary(ctx, {});
  expect(summary.status).toBe('available');
  expect(summary.sessions).toEqual([]);
  expect(summary.current).toMatchObject({ sessionId: 'session', messageCount: 1, transcript: { status: 'unavailable', events: null, groups: null } });
});

for (const changed of ['abort', 'session-manager']) test(`actual harness sessions refuses ${changed} during a paused noncooperating read`, async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; });
  const fake = fakePort(() => noulAnswer(0.99));
  installJudgmentPort({ model: fake.port.model, async ask(request) { entered(); await paused; return fake.port.ask(request); } });
  const conversation = new ConversationManager(() => 100); conversation.addSystemMessage('[Approval] Waiting');
  const ctx = { session: { conversationManager: conversation, runtime: { sessionId: 'session' }, sessionManager: { list: () => [], search: () => [] } }, workspace: {} } as unknown as CommandContext;
  const tool = createAgentHarnessTool({ commandContext: ctx } as Parameters<typeof createAgentHarnessTool>[0]);
  const controller = new AbortController();
  const result = tool.execute({ mode: 'sessions' }, { signal: controller.signal });
  await started;
  if (changed === 'abort') controller.abort(new Error('private cancellation reason'));
  else { Object.defineProperty(ctx.session, 'sessionManager', { value: { list: () => [], search: () => [] } }); resume(); }
  // Cancellation must settle even though the provider has not cooperated.
  const answer = await result;
  expect(answer.success).toBe(false); expect(JSON.stringify(answer)).not.toContain('private cancellation reason');
  expect(JSON.stringify(answer)).not.toContain('"status":"available"');
  resume();
});
