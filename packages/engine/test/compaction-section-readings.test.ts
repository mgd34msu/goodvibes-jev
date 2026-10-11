import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { compactMessages, getCompactionEvents } from '../sdk/src/platform/core/context-compaction.js';
import type { CompactionContext } from '../sdk/src/platform/core/compaction-types.js';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import { compactConversation, type ConversationCompactionHost } from '../sdk/src/platform/core/conversation-compaction.js';
import { renderSelected } from '../sdk/src/platform/runtime/compaction/section-readings.js';
import { makeContract } from './contract/fixtures.ts';
import { logger } from '../sdk/src/platform/utils/logger.js';
import { registry } from '../sdk/src/platform/runtime/judgment-registry.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
const providers = { getForModel() { throw new Error('Unexpected provider call'); }, listModels() { return []; } } as unknown as ProviderRegistry;
const context = (overrides: Partial<CompactionContext> = {}): CompactionContext => ({
  messages: [{ role: 'user', content: 'Preserve the API.' }, { role: 'assistant', content: 'Fixed the parser that printed "no resolved problems"; tests pass.' }],
  sessionMemories: [], agents: [], contracts: [], activePlan: null, lineageEntries: [], compactionCount: 0,
  contextWindow: 100_000, trigger: 'manual', extractionModelId: 'test/model', ...overrides,
});
function installed(answer: (battery: string, state: unknown) => unknown) {
  const { port, requests } = fakePort(() => noulAnswer(0.95));
  const wrapped: JudgmentPort = { ...port, async ask(request) {
    const result = await port.ask(request);
    return { ...result, answers: { selected: answer(request.context?.battery ?? '', request.state) } as never };
  } };
  installJudgmentPort(wrapped);
  return { requests, port: wrapped };
}

