import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, JudgmentPort, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  forgetProviderReadings,
  knownReasoningFamily,
  readLocalServerIdentity,
  readReasoningFamily,
  readsAsAlternateApi,
} from '../../sdk/src/platform/routing/provider-readings.js';
import { authoredErrorReadingsPort, errorText } from '../_helpers/authored-error-readings.js';
import { shouldUseOtherApi } from '../../sdk/src/platform/providers/provider-error.js';
import { extractOpenAIStreamTextDelta, readStreamDeltaLabels } from '../../sdk/src/platform/providers/openai-stream-delta.js';
import { scanHosts } from '../../sdk/src/platform/discovery/scanner.js';

let previous: ReturnType<typeof installJudgmentPort>;
const originalFetch = globalThis.fetch;
const publicFailures = ['gemma3 does not support tools', 'model not found'] as const;
function alternateApiFixture(supportsTools = false) {
  const normalization = authoredErrorReadingsPort({ parts: publicFailures.map((message) => [errorText(message)]) },
    publicFailures.map((message) => ({ message, status: 400, errorName: 'Error', reading: { category: 'unknown' } })));
  const alternate = fakePort((name, _question, state) => {
    if (name !== 'unsupported') throw new Error('Unexpected alternate-API question');
    const exact = JSON.stringify(state);
    if (exact === JSON.stringify({ status: 400, error: publicFailures[0] })) return noulAnswer(supportsTools ? 0.01 : 0.99);
    if (exact === JSON.stringify({ status: 400, error: publicFailures[1] })) return noulAnswer(0.01);
    throw new Error('Unexpected alternate-API evidence');
  });
  const requests: Parameters<JudgmentPort['ask']>[0][] = [];
  const port: JudgmentPort = {
    model: normalization.port.model,
    ask(request) {
      requests.push(request);
      return ('unsupported' in request.questions ? alternate.port : normalization.port).ask(request);
    },
  };
  return { port, requests, alternateRequests: alternate.requests };
}
beforeEach(() => {
  forgetProviderReadings();
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
  forgetProviderReadings();
  globalThis.fetch = originalFetch;
});

