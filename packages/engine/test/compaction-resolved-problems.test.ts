import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { createSystemOnePort, actionOf, readingsOf, SqliteDecisionLog, withDecisionLog, JudgmentError, type Question, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { compactMessages, getCompactionEvents } from '../sdk/src/platform/core/context-compaction.js';
import { compactConversation } from '../sdk/src/platform/core/conversation-compaction.js';
import { ConversationManager } from '../sdk/src/platform/core/conversation.js';
import type { CompactionContext } from '../sdk/src/platform/core/compaction-types.js';
import type { ProviderRegistry } from '../sdk/src/platform/providers/registry.js';
import { composeJudgment } from '../sdk/src/platform/runtime/judgment-services.js';
import { createAsyncDisposalScope } from '../sdk/src/platform/runtime/disposal.js';
import { decisionLogPath } from '../sdk/src/platform/state/decision-log.js';
import { resolvedProblems } from '../sdk/src/platform/runtime/compaction/batteries/resolved-problems.js';
import { registry as decisions } from '../sdk/src/platform/runtime/judgment-registry.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';

// Integration tests run the existing summary generator and compactor. Only the
// canonical judgment port is synthetic; these are not live calibration proofs.
const RESOLVED = 'engine.compaction.resolved-problems';
function registry(reply: string): ProviderRegistry {
  return {
    getForModel: () => ({ chat: async (request: { messages: { content: string }[] }) => ({
      content: request.messages[0]!.content.startsWith('Extract problem → resolution pairs')
        ? reply : 'Task: repair the exporter. The exporter fix passed; scheduler work remains.',
    }) }),
    listModels: () => [{ provider: 'test', id: 'model', registryKey: 'test/model' }],
  } as unknown as ProviderRegistry;
}
function context(extra: Partial<CompactionContext> = {}): CompactionContext {
  return {
    messages: [{ role: 'user', content: 'Fix the exporter. '.repeat(2_000) }],
    sessionMemories: [], agents: [], contracts: [], activePlan: null, lineageEntries: [],
    compactionCount: 0, contextWindow: 100_000, trigger: 'manual', extractionModelId: 'test/model', ...extra,
  };
}
function port(answer: unknown = noulAnswer(0.95)) {
  return fakePort((name, question) => {
    if (name === 'resolved') return answer;
    if (name === 'substance') return scoreAnswer(question, 3, 0.95);
    if (name === 'relation') return choiceAnswer(question, 'supports', 0.95);
    throw new Error(`Unexpected question: ${name}`);
  });
}
function manager() {
  const cm = new ConversationManager();
  cm.addUserMessage('Fix the exporter.');
  cm.addAssistantMessage('Investigation notes. '.repeat(2_000));
  cm.addUserMessage('Finish the exporter and investigate the scheduler.');
  cm.addAssistantMessage('Exporter fixed. Scheduler is still broken.');
  const lineage: string[] = [];
  cm.setSessionLineageTracker({ addCompactionEntry: (entry) => { lineage.push(entry); } });
  return { cm, lineage };
}
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('structured compaction resolved-problems reply', () => {
  for (const reply of ['Nothing has been fixed yet; investigation is ongoing.', 'empty', 'No resolved problems.']) {
    test(`omits only a settled no reading: ${reply}`, async () => {
      const fake = port(noulAnswer(0.05)); installJudgmentPort(fake.port);
      const result = await compactMessages(context(), registry(reply));
      expect(result.sections.some((section) => section.id === 'resolved-problems')).toBe(false);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]?.context?.battery).toBe(RESOLVED);
      expect(fake.requests[0]?.state).toEqual({ reply });
    });
  }
  for (const reply of [
    'The dashboard incorrectly displayed "no resolved problems" → fixed the stale query and tests pass.',
    'Exporter lost the last row → fixed and verified. Scheduler remains unresolved.',
    '  Exporter bug → fixed.\n\n  ',
  ]) {
    test(`keeps a settled yes byte-for-byte: ${reply}`, async () => {
      const fake = port(); installJudgmentPort(fake.port);
      const result = await compactMessages(context(), registry(reply));
      expect(result.sections.find((section) => section.id === 'resolved-problems')?.content).toBe(reply);
      expect(fake.requests[0]?.state).toEqual({ reply });
    });
  }
  for (const probability of [0.5, 0.65, 0.35]) {
    test(`uncertain or confirmation-range ${probability} retains the conversation`, async () => {
      installJudgmentPort(port(noulAnswer(probability)).port);
      const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
      const events = getCompactionEvents().length;
      await expect(cm.compact(registry('Perhaps the exporter is fixed.'), 'test/model')).rejects.toThrow();
      expect(cm.getMessageSnapshot()).toEqual(before);
      expect(lineage).toEqual([]);
      expect(getCompactionEvents()).toHaveLength(events);
    });
  }
  for (const answer of [undefined, null, {}, { type: 'choice', noul: 0.95 }, noulAnswer(Number.NaN), noulAnswer(2), noulAnswer(-1)]) {
    test(`malformed ${JSON.stringify(answer)} is a failure, never none`, async () => {
      const fake = fakePort(() => answer); installJudgmentPort(fake.port);
      await expect(compactMessages(context(), registry('The exporter is fixed.'))).rejects.toThrow();
      expect(fake.requests).toHaveLength(1);
    });
  }
  test('unconfigured judgment retains the original conversation', async () => {
    const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
    await expect(cm.compact(registry('No fixes were completed.'), 'test/model')).rejects.toBeInstanceOf(JudgmentPortMissingError);
    expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
  });
  test('unavailable judgment is not a negative reading', async () => {
    const failure = new JudgmentError('unavailable', 'synthetic outage');
    installJudgmentPort({ model: 'jev-1.13.0', ask: async () => { throw failure; } });
    const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
    await expect(cm.compact(registry('No fixes were completed.'), 'test/model')).rejects.toBe(failure);
    expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
  });
  test('complete evidence reaches the port without clipping', async () => {
    const reply = 'Context. '.repeat(5_000) + 'At the end: exporter fixed and verified.';
    const fake = port(); installJudgmentPort(fake.port);
    const result = await compactMessages(context(), registry(reply));
    expect(fake.requests[0]?.state).toEqual({ reply });
    expect(result.sections.find((section) => section.id === 'resolved-problems')?.content).toBe(reply);
  });
  for (const material of ['Authorization: Bearer synthetic-compaction-token', 'cardNumber: 4111111111111111', '{"access_token":"synthetic-compaction-token"}']) {
    test(`complete protected evidence blocks ${material.split(':')[0]} before request`, async () => {
      const fake = port(); installJudgmentPort(fake.port);
      await expect(compactMessages(context(), registry('Context. '.repeat(12_000) + '\n' + material))).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    });
  }
  test('oversized safe evidence fails explicitly instead of clipping it', async () => {
    const fake = port(); installJudgmentPort(fake.port);
    await expect(compactMessages(context(), registry('Context. '.repeat(20_000)))).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
  test('pre-cancelled compaction sends no judgment and retains conversation', async () => {
    const controller = new AbortController(); controller.abort();
    const fake = port(); installJudgmentPort(fake.port);
    const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
    await expect(cm.compact(registry('Fixed exporter.'), 'test/model', 'manual', undefined,
      { ...context({ messages: cm.getMessagesForLLM() }), signal: controller.signal } as CompactionContext)).rejects.toThrow();
    expect(fake.requests).toHaveLength(0); expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
  });
  for (const change of ['append', 'replace', 'change-and-restore'] as const) {
    test(`does not replace a changed conversation while reading is pending: ${change}`, async () => {
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const base = port();
      const delayed: JudgmentPort = { ...base.port, async ask(request) {
        if (request.context?.battery === RESOLVED) { entered.resolve(); await release.promise; }
        return base.port.ask(request);
      } };
      installJudgmentPort(delayed);
      const { cm, lineage } = manager();
      const original = structuredClone(cm.getMessagesForLLM());
      const pending = cm.compact(registry('The exporter is fixed.'), 'test/model');
      // Old source never asks this reading, so race against completion for a
      // useful baseline-red failure instead of waiting for the test timeout.
      await Promise.race([entered.promise, pending]);
      expect(base.requests).toHaveLength(0);
      if (change === 'append') cm.addUserMessage('New work arrived.');
      else cm.replaceMessagesForLLM([{ role: 'user', content: 'Replacement conversation' }]);
      if (change === 'change-and-restore') cm.replaceMessagesForLLM(original);
      const changed = cm.getMessageSnapshot();
      release.resolve(); await expect(pending).rejects.toThrow();
      expect(cm.getMessageSnapshot()).toEqual(changed); expect(lineage).toEqual([]);
    });
  }
  test('cancellation while reading is pending reaches the existing port and prevents commit', async () => {
    const controller = new AbortController(); const entered = Promise.withResolvers<JudgmentRequest<Questions>>();
    const release = Promise.withResolvers<void>(); const base = port();
    installJudgmentPort({ ...base.port, async ask(request) {
      if (request.context?.battery === RESOLVED) { entered.resolve(request); await release.promise; }
      return base.port.ask(request);
    } });
    const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
    const pending = cm.compact(registry('The exporter is fixed.'), 'test/model', 'manual', undefined,
      { ...context({ messages: cm.getMessagesForLLM() }), signal: controller.signal } as CompactionContext);
    const request = await Promise.race([entered.promise, pending.then(() => undefined)]);
    expect(request?.signal).toBe(controller.signal);
    controller.abort(); release.resolve(); await expect(pending).rejects.toThrow();
    expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
  });
  for (const reply of [
    '{"access_token":"synthetic-hidden","access_token":""}',
    '{"\\u0061ccess_token":"synthetic-hidden","access_token":""}',
    JSON.stringify({ payload: JSON.stringify({ access_token: 'synthetic-hidden' }) }),
    JSON.stringify(JSON.stringify({ access_token: 'synthetic-hidden' })),
    'The result was: {"\\u0061ccess_token":"synthetic-hidden","access_token":""}',
  ]) {
    test(`raw/escaped/nested credential text is protected: ${reply}`, async () => {
      const fake = port(); installJudgmentPort(fake.port);
      await expect(compactMessages(context(), registry(reply))).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    });
  }
  for (const stage of ['generation', 'reply', 'quality'] as const) {
    test(`manual compaction cannot borrow a replaced port during ${stage}`, async () => {
      const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
      const old = port(); const replacement = port(noulAnswer(0.05));
      installJudgmentPort({ ...old.port, async ask(request) {
        if ((stage === 'reply' && request.context?.battery === RESOLVED)
          || (stage === 'quality' && request.context?.battery === 'engine.compaction.retention')) {
          entered.resolve(); await release.promise;
        }
        return old.port.ask(request);
      } });
      const source = registry('Exporter fixed.');
      const actual = stage !== 'generation' ? source : {
        ...source, getForModel: () => ({ chat: async () => {
          entered.resolve(); await release.promise; return { content: 'Exporter fixed.' };
        } }),
      } as unknown as ProviderRegistry;
      const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
      const pending = cm.compact(actual, 'test/model');
      await entered.promise; installJudgmentPort(replacement.port); release.resolve();
      await expect(pending).rejects.toThrow();
      expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
      expect(replacement.requests).toHaveLength(0);
    });
  }
  for (const reply of [
    'A quoted filename "empty.json" was fixed.',
    '{"resolved":"Exporter fixed","note":"Scheduler remains open"}',
    '{"access_token":""}',
    '{"access_token":"goodvibes://secrets/example"}',
    'Example {"type":"text","value":"hello"}',
    'Template {"type":"password","value":"goodvibes://secrets/example"}',
    'Schema {"method":"credentials.set","key":"example","value":{"type":"string","description":"Stored reference"}}',
    'Fixed literal braces { and } and bracket tokens [x].',
    'The fix used a quote \" and then ' + JSON.stringify({ payload: JSON.stringify({ note: 'done' }) }),
  ]) {
    test(`safe raw/quoted text is unchanged: ${reply}`, async () => {
      const fake = port(); installJudgmentPort(fake.port);
      const result = await compactMessages(context(), registry(reply));
      expect(fake.requests[0]?.state).toEqual({ reply });
      expect(result.sections.find((section) => section.id === 'resolved-problems')?.content).toBe(reply);
    });
  }
  test('unconfigured generation cannot borrow a newly installed owner', async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const source = registry('Exporter fixed.');
    const blocked = { ...source, getForModel: () => ({ chat: async () => {
      entered.resolve(); await release.promise; return { content: 'Exporter fixed.' };
    } }) } as unknown as ProviderRegistry;
    const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
    const pending = cm.compact(blocked, 'test/model');
    await entered.promise; const replacement = port(); installJudgmentPort(replacement.port); release.resolve();
    await expect(pending).rejects.toThrow();
    expect(replacement.requests).toHaveLength(0); expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
  });
  test('same-port model changes invalidate an in-flight manual compaction', async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const base = port(); let model = 'jev-1.13.0';
    installJudgmentPort({ ...base.port, get model() { return model; }, async ask(request) {
      entered.resolve(); await release.promise; return base.port.ask(request);
    } });
    const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
    const pending = cm.compact(registry('Exporter fixed.'), 'test/model');
    await entered.promise; model = 'changed-model'; release.resolve();
    await expect(pending).rejects.toThrow(); expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
  });
  test('generic compactConversation rejects changed evidence even when the host returns fresh arrays', async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const base = port();
    installJudgmentPort({ ...base.port, async ask(request) {
      if (request.context?.battery === RESOLVED) { entered.resolve(); await release.promise; }
      return base.port.ask(request);
    } });
    const { cm } = manager(); let messages = cm.getMessagesForLLM(); let replaced = false;
    const host = {
      getMessageCount: () => messages.length, getMessagesForLLM: () => structuredClone(messages),
      replaceMessagesForLLM: () => { replaced = true; }, getSessionMemoryStore: () => null,
      getSessionLineageTracker: () => ({ addCompactionEntry: () => { throw new Error('Unexpected lineage write'); } }),
    };
    const pending = compactConversation(host, registry('Exporter fixed.'), 'test/model');
    await entered.promise; messages = [...messages, { role: 'user', content: 'New task.' }]; release.resolve();
    await expect(pending).rejects.toThrow(); expect(replaced).toBe(false);
  });
  test('stale supplied context is rejected before generation or judgment', async () => {
    const fake = port(); installJudgmentPort(fake.port); const { cm, lineage } = manager();
    const before = cm.getMessageSnapshot();
    await expect(cm.compact(registry('Exporter fixed.'), 'test/model', 'manual', undefined, context())).rejects.toThrow('stale');
    expect(fake.requests).toHaveLength(0); expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
  });
  for (const reply of [
    ...[0, 1, 2].flatMap((depth) => {
      let leaf = '{"access_token":"synthetic-hidden","access_token":""}';
      for (let count = 0; count < depth; count++) leaf = JSON.stringify(leaf);
      return [
        'The fix used a quote " and then ' + JSON.stringify({ payload: leaf }),
        'The fix used a quote " and then ' + JSON.stringify(leaf),
      ];
    }),
    'The fix used {"type":"password","value":"synthetic-hidden"}',
    'The fix used {"ty\\u0070e":"password","value":"synthetic-hidden"}',
    'Controls [{"control":{"type":"password","value":"synthetic-hidden"}}]',
    'The fix used {"method":"credentials.\\u0073et","key":"example","value":"synthetic-hidden"}',
    '{"method":"credentials.set","key":"example","value":"synthetic-hidden","value":""}',
    '{"key":"access_token","value":"synthetic-hidden","value":""}',
    '{"card":{"number":"synthetic-hidden","number":""}}',
    'The fix used {"selector":"input[type=password]","text":"synthetic-hidden"}',
    'We updated {"method":"payments.cards.create","number":"synthetic-hidden"}',
    JSON.stringify({ note: 'The fix used {"type":"password","value":"synthetic-hidden"}' }),
  ]) {
    test(`structured controls stay protected in the direct reader: ${reply}`, async () => {
      const fake = port();
      await expect(resolvedProblems.read(fake.port, reply)).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0);
    });
    test(`structured controls stay protected through actual manual compaction: ${reply}`, async () => {
      const fake = port(); installJudgmentPort(fake.port); const { cm, lineage } = manager();
      const before = cm.getMessageSnapshot();
      await expect(cm.compact(registry(reply), 'test/model')).rejects.toBeInstanceOf(JudgmentInputError);
      expect(fake.requests).toHaveLength(0); expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
    });
  }
  test('duplicate JSON members are explicitly refused rather than silently discarded', async () => {
    const fake = port(); installJudgmentPort(fake.port);
    await expect(compactMessages(context(), registry('{"note":"first","note":"second"}'))).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('the last resolved-problems section stays verbatim in summary and messages', async () => {
    const fake = port(); installJudgmentPort(fake.port);
    const reply = '  Exporter fixed.\n\n  ';
    const result = await compactMessages(context({ compactionCount: 1 }), registry(reply));
    expect(result.sections.at(-1)?.id).toBe('resolved-problems');
    expect(result.sections.at(-1)?.content).toBe(reply);
    expect(result.summary.endsWith(reply)).toBe(true);
    expect(result.messages[0]?.content).toBe(result.summary);
  });
  test('actual ConversationManager.compact applies settled work and reinjects standing instructions once', async () => {
    const fake = port(); installJudgmentPort(fake.port);
    const { cm, lineage } = manager();
    const receipt = await cm.compact(registry('Exporter → fixed. Scheduler remains unresolved.'), 'test/model', 'manual', undefined,
      context({ messages: cm.getMessagesForLLM(), instructionChain: 'STANDING_RULE', activeSkillFrontmatter: 'name: verify' }));
    expect(receipt?.outcome).toBe('applied'); expect(receipt?.sectionsIncluded).toContain('resolved-problems');
    expect(receipt?.instructionsReinjected).toBe(true);
    const text = cm.getMessagesForLLM()[0]?.content as string;
    expect(text.split('STANDING_RULE')).toHaveLength(2); expect(text).toContain('name: verify');
    expect(lineage).toHaveLength(1);
    expect(fake.requests.map((request) => request.context?.battery)).toEqual([
      RESOLVED, 'engine.compaction.retention', 'engine.compaction.fidelity',
    ]);
  });
});


