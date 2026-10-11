/** Deterministic caller qualification of the canonical pending-approval reader. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { classifyTranscriptMessages, TranscriptReadingLifetime, TranscriptReadingUnsettledError } from '../sdk/src/platform/core/transcript-events/classify.js';
import { buildTranscriptEventIndex } from '../sdk/src/platform/core/transcript-events/index.js';
import { ConversationManager, type ConversationMessageSnapshot } from '../sdk/src/platform/core/conversation.js';
let previous: ReturnType<typeof installJudgmentPort>; let log: SqliteDecisionLog;
let probability: number; let calls: unknown[]; let pause: (() => Promise<void>) | undefined;
beforeEach(() => {
  probability = 0.99; calls = []; pause = undefined; log = new SqliteDecisionLog(':memory:');
  const fake = fakePort(() => noulAnswer(probability));
  const port: JudgmentPort = { model: fake.port.model, async ask(request) { request.beforeAttempt?.(); calls.push({ state: request.state, context: request.context }); await pause?.(); request.beforeAttempt?.(); return fake.port.ask(request); } };
  previous = installJudgmentPort(withDecisionLog(port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });
const system = (content: string): ConversationMessageSnapshot => ({ role: 'system', content });
for (const pending of [true, false]) test(`actual classifier follows canonical ${pending ? 'pending' : 'resolved'} reading despite contrary word list`, async () => {
  probability = pending ? 0.99 : 0.01;
  const text = pending ? '[Approval] approved allowed denied rejected granted' : '[Approval] Waiting for operator input';
  const index = await buildTranscriptEventIndex([system(text)]);
  expect(index.events[0]).toMatchObject({ id: 'msg-0-system', messageIndex: 0, kind: pending ? 'approval_request' : 'approval_resolution' });
  expect(index.groups[0]?.events).toEqual(index.events);
  expect(calls).toEqual([{ state: text, context: expect.objectContaining({ battery: 'engine.runtime.pending-approval' }) }]);
});
test('protocol tags, event IDs and tool linkage stay deterministic without a judgment port', async () => {
  installJudgmentPort(undefined);
  const index = await buildTranscriptEventIndex([
    system('[Remote] Connected'), system('[Contract] Running'), system('[Policy] Changed'), system('[Health] Healthy'),
    system('[Session] Restored'), system('[Task] Done'), system('ordinary system note'),
    { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Reading', toolCalls: [{ id: 'call', name: 'read', arguments: {} }] },
    { role: 'tool', content: 'Read result', callId: 'call', toolName: 'read' },
  ]);
  expect(index.events.map(event => event.kind)).toEqual(['remote_status', 'contract_state', 'policy_warning', 'diagnostic_notice', 'session_restore', 'task_transition', 'system_notice', 'user_input', 'assistant_output', 'tool_call', 'tool_result']);
  expect(index.groups.find(group => group.key === 'tool:call')?.events).toHaveLength(2); expect(calls).toEqual([]);
});
test('bracket-tag precedence remains structural, not a guessed approval reading', async () => {
  const events = await classifyTranscriptMessages([system('[Policy] [Approval] settings changed')]);
  expect(events[0]?.kind).toBe('policy_warning'); expect(calls).toEqual([]);
});
test('unsettled is not mislabeled resolution or request', async () => {
  probability = 0.5;
  await expect(buildTranscriptEventIndex([system('[Approval] unclear')])).rejects.toBeInstanceOf(TranscriptReadingUnsettledError);
});
for (const failure of ['unavailable', 'invalid', 'missing']) test(`${failure} never falls back to resolution keywords`, async () => {
  if (failure === 'missing') installJudgmentPort(undefined);
  else if (failure === 'unavailable') pause = async () => { throw new Error('Synthetic outage'); };
  else installJudgmentPort({ model: 'fixture', ask: async () => ({ answers: {} }) } as unknown as JudgmentPort);
  await expect(buildTranscriptEventIndex([system('[Approval] approved')])).rejects.toBeDefined();
});
test('all complete approval text is screened before the first transmission; unrelated private text stays local', async () => {
  await expect(classifyTranscriptMessages([system('[Approval] Waiting'), system('[Approval] Authorization: Bearer synthetic-secret')])).rejects.toBeDefined();
  expect(calls).toEqual([]); expect(log.query({})).toEqual([]);
  await classifyTranscriptMessages([{ role: 'user', content: 'Authorization: Bearer synthetic-local-only' }, system('[Approval] Waiting')]);
  expect(JSON.stringify(calls)).not.toContain('synthetic-local-only');
});
test('complete long approval message is read before display summary truncation', async () => {
  const text = `[Approval] ${'Context. '.repeat(100)}This remains unresolved.`;
  const events = await classifyTranscriptMessages([system(text)]);
  expect((calls[0] as { state: string }).state).toBe(text); expect(events[0]!.detail.length).toBeLessThanOrEqual(96);
});
for (const change of ['raw-source', 'conversation-reset', 'conversation-replacement', 'port-aba', 'abort']) test(`${change} while pending prevents late index and retained decision`, async () => {
  const messages = [system('[Approval] Waiting')]; const manager = new ConversationManager(); manager.addSystemMessage('[Approval] Waiting'); const abort = new AbortController();
  pause = async () => {
    if (change === 'raw-source') messages[0] = system('[Approval] Different source');
    else if (change === 'conversation-reset') manager.resetAll();
    else if (change === 'conversation-replacement') { manager.resetAll(); manager.addSystemMessage('[Approval] Waiting'); }
    else if (change === 'abort') abort.abort();
    else { const current = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port); installJudgmentPort(current); }
  };
  const result = change.startsWith('conversation-') ? manager.getTranscriptEventIndex() : classifyTranscriptMessages(messages, { signal: abort.signal });
  await expect(result).rejects.toBeDefined(); expect(log.query({})).toEqual([]);
});
test('async source authority callbacks are rejected, not hidden', async () => {
  await expect(new ConversationManager().getTranscriptEventIndex({ assertCurrent: async () => {} })).rejects.toBeDefined();
  expect(calls).toEqual([]);
});

test('large unrelated images and tool output retain deterministic transcript indexing without a reader', async () => {
  installJudgmentPort(undefined);
  const index = await buildTranscriptEventIndex([
    { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(1_100_000) }] },
    { role: 'tool', callId: 'large', content: 'x'.repeat(1_100_000) },
  ]);
  expect(index.events.map(event => event.kind)).toEqual(['user_input', 'tool_result']); expect(calls).toEqual([]);
});
for (const hook of ['getter', 'toJSON']) test(`local snapshot never invokes ${hook} hooks`, async () => {
  let invoked = 0;
  const message = hook === 'getter' ? { role: 'system', get content() { invoked++; return '[Approval] Waiting'; } } : { role: 'system', content: '[Approval] Waiting', toJSON() { invoked++; return {}; } };
  await expect(buildTranscriptEventIndex([message as ConversationMessageSnapshot])).rejects.toBeDefined();
  expect(invoked).toBe(0); expect(calls).toEqual([]);
});
for (const wrapper of ['index', 'manager']) test(`${wrapper} rejects port retirement in inner promise settlement gap`, async () => {
  const retireAfterCheck = wrapper === 'index' ? 1 : 2;
  let checks = 0;
  class Lifetime extends TranscriptReadingLifetime {
    override assertCurrent() {
      super.assertCurrent();
      if (++checks === retireAfterCheck) queueMicrotask(() => { const previous = installJudgmentPort(undefined); installJudgmentPort(previous); });
    }
  }
  const lifetime = new Lifetime();
  const manager = new ConversationManager(); manager.addSystemMessage('[Approval] Waiting');
  const result = wrapper === 'index' ? buildTranscriptEventIndex([system('[Approval] Waiting')], { lifetime }) : manager.getTranscriptEventIndex({ lifetime });
  await expect(result).rejects.toBeDefined(); expect(checks).toBe(retireAfterCheck);
});
