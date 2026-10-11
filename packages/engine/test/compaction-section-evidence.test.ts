import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { estimateTokens, LIMITS, type JudgmentPort } from '@goodvibes-jev/judgment';
import { OwnedJudgmentWork } from '../sdk/src/platform/runtime/owned-judgment-work.js';
import { readDependencyQualifiedMembership, COMPACTION_EVIDENCE_LIMITS } from '../sdk/src/platform/runtime/compaction/section-evidence.js';
import { resolvedProblemEvidence } from '../sdk/src/platform/runtime/compaction/batteries/section-selection.js';
import { compactMessages } from '../sdk/src/platform/core/context-compaction.js';
import { compactConversation, type ConversationCompactionHost } from '../sdk/src/platform/core/conversation-compaction.js';
import type { CompactionContext } from '../sdk/src/platform/core/compaction-types.js';
import type { ProviderMessage } from '../sdk/src/platform/providers/interface.js';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });
interface State { conversation: string; cases: { id: string; candidateSourcePosition: number; evidenceSourcePositions: number[] }[] }
interface Instruction { caseId: string; targetSourcePosition?: number; candidateSourcePosition?: number }
const cases = [{ id: 'target', sourceIndex: 0, battery: resolvedProblemEvidence }];
/** Different source messages and distinct numbered facts, not a compressible run fixture. */
function distinctSources(): string[] {
  return Array.from({ length: 64 }, (_, index) => `[assistant]: Independent record ${index}. `
    + Array.from({ length: 48 }, (_, row) => `Record ${index} observation ${row} has identifier ${(index * 7919 + row * 104729).toString(36)} and count ${index + row}.`).join(' '));
}
const context = (messages: ProviderMessage[]): CompactionContext => ({ messages, sessionMemories: [], agents: [], contracts: [], activePlan: null,
  lineageEntries: [], compactionCount: 0, contextWindow: 100_000, trigger: 'manual', extractionModelId: 'test/model' });
const provider = { getForModel() { throw new Error('Unexpected ordinary provider call'); }, listModels: () => [] } as unknown as ProviderRegistry;

function fixturePort(answer: (key: string, input: Instruction, state: State) => unknown) {
  const port = fakePort((key, question, raw) => answer(key, question.instructions as unknown as Instruction, raw as unknown as State));
  installJudgmentPort(port.port); return port;
}