describe('resolved-problems canonical shared ownership', () => {
  test('registered decision exposes labeled yes/no fixtures', () => {
    const decision = decisions.get(RESOLVED);
    expect(decision).toBeDefined(); expect(decision?.fixtureCount).toBe(8);
  });

  test('shared transport retries the same protected reply and records its full reading/action once', async () => {
    using log = new SqliteDecisionLog(':memory:');
    const states: unknown[] = []; let attempts = 0;
    const transport = createSystemOnePort({
      endpoint: { kind: 'hosted', baseURL: 'https://synthetic-compaction.test', apiKey: 'synthetic-key' },
      model: 'jev-1.13.0', timeoutMs: 1000, retry: { backoffInitialMs: 1, backoffMaxMs: 1 },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string; state: unknown; questions: Record<string, Question> };
        states.push(body.state);
        if (attempts++ < 2) return new Response('', { status: 503 });
        return Response.json({ model: body.model, answers: { resolved: noulAnswer(0.95) }, usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    installJudgmentPort(withDecisionLog(transport, log));
    const reply = 'The dashboard said "no resolved problems" → the stale query is now fixed.';
    const result = await compactMessages(context(), registry(reply));
    expect(result.sections.find((section) => section.id === 'resolved-problems')?.content).toBe(reply);
    expect(states).toEqual([{ reply }, { reply }, { reply }]);
    const entries = log.query(); expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'answered', context: { battery: RESOLVED, pattern: 'reply' } });
    expect(entries[0]?.lineage?.attempts).toHaveLength(3);
    expect(readingsOf(entries[0]!)).toEqual({ resolved: { kind: 'yes-no', probability: 0.95, verdict: 'yes', outcome: 'act' } });
    expect(actionOf(entries[0]!)).toBe('include the complete resolved-problems reply unchanged');
  });

  test('the captured binding guards both quality readings and their shared retries', async () => {
    let replaced = false; let retentionAttempts = 0;
    const calls: { question: string; afterReplacement: boolean }[] = [];
    const guards: { battery: string | undefined; guarded: boolean }[] = [];
    const replacement = port();
    const transport = createSystemOnePort({
      endpoint: { kind: 'hosted', baseURL: 'https://synthetic-compaction.test', apiKey: 'synthetic-key' },
      model: 'jev-1.13.0', timeoutMs: 1000, retry: { backoffInitialMs: 1, backoffMaxMs: 1 },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string; questions: Record<string, Question> };
        const question = Object.keys(body.questions)[0]!; calls.push({ question, afterReplacement: replaced });
        if (question === 'substance' && retentionAttempts++ === 0) {
          replaced = true; installJudgmentPort(replacement.port); return new Response('', { status: 503 });
        }
        const answers = Object.fromEntries(Object.entries(body.questions).map(([name, question]) => [name,
          name === 'resolved' ? noulAnswer(0.95) : name === 'substance' ? scoreAnswer(question, 3, 0.95) : choiceAnswer(question, 'supports', 0.95)]));
        return Response.json({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    installJudgmentPort({ ...transport, async ask(request) {
      guards.push({ battery: request.context?.battery, guarded: typeof request.beforeAttempt === 'function' });
      return transport.ask(request);
    } });
    const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
    await expect(cm.compact(registry('Exporter fixed.'), 'test/model')).rejects.toMatchObject({ kind: 'aborted' });
    expect(guards).toEqual([
      { battery: RESOLVED, guarded: true }, { battery: 'engine.compaction.retention', guarded: true },
      { battery: 'engine.compaction.fidelity', guarded: true },
    ]);
    expect(calls.filter((call) => call.afterReplacement)).toEqual([]);
    expect(calls.filter((call) => call.question === 'substance')).toHaveLength(1);
    expect(replacement.requests).toHaveLength(0); expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
  });
  for (const stop of ['runtime disposal', 'caller cancellation'] as const) {
    test(`${stop} during the real composition's key acquisition keeps the manual conversation`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'compaction-owned-reading-'));
      const scope = createAsyncDisposalScope('compaction test');
      const entered = Promise.withResolvers<void>(); const caller = new AbortController();
      const { decisionLog } = composeJudgment({
        stateRoot: root, disposal: scope.registry,
        config: { get: (key) => ({ 'judgment.endpoint': 'http://127.0.0.1:1', 'judgment.model': 'jev-1.13.0',
          'judgment.timeoutMs': 1000, 'judgment.keySource': 'secret' })[key] }, env: {},
        secrets: { get: async () => { entered.resolve(); return await new Promise<string>(() => {}); } },
      });
      const { cm, lineage } = manager(); const before = cm.getMessageSnapshot();
      try {
        const pending = cm.compact(registry('Exporter fixed.'), 'test/model', 'manual', undefined,
          context({ messages: cm.getMessagesForLLM(), signal: caller.signal })).catch((error: unknown) => error);
        await entered.promise;
        if (stop === 'runtime disposal') scope.dispose(); else caller.abort();
        expect(await pending).toMatchObject({ kind: 'aborted' });
        expect(cm.getMessageSnapshot()).toEqual(before); expect(lineage).toEqual([]);
        if (stop === 'caller cancellation') expect(decisionLog.query()).toHaveLength(1);
        await scope.close();
        using persisted = new SqliteDecisionLog(decisionLogPath(root));
        expect(persisted.query()).toMatchObject([{ status: 'failed', context: { battery: RESOLVED }, error: { kind: 'aborted' } }]);
      } finally { await scope.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
});
