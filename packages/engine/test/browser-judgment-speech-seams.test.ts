import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { type AuthenticatedPrincipal, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';
import { canonicalSpeechSeams } from '../sdk/src/platform/judgment-browser/speech-source.ts';

const content = 'Dr. Rivera paused… then said “Go.” Next came silence.';
const owner: AuthenticatedPrincipal = { principalId: 'speech-fixture-owner', principalKind: 'user', admin: false, scopes: ['write:judgment', 'read:sessions'] };
const request = (text = content, cursor = 0): BrowserJudgmentRequest<'webui.voice.speech-seams'> => ({
  protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.voice.speech-seams', batteryVersion: 1,
  input: { sessionId: 'chat', messageId: 'message', start: 0, end: text.length, contentDigest: createHash('sha256').update(text).digest('hex'), cursor },
});
function fixture(options: { beforeAnswer?: () => Promise<void>; probability?: number; authorized?: boolean; content?: string } = {}) {
  const log = new SqliteDecisionLog(':memory:'); const calls: unknown[] = []; let actor = owner;
  const session = { id: 'chat', title: 'Fixture', createdAt: 1, updatedAt: 2 };
  let message = { id: 'message', sessionId: 'chat', content: options.content ?? content, createdAt: 3 };
  const port: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); await options.beforeAnswer?.();
    const state = input.state as { paragraph: string; candidates: number[] };
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: Object.fromEntries(Object.keys(input.questions).map((name, i) => [name, { type: 'noul', noul: options.probability ?? (state.candidates[i] === state.paragraph.indexOf(' Next') || state.candidates[i] === state.paragraph.length ? 0.999 : 0.001) }])) as never };
  } };
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(),
    currentRoute: () => ({ revision: 'route', kind: 'local', port: withDecisionLog(port, log), assertCurrent() {} }),
    authorize: ({ sources }) => options.authorized !== false && sources.length === 1 && sources[0] === 'chat-speech',
  });
  const release = service.bindChatSessions({ getSession: id => id === 'chat' ? session : null, getMessages: id => id === 'chat' ? [message] : [] });
  return { calls, log, release, mutateSession: () => { session.id = 'other-chat'; }, mutate: () => { message = { ...message, content: 'Replaced' }; },
    mutateMessageIdentity: () => { message.sessionId = 'other-chat'; }, changeActor: () => { actor = { ...owner, principalId: 'another' }; },
    run: (input = request(message.content), signal = new AbortController().signal) => service.execute(input, owner, signal, () => actor),
    close: async () => { release(); await service.close(); log[Symbol.dispose](); } };
}
test('canonical speech source reads contrary abbreviation, ellipsis and quotation seams without lexical fallback', async () => {
  const f = fixture(); try {
    const result = await f.run(); expect(result).toMatchObject({ status: 'settled', value: { endOffsets: [content.indexOf(' Next'), content.length], nextCursor: null }, outcome: 'act' });
    expect(f.calls).toEqual([{ paragraph: content, candidates: canonicalSpeechSeams(content, 0, content.length, 0).candidates }]);
    expect(f.log.query()).toHaveLength(1); expect(JSON.stringify(f.log.query())).not.toContain(content);
  } finally { await f.close(); }
});
test.each(['permission', 'digest', 'unknown-message', 'partial-paragraph', 'protected-outside-paragraph', 'oversized'] as const)('%s makes zero provider calls', async kind => {
  const text = kind === 'oversized' ? 'x'.repeat(32769) : content;
  const f = fixture({ authorized: kind !== 'permission', content: kind === 'protected-outside-paragraph' ? text + '\n\nAuthorization: Bearer synthetic-protected-material' : text });
  try {
    const input = request(kind === 'protected-outside-paragraph' ? text + '\n\nAuthorization: Bearer synthetic-protected-material' : text);
    if (kind === 'digest') Object.assign(input.input, { contentDigest: '0'.repeat(64) });
    if (kind === 'unknown-message') Object.assign(input.input, { messageId: 'unknown' });
    if (kind === 'partial-paragraph') Object.assign(input.input, { end: 10 });
    if (kind === 'protected-outside-paragraph') Object.assign(input.input, { end: content.length });
    await expect(f.run(input)).rejects.toBeDefined(); expect(f.calls).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
  } finally { await f.close(); }
});
test.each(['message-change', 'message-identity', 'session-change', 'identity', 'unbind', 'abort'] as const)('%s rejects in-flight publication', async kind => {
  const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
  const f = fixture({ beforeAnswer: async () => { started.resolve(); await finish.promise; } }); const abort = new AbortController();
  try {
    const pending = f.run(request(), abort.signal); await started.promise;
    if (kind === 'message-change') f.mutate(); else if (kind === 'message-identity') f.mutateMessageIdentity(); else if (kind === 'session-change') f.mutateSession(); else if (kind === 'identity') f.changeActor(); else if (kind === 'unbind') f.release(); else abort.abort();
    finish.resolve(); await expect(pending).rejects.toBeDefined(); expect(f.log.query()).toHaveLength(0);
  } finally { finish.resolve(); await f.close(); }
});
test('uncertain speech evidence exposes no offsets', async () => {
  const f = fixture({ probability: 0.5 }); try { const result = await f.run(); expect(result).toMatchObject({ status: 'held' }); expect(result).not.toHaveProperty('value'); }
  finally { await f.close(); }
});
test('candidate paging is bounded and each page retains complete paragraph context', async () => {
  const text = Array.from({ length: 90 }, () => 'word').join(' '); const f = fixture({ content: text });
  try {
    expect(await f.run(request(text))).toMatchObject({ status: 'settled', value: { nextCursor: 64 } });
    expect(await f.run(request(text, 64))).toMatchObject({ status: 'settled', value: { nextCursor: null } });
    expect(f.calls.map(call => (call as { candidates: unknown[] }).candidates.length)).toEqual([64, 26]);
    expect(f.calls.every(call => (call as { paragraph: string }).paragraph === text)).toBe(true);
  } finally { await f.close(); }
});