describe('the other API', () => {
  test('a missing endpoint status and a connection errno decide without a reading', async () => {
    const { port, requests } = fakePort(() => noulAnswer(0.95));
    installJudgmentPort(port);
    expect(await shouldUseOtherApi(Object.assign(new Error('Not Found'), { status: 404 }), 'test')).toBe(true);
    expect(await shouldUseOtherApi(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'test')).toBe(false);
    expect(requests).toHaveLength(0);
  });

  test('other wording is read, once per message', async () => {
    const { port, alternateRequests } = alternateApiFixture();
    installJudgmentPort(port);
    const toolError = Object.assign(new Error('gemma3 does not support tools'), { status: 400 });
    expect(await shouldUseOtherApi(toolError, 'test')).toBe(true);
    expect(await shouldUseOtherApi(toolError, 'test')).toBe(true);
    expect(await shouldUseOtherApi(Object.assign(new Error('model not found'), { status: 400 }), 'test')).toBe(false);
    expect(alternateRequests).toHaveLength(2);
  });

  test('a new installed owner reads the same wording again', async () => {
    const first = alternateApiFixture();
    installJudgmentPort(first.port);
    expect(await readsAsAlternateApi({ status: 400, message: publicFailures[0] }, 'test')).toBe(true);
    const second = alternateApiFixture(true);
    installJudgmentPort(second.port);
    expect(await readsAsAlternateApi({ status: 400, message: publicFailures[0] }, 'test')).toBe(false);
    expect(first.alternateRequests).toHaveLength(1);
    expect(second.alternateRequests).toHaveLength(1);
  });

  for (const field of ['message', 'status', 'code', 'details'] as const) {
    test(`an accessor ${field} is refused without evaluation or a reading`, async () => {
      const fixture = alternateApiFixture();
      installJudgmentPort(fixture.port);
      let evaluations = 0;
      const error = Object.assign(new Error(publicFailures[0]), { status: 400 });
      Object.defineProperty(error, field, { get() { evaluations++; return 'borrowed'; }, configurable: true });
      await expect(shouldUseOtherApi(error, 'test')).rejects.toThrow();
      expect(evaluations).toBe(0);
      expect(fixture.requests).toHaveLength(0);
    });
  }

  for (const field of ['signal', 'assertCurrent'] as const) {
    test(`an accessor option ${field} is refused by both entry points`, async () => {
      const fixture = alternateApiFixture();
      installJudgmentPort(fixture.port);
      let evaluations = 0;
      const options = {};
      Object.defineProperty(options, field, { get() { evaluations++; return undefined; }, configurable: true });
      await expect(shouldUseOtherApi(new Error(publicFailures[0]), 'test', options)).rejects.toThrow();
      await expect(readsAsAlternateApi({ status: 400, message: publicFailures[0] }, 'test', options)).rejects.toThrow();
      expect(evaluations).toBe(0);
      expect(fixture.requests).toHaveLength(0);
    });
  }

  for (const change of ['message', 'status', 'code', 'details', 'caller'] as const) {
    test(`late ${change} mutation during normalization cannot authorize the other API`, async () => {
      const fixture = alternateApiFixture();
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const port: JudgmentPort = { model: fixture.port.model, async ask(request) {
        started.resolve();
        await release.promise;
        return fixture.port.ask(request);
      } };
      installJudgmentPort(port);
      const error = Object.assign(new Error(publicFailures[0]), { status: 400, code: 'UNRECOGNIZED', details: { note: 'original' } });
      const options = { assertCurrent: () => {} };
      const pending = shouldUseOtherApi(error, 'test', options);
      await started.promise;
      if (change === 'message') error.message = publicFailures[1];
      if (change === 'status') error.status = 404;
      if (change === 'code') error.code = 'ECONNREFUSED';
      if (change === 'details') error.details.note = 'later';
      if (change === 'caller') options.assertCurrent = () => {};
      release.resolve();
      await expect(pending).rejects.toThrow();
      expect(fixture.alternateRequests).toHaveLength(0);
    });
  }

  test('cancellation interrupts a normalization reader that ignores its signal', async () => {
    const fixture = alternateApiFixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const port: JudgmentPort = { model: fixture.port.model, async ask(request) {
      started.resolve();
      await release.promise;
      return fixture.port.ask(request);
    } };
    installJudgmentPort(port);
    const controller = new AbortController();
    const pending = shouldUseOtherApi(Object.assign(new Error(publicFailures[0]), { status: 400 }), 'test', { signal: controller.signal });
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    release.resolve();
    await Promise.resolve();
    expect(fixture.alternateRequests).toHaveLength(0);
  });

  test('a caller cannot mutate original evidence inside its currentness callback', async () => {
    const fixture = alternateApiFixture();
    installJudgmentPort(fixture.port);
    const error = Object.assign(new Error(publicFailures[0]), { status: 400 });
    await expect(shouldUseOtherApi(error, 'test', { assertCurrent: () => { error.message = publicFailures[1]; } })).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });

  test('an async caller assertion cannot authorize a reading', async () => {
    const fixture = alternateApiFixture();
    installJudgmentPort(fixture.port);
    await expect(shouldUseOtherApi(Object.assign(new Error(publicFailures[0]), { status: 400 }), 'test',
      { assertCurrent: async () => {} })).rejects.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });

  test('replacing the installed owner interrupts normalization before alternate routing', async () => {
    const fixture = alternateApiFixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    installJudgmentPort({ model: fixture.port.model, async ask(request) {
      started.resolve();
      await release.promise;
      return fixture.port.ask(request);
    } });
    const pending = shouldUseOtherApi(Object.assign(new Error(publicFailures[0]), { status: 400 }), 'test');
    await started.promise;
    const replacement = alternateApiFixture(true);
    installJudgmentPort(replacement.port);
    await expect(pending).rejects.toThrow();
    release.resolve();
    expect(fixture.alternateRequests).toHaveLength(0);
    expect(replacement.requests).toHaveLength(0);
  });

  test('mutating source evidence during an alternate reading prevents retention and action', async () => {
    const fixture = alternateApiFixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const effects: string[] = [];
    installJudgmentPort({ model: fixture.port.model, recorder: {
      recordReadings: () => { effects.push('readings'); },
      recordAction: (_id, action) => { effects.push(action); },
    }, async ask(request) {
      started.resolve();
      await release.promise;
      return { ...await fixture.port.ask(request), decisionId: 'alternate-source' };
    } });
    const error = { status: 400, message: publicFailures[0] };
    const pending = readsAsAlternateApi(error, 'test');
    await started.promise;
    error.status = 404;
    release.resolve();
    await expect(pending).rejects.toThrow();
    expect(effects).toEqual([]);
  });

  test('cancelling a pending memo waiter preserves its independent producer', async () => {
    const fixture = alternateApiFixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    installJudgmentPort({ model: fixture.port.model, async ask(request) {
      started.resolve();
      await release.promise;
      return fixture.port.ask(request);
    } });
    const evidence = { status: 400, message: publicFailures[0] };
    const first = readsAsAlternateApi(evidence, 'test');
    await started.promise;
    const controller = new AbortController();
    const second = readsAsAlternateApi(evidence, 'test', { signal: controller.signal });
    controller.abort();
    try {
      const stopped = await Promise.race([second.then(() => false, () => true), Bun.sleep(100).then(() => false)]);
      expect(stopped).toBe(true);
    } finally { release.resolve(); }
    expect(await first).toBe(true);
    await expect(second).rejects.toThrow();
    expect(fixture.alternateRequests).toHaveLength(1);
  });

  test('a protected card cannot release alternate-API wording', async () => {
    const fixture = alternateApiFixture();
    installJudgmentPort(fixture.port);
    const privateLine = 'Card 4242 4242 4242 4242 exp 12/30 cvc 123';
    expect(await shouldUseOtherApi(Object.assign(new Error(privateLine), { status: 400 }), 'test')).toBe(false);
    expect(JSON.stringify(fixture.requests)).not.toContain('4242');
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.alternateRequests).toHaveLength(0);
  });
});

