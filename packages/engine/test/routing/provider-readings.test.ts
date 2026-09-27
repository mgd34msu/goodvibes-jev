import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  forgetProviderReadings,
  knownReasoningFamily,
  readLocalServerIdentity,
  readReasoningFamily,
} from '../../sdk/src/platform/routing/provider-readings.js';
import { shouldUseOtherApi } from '../../sdk/src/platform/providers/provider-error.js';
import { extractOpenAIStreamTextDelta, readStreamDeltaLabels } from '../../sdk/src/platform/providers/openai-stream-delta.js';
import { scanHosts } from '../../sdk/src/platform/discovery/scanner.js';

let previous: ReturnType<typeof installJudgmentPort>;
const originalFetch = globalThis.fetch;
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
    const { port, requests } = fakePort((_name, _question, state) => noulAnswer(JSON.stringify(state).includes('does not support tools') ? 0.95 : 0.05));
    installJudgmentPort(port);
    const toolError = Object.assign(new Error('gemma3 does not support tools'), { status: 400 });
    expect(await shouldUseOtherApi(toolError, 'test')).toBe(true);
    expect(await shouldUseOtherApi(toolError, 'test')).toBe(true);
    expect(await shouldUseOtherApi(Object.assign(new Error('model not found'), { status: 400 }), 'test')).toBe(false);
    expect(requests).toHaveLength(2);
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