describe('dependency-qualified large compaction evidence', () => {
  test('reverse-discovered multihop aliases preserve raw linking and correction evidence in final read', async () => {
    const sources = distinctSources();
    sources[0] = '[assistant]: Fixed the parser timeout.';
    sources[5] = '[user]: A has reopened; the timeout still reproduces.';
    sources[25] = '[assistant]: In these notes B is the same issue as A.';
    sources[55] = '[assistant]: The parser timeout is called B in these notes.';
    let final = false;
    const { requests } = fixturePort((key, input, state) => {
      const evidence = state.cases.find(entry => entry.id === input.caseId)!.evidenceSourcePositions;
      if (key.startsWith('dependency_')) {
        const needed = input.targetSourcePosition === 56 || (input.targetSourcePosition === 26 && evidence.includes(56))
          || (input.targetSourcePosition === 6 && evidence.includes(26));
        return noulAnswer(needed ? 0.99 : 0.01);
      }
      final = true;
      for (const index of [0, 5, 25, 55]) expect(state.conversation).toContain(sources[index]!);
      return noulAnswer(0.01);
    });
    const result = await readDependencyQualifiedMembership(sources, cases, () => [], new OwnedJudgmentWork());
    expect(final).toBe(true); expect(result.get('target')).toBe(false);
    expect(requests.length).toBeLessThan(64);
    for (const request of requests) {
      const tokenCounts = Object.values(request.questions).map(estimateTokens);
      expect(estimateTokens(request.state) + Math.max(...tokenCounts)).toBeLessThanOrEqual(LIMITS.maxStateWithQuestionTokens);
      expect(estimateTokens(request.state) + tokenCounts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(LIMITS.maxRequestTokens);
    }
  });
  test('later aliases cause reconsideration of a correction and its retraction-of-retraction', async () => {
    const sources = distinctSources();
    sources[0] = '[assistant]: Fixed the parser timeout.';
    sources[2] = '[user]: A still fails.';
    sources[12] = '[user]: My claim that A fails was wrong.';
    sources[32] = '[user]: That retraction was itself wrong; A does fail.';
    sources[60] = '[assistant]: Parser timeout is ticket A.';
    fixturePort((key, input, state) => {
      const evidence = state.cases.find(entry => entry.id === input.caseId)!.evidenceSourcePositions;
      if (key.startsWith('dependency_')) return noulAnswer(input.targetSourcePosition === 61
        || (evidence.includes(61) && [3, 13, 33].includes(input.targetSourcePosition!)) ? 0.99 : 0.01);
      for (const index of [0, 2, 12, 32, 60]) expect(state.conversation).toContain(sources[index]!);
      return noulAnswer(0.01);
    });
    expect((await readDependencyQualifiedMembership(sources, cases, () => [], new OwnedJudgmentWork())).get('target')).toBe(false);
  });
  test('a distinct large history completes through real section production with batched bounded requests', async () => {
    const messages: ProviderMessage[] = distinctSources().map(content => ({ role: 'assistant', content }));
    messages.push({ role: 'user', content: 'Preserve the parser API.' }, { role: 'assistant', content: 'The API constraint is preserved; tests pass.' });
    const { requests } = fixturePort(key => noulAnswer(key.startsWith('dependency_') || key.startsWith('selected_c2_') ? 0.01 : 0.99));
    const result = await compactMessages(context(messages), provider);
    expect(result.sections.find(section => section.id === 'recent-conversation')!.content).toContain('Preserve the parser API.');
    expect(result.tokensAfterEstimate).toBeLessThan(result.tokensBeforeEstimate);
    expect(requests.some(request => request.context?.battery === 'engine.compaction.evidence-dependency')).toBe(true);
    expect(requests.length).toBeLessThan(COMPACTION_EVIDENCE_LIMITS.calls);
    const covered = requests.filter(request => request.context?.battery === 'engine.compaction.evidence-dependency').map(request => (request.state as unknown as State).conversation).join('\n');
    for (const message of messages) expect(covered).toContain(message.content as string);
  });
  test('large-history actual caller applies messages and lineage after semantic quality qualification', async () => {
    const ctx = context(distinctSources().map(content => ({ role: 'assistant', content })));
    ctx.messages.push({ role: 'user', content: 'Keep the API compatible.' }, { role: 'assistant', content: 'Compatibility retained; tests pass.' });
    const { port, requests } = fakePort((key, question) => {
      if (key === 'substance') return scoreAnswer(question, 3, 0.99);
      if (key === 'relation') return choiceAnswer(question, 'supports', 0.99);
      return noulAnswer(key.startsWith('dependency_') || key.startsWith('selected_c2_') ? 0.01 : 0.99);
    });
    installJudgmentPort(port);
    let current = ctx.messages; let replacements = 0; let lineage = 0;
    const host: ConversationCompactionHost = { getMessageCount: () => current.length, getMessagesForLLM: () => current,
      replaceMessagesForLLM: messages => { current = messages; replacements++; }, getSessionMemoryStore: () => null,
      getSessionLineageTracker: () => ({ addCompactionEntry: () => { lineage++; } }) };
    const receipt = await compactConversation(host, provider, 'test/model', 'manual', 'test', ctx);
    expect(receipt?.outcome).toBe('applied'); expect(replacements).toBe(1); expect(lineage).toBe(1);
    expect(current).toHaveLength(1); expect(current[0]!.content).toContain('Keep the API compatible.');
    expect(requests.some(request => request.context?.battery === 'engine.compaction.evidence-dependency')).toBe(true);
  });
  test('final requests cannot acquire a different case unaudited alias', async () => {
    const sources = distinctSources();
    sources[0] = 'Parser timeout fixed.'; sources[1] = 'Separate case uses alias Q.';
    sources[20] = 'For the separate case Q is the parser subsystem.';
    sources[40] = 'Q is reopened.';
    const { requests } = fixturePort((key, input, state) => {
      if (key.startsWith('dependency_')) {
        const scope = input as Instruction & { evidenceScope: string };
        expect(scope.evidenceScope).toContain('Other cases');
        return noulAnswer(input.caseId === 'other' && [21, 41].includes(input.targetSourcePosition!) ? 0.99 : 0.01);
      }
      const entry = state.cases.find(item => item.id === input.caseId)!;
      for (const peer of state.cases) expect(peer.evidenceSourcePositions).toEqual(entry.evidenceSourcePositions);
      if (input.caseId === 'target') {
        expect(state.conversation).not.toContain(sources[20]!); expect(state.conversation).not.toContain(sources[40]!);
      } else {
        expect(state.conversation).toContain(sources[20]!); expect(state.conversation).toContain(sources[40]!);
      }
      return noulAnswer(0.99);
    });
    await readDependencyQualifiedMembership(sources, [...cases, { id: 'other', sourceIndex: 1, battery: resolvedProblemEvidence }], () => [], new OwnedJudgmentWork());
    expect(requests.filter(request => request.context?.battery === 'engine.compaction.resolved-problem-evidence')).toHaveLength(2);
  });
  test('malformed dependency answer cannot change actual caller history or lineage', async () => {
    fixturePort(() => noulAnswer(NaN));
    const ctx = context(distinctSources().map(content => ({ role: 'assistant', content })));
    let replacements = 0; let lineage = 0;
    const host: ConversationCompactionHost = { getMessageCount: () => ctx.messages.length, getMessagesForLLM: () => ctx.messages,
      replaceMessagesForLLM: () => { replacements++; }, getSessionMemoryStore: () => null,
      getSessionLineageTracker: () => ({ addCompactionEntry: () => { lineage++; } }) };
    await expect(compactConversation(host, provider, 'test/model', 'manual', 'test', ctx)).rejects.toThrow('selection malformed');
    expect(replacements).toBe(0); expect(lineage).toBe(0);
  });
  test('actual caller cancelled during a later evidence sweep leaves messages and lineage intact', async () => {
    const controller = new AbortController(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const base = fakePort((key, question) => {
      const input = question.instructions as unknown as Instruction;
      return noulAnswer(key.startsWith('dependency_') && input.caseId === 'c2_0' && input.targetSourcePosition === 56 ? 0.99 : 0.01);
    });
    installJudgmentPort({ ...base.port, async ask(request) {
      const state = request.state as unknown as State;
      if (state.cases.some(entry => entry.id === 'c2_0' && entry.evidenceSourcePositions.includes(56))) { entered(); return new Promise(() => {}); }
      return base.port.ask(request);
    } });
    const ctx = context(distinctSources().map(content => ({ role: 'assistant', content }))); ctx.signal = controller.signal;
    let replacements = 0; let lineage = 0;
    const host: ConversationCompactionHost = { getMessageCount: () => ctx.messages.length, getMessagesForLLM: () => ctx.messages,
      replaceMessagesForLLM: () => { replacements++; }, getSessionMemoryStore: () => null,
      getSessionLineageTracker: () => ({ addCompactionEntry: () => { lineage++; } }) };
    const result = compactConversation(host, provider, 'test/model', 'manual', 'test', ctx);
    await started; controller.abort(new Error('later caller sweep cancelled'));
    await expect(result).rejects.toThrow(); expect(replacements).toBe(0); expect(lineage).toBe(0);
  });
  test('ambiguous dependencies are included; an overfull closure preserves original caller history', async () => {
    fixturePort(key => noulAnswer(key.startsWith('dependency_') ? 0.5 : 0.99));
    const ctx = context(distinctSources().map(content => ({ role: 'assistant', content })));
    let replacements = 0; let lineage = 0;
    const host: ConversationCompactionHost = { getMessageCount: () => ctx.messages.length, getMessagesForLLM: () => ctx.messages,
      replaceMessagesForLLM: () => { replacements++; }, getSessionMemoryStore: () => null,
      getSessionLineageTracker: () => ({ addCompactionEntry: () => { lineage++; } }) };
    const original = JSON.stringify(ctx.messages);
    await expect(compactConversation(host, provider, 'test/model', 'manual', 'test', ctx)).rejects.toThrow('selection budget');
    expect(replacements).toBe(0); expect(lineage).toBe(0); expect(JSON.stringify(ctx.messages)).toBe(original);
  });
  test('an ambiguous dependency that fits is carried, not treated as no', async () => {
    const sources = distinctSources(); sources[7] = 'Ambiguous earlier identity needed to interpret this candidate.';
    fixturePort((key, input, state) => {
      if (key.startsWith('dependency_')) return noulAnswer(input.targetSourcePosition === 8 ? 0.5 : 0.01);
      expect(state.conversation).toContain(sources[7]!); return noulAnswer(0.99);
    });
    expect((await readDependencyQualifiedMembership(sources, cases, () => [], new OwnedJudgmentWork())).get('target')).toBe(true);
  });
  test('weak final membership cannot install a section', async () => {
    fixturePort(key => noulAnswer(key.startsWith('dependency_') ? 0.01 : 0.5));
    await expect(readDependencyQualifiedMembership(distinctSources(), cases, () => [], new OwnedJudgmentWork())).rejects.toThrow('selection unqualified');
  });
  test('source size bound refuses before any canonical request', async () => {
    const { requests } = fixturePort(() => noulAnswer(0.99));
    await expect(readDependencyQualifiedMembership(Array.from({ length: COMPACTION_EVIDENCE_LIMITS.sourceMessages + 1 }, () => 'source'), cases, () => [], new OwnedJudgmentWork())).rejects.toThrow('selection budget');
    expect(requests).toHaveLength(0);
  });
  test('later sweep cancellation stops an ignored-abort transport and never reaches final membership', async () => {
    const controller = new AbortController(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let final = false;
    const base = fakePort((key, question) => noulAnswer(key.startsWith('dependency_') && (question.instructions as unknown as Instruction).targetSourcePosition === 56 ? 0.99 : 0.01));
    const port: JudgmentPort = { ...base.port, async ask(request) {
      if (request.context?.battery !== 'engine.compaction.evidence-dependency') final = true;
      const state = request.state as unknown as State;
      if (state.cases.some(entry => entry.evidenceSourcePositions.includes(56))) { entered(); return new Promise(() => {}); }
      return base.port.ask(request);
    } };
    installJudgmentPort(port);
    const run = readDependencyQualifiedMembership(distinctSources(), cases, () => [], new OwnedJudgmentWork({ signal: controller.signal }));
    await started; controller.abort(new Error('later sweep cancelled'));
    await expect(run).rejects.toThrow(); expect(final).toBe(false);
  });
  test('authority replacement during final membership cannot publish a result', async () => {
    const base = fakePort(key => noulAnswer(key.startsWith('dependency_') ? 0.01 : 0.99));
    installJudgmentPort({ ...base.port, async ask(request) {
      if (request.context?.battery !== 'engine.compaction.evidence-dependency') installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
      return base.port.ask(request);
    } });
    await expect(readDependencyQualifiedMembership(distinctSources(), cases, () => [], new OwnedJudgmentWork())).rejects.toThrow();
  });
});