describe('structured compaction canonical source selection', () => {
  test('registers three named decisions', () => {
    const names = registry.list().map(decision => decision.name);
    expect(names).toContain('engine.compaction.conversation-substance');
    expect(names).toContain('engine.compaction.tool-result-relevance');
    expect(names).toContain('engine.compaction.resolved-problem-evidence');
  });
  test('typed yes survives contrary old sentinel wording and preserves prompting user/order', async () => {
    const { requests } = installed((_battery, state) => noulAnswer(JSON.stringify(state).includes('unused') ? 0.05 : 0.95));
    const result = await compactMessages(context(), providers);
    expect(result.sections.find(section => section.id === 'resolved-problems')?.content).toContain('"no resolved problems"');
    expect(result.sections.find(section => section.id === 'recent-conversation')?.content).toBe('[user]: Preserve the API.\n\n[assistant]: Fixed the parser that printed "no resolved problems"; tests pass.');
    expect(requests.every(request => request.context?.battery?.startsWith('engine.compaction.'))).toBe(true);
  });
  test('typed no suppresses positive-looking prose without lexical guesses', async () => {
    installed(battery => noulAnswer(battery.endsWith('resolved-problem-evidence') ? 0.01 : 0.99));
    const result = await compactMessages(context({ messages: [{ role: 'assistant', content: 'The issue is resolved! (This claim is false.)' }] }), providers);
    expect(result.sections.some(section => section.id === 'resolved-problems')).toBe(false);
  });
  test('retains paired user even when only assistant selected', async () => {
    installed((battery, state) => noulAnswer(battery.endsWith('conversation-substance') && (state as {candidateSourcePosition:number}).candidateSourcePosition === 2 ? 0.99 : 0.01));
    const result = await compactMessages(context(), providers);
    expect(result.sections.find(section => section.id === 'recent-conversation')?.content).toContain('[user]: Preserve the API.\n\n[assistant]:');
  });
  test('tool membership and output come from canonical reading and exact source', async () => {
    installed(() => noulAnswer(0.99));
    const result = await compactMessages(context({ messages: [{ role: 'tool', callId: 'test', content: 'Modified src/parser.ts; regression passed.' }] }), providers);
    expect(result.sections.find(section => section.id === 'tool-results')?.content).toBe('[tool; call test]: Modified src/parser.ts; regression passed.');
  });
  for (const [name, answer] of [
    ['prose', 'keep it'], ['missing', undefined], ['wrong type', { type: 'choice', choice: 'yes' }],
    ['NaN', noulAnswer(NaN)], ['range', noulAnswer(2)], ['weak', noulAnswer(0.5)],
  ] as const) test(`rejects ${name}, without publishing a compaction`, async () => {
    installed(() => answer);
    const ctx = context(); const before = JSON.stringify(ctx.messages); const events = getCompactionEvents().length;
    await expect(compactMessages(ctx, providers)).rejects.toThrow(/Compaction semantic selection/);
    expect(JSON.stringify(ctx.messages)).toBe(before);
    expect(getCompactionEvents().length).toBe(events);
  });
  test('missing canonical port cannot fall back to provider interpretation', async () => {
    await expect(compactMessages(context(), providers)).rejects.toThrow('selection unavailable');
  });
  test('production caller keeps original messages and lineage when canonical reading is unavailable', async () => {
    const ctx = context(); let replacements = 0; let lineage = 0;
    const host: ConversationCompactionHost = {
      getMessageCount: () => ctx.messages.length, getMessagesForLLM: () => ctx.messages,
      replaceMessagesForLLM: () => { replacements++; }, getSessionMemoryStore: () => null,
      getSessionLineageTracker: () => ({ addCompactionEntry: () => { lineage++; } }),
    };
    const original = JSON.stringify(ctx.messages);
    await expect(compactConversation(host, providers, 'test/model', 'manual', 'test', ctx)).rejects.toThrow('selection unavailable');
    expect(replacements).toBe(0); expect(lineage).toBe(0); expect(JSON.stringify(ctx.messages)).toBe(original);
  });
  test('each actual read contains earlier identity evidence and the later contrary correction', async () => {
    const { requests } = installed(() => noulAnswer(0.99));
    const messages = [
      { role: 'assistant' as const, content: 'The parser timeout is ticket A; B is unrelated.' },
      { role: 'assistant' as const, content: 'Fixed the parser timeout.' },
      { role: 'user' as const, content: 'A is reopened; B remains fixed.' },
    ];
    await compactMessages(context({ messages }), providers);
    for (const request of requests) {
      const source = (request.state as { conversation: string }).conversation;
      for (const message of messages) expect(source).toContain(message.content);
    }
  });
  test('oversized individual source fails explicitly rather than clipping a later contradiction', async () => {
    const { requests } = installed(() => noulAnswer(0.99));
    await expect(compactMessages(context({ messages: [{ role: 'user', content: 'x'.repeat(100_000) }, { role: 'assistant', content: 'The fix is not complete.' }] }), providers)).rejects.toThrow('selection budget');
    expect(requests).toHaveLength(0);
  });
  test('transport failure propagates without source-bearing logging', async () => {
    const { port } = fakePort(() => { throw new Error('synthetic unavailable'); });
    installJudgmentPort(port);
    await expect(compactMessages(context(), providers)).rejects.toThrow('selection unavailable');
  });
  test('cancellation returns promptly even for an uncooperative dependency', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const { port } = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...port, ask: async () => { entered(); return new Promise(() => {}); } });
    const controller = new AbortController();
    const result = compactMessages(context({ signal: controller.signal }), providers);
    await started; controller.abort(new Error('cancelled'));
    await expect(result).rejects.toThrow('cancelled');
  });
  test('source replacement retires delayed readings', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    const { port } = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...port, async ask(request) { entered(); await ready; return port.ask(request); } });
    const ctx = context(); const result = compactMessages(ctx, providers);
    await started; ctx.messages.push({ role: 'user', content: 'New requirement.' }); release();
    await expect(result).rejects.toThrow('Compaction source changed');
  });
  test('standing instruction mutation rejects a delayed production caller', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    const { port } = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...port, async ask(request) { entered(); await ready; return port.ask(request); } });
    const ctx = context({ instructionChain: 'Original instruction.' }); let replacements = 0;
    const host: ConversationCompactionHost = { getMessageCount: () => ctx.messages.length, getMessagesForLLM: () => ctx.messages,
      replaceMessagesForLLM: () => { replacements++; }, getSessionMemoryStore: () => null,
      getSessionLineageTracker: () => ({ addCompactionEntry() {} }) };
    const result = compactConversation(host, providers, 'test/model', 'manual', 'test', ctx);
    await started; ctx.instructionChain = 'New instruction.'; release();
    await expect(result).rejects.toThrow(); expect(replacements).toBe(0);
  });
  test('canonical failure retires older prose request and suppresses its late private error', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let reject!: (error: Error) => void; const delayed = new Promise<never>((_, fail) => { reject = fail; });
    const { port } = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...port, async ask() { await started; throw new Error('SYNTHETIC_PRIVATE_SELECTION'); } });
    let providerSignal: AbortSignal | undefined;
    const older = { getForModel: () => ({ chat: (request: { signal?: AbortSignal }) => {
      providerSignal = request.signal; entered(); return delayed;
    } }), listModels: () => [{ id: 'model', provider: 'test', registryKey: 'test/model' }] } as unknown as ProviderRegistry;
    const warn = spyOn(logger, 'warn'); const info = spyOn(logger, 'info');
    try {
      const ctx = context({ contracts: Array.from({ length: 150 }, (_, index) => makeContract({ id: `contract-${index}` })) });
      await expect(compactMessages(ctx, older)).rejects.toThrow('selection unavailable');
      expect(providerSignal?.aborted).toBe(true);
      const count = warn.mock.calls.length + info.mock.calls.length;
      reject(new Error('SYNTHETIC_PRIVATE_OLDER_SOURCE'));
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(warn.mock.calls.length + info.mock.calls.length).toBe(count);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SYNTHETIC_PRIVATE');
    } finally { reject(new Error('late cleanup')); warn.mockRestore(); info.mockRestore(); }
  });
  test('tool call identity and arguments survive source selection', async () => {
    const { requests } = installed(() => noulAnswer(0.99));
    const result = await compactMessages(context({ messages: [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call-7', name: 'write_file', arguments: { path: 'src/parser.ts', content: 'fix' } }] },
      { role: 'tool', callId: 'call-7', name: 'write_file', content: 'Done' },
    ] }), providers);
    const tools = result.sections.find(section => section.id === 'tool-results')!.content;
    expect(tools).toContain('call-7'); expect(tools).toContain('src/parser.ts'); expect(tools).toContain('Done');
    for (const request of requests) expect(JSON.stringify(request.state)).toContain('src/parser.ts');
  });
  test('tool identity and complete arguments survive clipping a long assistant body', async () => {
    installed(() => noulAnswer(0.99));
    const result = await compactMessages(context({ messages: [
      { role: 'assistant', content: 'Long explanation. '.repeat(1200), toolCalls: [{ id: 'call-long', name: 'write_file', arguments: { path: 'src/parser.ts', content: 'fix' } }] },
      { role: 'tool', callId: 'call-long', name: 'write_file', content: 'Done' },
    ] }), providers);
    const tools = result.sections.find(section => section.id === 'tool-results')!.content;
    expect(tools).toContain('[call call-long; write_file]: {"path":"src/parser.ts","content":"fix"}');
    expect(tools).toContain('[tool write_file; call call-long]: Done');
    expect(tools).toContain('[clipped]');
  });
  test('cannot clip required tool arguments into misleading provenance', () => {
    expect(() => renderSelected([{ role: 'assistant', content: '', toolCalls: [{ id: 'call-large', name: 'write_file', arguments: { content: 'x'.repeat(1000) } }] }], new Set([0]), 40)).toThrow('selection budget');
  });
  test('assistant gathered at the budget edge keeps its full-source prompting user', async () => {
    installed(() => noulAnswer(0.99));
    const result = await compactMessages(context({ messages: [
      { role: 'user', content: 'Boundary requirement. ' + 'x'.repeat(12_001) },
      { role: 'assistant', content: 'Implemented the requirement.' },
    ] }), providers);
    const recent = result.sections.find(section => section.id === 'recent-conversation')!.content;
    expect(recent).toContain('[user]: Boundary requirement.'); expect(recent).toContain('[assistant]: Implemented');
  });
  test('port replacement retires an in-flight selection', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const { port } = fakePort(() => noulAnswer(0.99));
    installJudgmentPort({ ...port, ask: async () => { entered(); return new Promise(() => {}); } });
    const result = compactMessages(context(), providers);
    await started; installJudgmentPort(port);
    await expect(result).rejects.toThrow();
  });
  test('standing instructions are not fed into membership decisions', async () => {
    const { requests } = installed(() => noulAnswer(0.99));
    const result = await compactMessages(context({ instructionChain: 'SYNTHETIC_STANDING_ONLY', activeSkillFrontmatter: 'SYNTHETIC_SKILL_ONLY' }), providers);
    expect(result.summary).toContain('SYNTHETIC_STANDING_ONLY');
    expect(JSON.stringify(requests)).not.toContain('SYNTHETIC_STANDING_ONLY');
    expect(JSON.stringify(requests)).not.toContain('SYNTHETIC_SKILL_ONLY');
  });
  test('source quotes stay ordered and inside deterministic budgets', () => {
    const messages = [{ role: 'user' as const, content: 'a'.repeat(200) }, { role: 'assistant' as const, content: 'b'.repeat(200) }];
    const rendered = renderSelected(messages, new Set([1, 0]), 30);
    expect(rendered.length).toBeLessThanOrEqual(120);
    expect(rendered).toStartWith('[user]:');
    expect(rendered).toContain('[assistant]:');
    expect(rendered).toContain('[clipped]');
  });
});
