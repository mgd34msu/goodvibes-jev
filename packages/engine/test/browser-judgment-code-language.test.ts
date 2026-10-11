import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { WEBUI_CODE_LANGUAGES, type AuthenticatedPrincipal, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';
import { readCanonicalFencedBlock } from '../sdk/src/platform/judgment-browser/code-source.ts';

const content = 'Before\n```\nconst count: number = 2;\n```\nAfter';
const owner: AuthenticatedPrincipal = { principalId: 'code-fixture-owner', principalKind: 'user', admin: false, scopes: ['write:judgment', 'read:sessions'] };
const request = (text = content): BrowserJudgmentRequest<'webui.code.language'> => ({
  protocolVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.code.language', batteryVersion: 1,
  input: { sessionId: 'chat', messageId: 'message', start: text.indexOf('```'), end: text.lastIndexOf('```') + 3, contentDigest: createHash('sha256').update(text).digest('hex') },
});
function fixture(options: { beforeAnswer?: () => Promise<void>; confidence?: number; authorized?: boolean; content?: string } = {}) {
  const log = new SqliteDecisionLog(':memory:'); const calls: unknown[] = [];
  let actor = owner;
  const session = { id: 'chat', title: 'Fixture', createdAt: 1, updatedAt: 2 };
  let message = { id: 'message', sessionId: 'chat', content: options.content ?? content, createdAt: 3 };
  const port: JudgmentPort = { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); await options.beforeAnswer?.();
    return { requestedModel: 'jev-1.13.0', model: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: { language: { type: 'choice', choice: 'typescript', confidence: options.confidence ?? 0.99,
        probabilities: Object.fromEntries(WEBUI_CODE_LANGUAGES.map(language => [language, language === 'typescript' ? 1 : 0])) } } as never };
  } };
  const service = createWebuiBrowserJudgment({ methods: new GatewayMethodCatalog(),
    currentRoute: () => ({ revision: 'route', kind: 'local', port: withDecisionLog(port, log), assertCurrent() {} }),
    authorize: ({ sources }) => options.authorized !== false && sources.length === 1 && sources[0] === 'chat-code',
  });
  const release = service.bindChatSessions({ getSession: id => id === 'chat' ? session : null, getMessages: id => id === 'chat' ? [message] : [] });
  return { calls, log, release,
    mutateSession: () => { session.id = 'other-chat'; },
    mutate: () => { message = { ...message, content: 'Replaced' }; },
    changeActor: () => { actor = { ...owner, principalId: 'another' }; },
    run: (input = request(message.content), signal = new AbortController().signal) => service.execute(input, owner, signal, () => actor),
    close: async () => { release(); await service.close(); log[Symbol.dispose](); } };
}
test('actual canonical message source provides only complete screened code and tag to the named reader', async () => {
  const f = fixture(); try {
    const result = await f.run(); expect(result).toMatchObject({ status: 'settled', value: { language: 'typescript' }, outcome: 'act' });
    expect(f.calls).toEqual([{ code: 'const count: number = 2;', tag: '' }]);
    expect(f.log.query()).toHaveLength(1); expect(JSON.stringify(f.log.query())).not.toContain('const count:');
  } finally { await f.close(); }
});
test.each(['permission', 'digest', 'unknown-message', 'out-of-bounds', 'protected-outside-block'] as const)('%s makes no provider call or hash retention', async kind => {
  const f = fixture({ authorized: kind !== 'permission', content: kind === 'protected-outside-block' ? content + '\nAuthorization: Bearer synthetic-protected-material' : content });
  try {
    const input = request(kind === 'protected-outside-block' ? content + '\nAuthorization: Bearer synthetic-protected-material' : content);
    if (kind === 'digest') Object.assign(input.input, { contentDigest: '0'.repeat(64) });
    if (kind === 'unknown-message') Object.assign(input.input, { messageId: 'unknown' });
    if (kind === 'out-of-bounds') Object.assign(input.input, { end: 9000 });
    await expect(f.run(input)).rejects.toBeDefined(); expect(f.calls).toHaveLength(0); expect(f.log.query()).toHaveLength(0);
  } finally { await f.close(); }
});
test.each(['message-change', 'session-change', 'identity', 'unbind', 'abort'] as const)('%s rejects an in-flight language answer', async kind => {
  const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
  const f = fixture({ beforeAnswer: async () => { started.resolve(); await finish.promise; } }); const abort = new AbortController();
  try {
    const pending = f.run(request(), abort.signal); await started.promise;
    if (kind === 'message-change') f.mutate(); else if (kind === 'session-change') f.mutateSession(); else if (kind === 'identity') f.changeActor(); else if (kind === 'unbind') f.release(); else abort.abort();
    finish.resolve(); await expect(pending).rejects.toBeDefined();
  } finally { finish.resolve(); await f.close(); }
});
test('held language readings contain no executable display value', async () => {
  const f = fixture({ confidence: 0.5 }); try { const result = await f.run(); expect(result).toMatchObject({ status: 'held' }); expect(result).not.toHaveProperty('value'); }
  finally { await f.close(); }
});
test('fence grammar does not cross earlier closure or accept prose/partial blocks', () => {
  const block = '  ~~~ps1\n  Get-ChildItem\n  ~~~';
  expect(readCanonicalFencedBlock(block, 0, block.length)).toEqual({ code: 'Get-ChildItem', tag: 'ps1' });
  expect(() => readCanonicalFencedBlock('```\none\n```\nprose\n```\ntwo\n```', 0, 31)).toThrow();
  expect(() => readCanonicalFencedBlock('not code', 0, 8)).toThrow();
});

test('a wrong canonical session object cannot authorize a message', async () => {
  const f = fixture(); try { f.mutateSession(); await expect(f.run()).rejects.toBeDefined(); expect(f.calls).toHaveLength(0); }
  finally { await f.close(); }
});