describe('local server identity', () => {
  test('a weak reading is unknown', async () => {
    installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'vllm', 0.3)).port);
    expect(await readLocalServerIdentity({ port: 8000, headers: {}, modelIds: ['m'] }, 'test')).toBe('unknown');
  });

  test('a scan reads the server behind a non-default port from its headers', async () => {
    installJudgmentPort(fakePort((_name, question, state: EntryType) =>
      choiceAnswer(question, JSON.stringify(state).includes('x-vllm') ? 'vllm' : 'unknown', 0.95)).port);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'http://127.0.0.1:8000/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'meta-llama/Llama-3.1-8B-Instruct' }] }), { status: 200, headers: { 'x-vllm-version': '0.6.3' } });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
    const servers = await scanHosts(['127.0.0.1']);
    expect(servers.find((server) => server.port === 8000)?.serverType).toBe('vllm');
  });
});

describe('stream content-part labels', () => {
  const chunk = (type: string) => ({ choices: [{ delta: { content: [{ type, text: 'thinking out loud' }, { type: 'output_text', text: 'the answer' }] } }] });

  test('documented labels split without a reading; an unfamiliar one is read once and then routes its text', async () => {
    const { port, requests } = fakePort(() => noulAnswer(0.95));
    installJudgmentPort(port);
    await readStreamDeltaLabels(chunk('reasoning'), 'test');
    expect(requests).toHaveLength(0);
    await readStreamDeltaLabels(chunk('thought'), 'test');
    await readStreamDeltaLabels(chunk('thought'), 'test');
    expect(requests).toHaveLength(1);
    const split = extractOpenAIStreamTextDelta(chunk('thought'));
    expect(split.reasoning).toEqual(['thinking out loud']);
    expect(split.content).toEqual(['the answer']);
  });

  test('an unread label is never guessed', () => {
    expect(() => extractOpenAIStreamTextDelta(chunk('unheard_of'))).toThrow('has not been read');
  });
});

describe('reasoning family', () => {
  test('a reading below the act band leaves the model in no family, remembered', async () => {
    const { port, requests } = fakePort((_name: string, question: Question) => choiceAnswer(question, 'deepseek', 0.6));
    installJudgmentPort(port);
    expect(await readReasoningFamily('mystery-reasoner', 'test')).toBeNull();
    expect(knownReasoningFamily('mystery-reasoner')).toBeNull();
    expect(await readReasoningFamily('mystery-reasoner', 'test')).toBeNull();
    expect(requests).toHaveLength(1);
  });
});
