/**
 * The window of a model the catalog, OpenRouter and the provider leave
 * unsized: routing.context-window-family reads which documented row the model
 * belongs to, and code maps the row to its documented size. Until the row is
 * read, and when the reading does not settle, the window is the conservative
 * FALLBACK_CONTEXT_WINDOW.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  FALLBACK_CONTEXT_WINDOW,
  knownFallbackContextWindow,
  readFallbackContextWindow,
} from '../sdk/src/platform/providers/context-window-fallback.js';
import { forgetModelLimitReadings } from '../sdk/src/platform/routing/model-limit-readings.js';

/** A port that reads each model id into the family `familyOf` names, at `confidence`. */
function familyPort(familyOf: (state: EntryType) => string, confidence = 0.95) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name !== 'route') throw new Error(`context window port: unexpected question ${name}`);
    return choiceAnswer(question, familyOf(state), confidence);
  });
}

function withPort(port: ReturnType<typeof familyPort>['port']): void {
  forgetModelLimitReadings();
  const previous = installJudgmentPort(port);
  afterEachRestore = () => installJudgmentPort(previous);
}

let afterEachRestore: () => void = () => {};
afterEach(() => {
  afterEachRestore();
  afterEachRestore = () => {};
  forgetModelLimitReadings();
});

describe('context window of an unsized model', () => {
  test('each read family maps to its documented window', async () => {
    const families: Record<string, string> = {
      'claude-fable-5': 'claude',
      'gpt-5.6-sol': 'gpt-5-or-4-1',
      'gemini-3.5-flash': 'gemini',
      'x-ai/grok-4-fast': 'grok-4',
      'o3-2025-04-16': 'openai-o-series',
    };
    withPort(familyPort((state) => families[String((state as { model_id?: unknown }).model_id)]!).port);
    expect(await readFallbackContextWindow('anthropic', 'claude-fable-5', 'test')).toBe(200_000);
    expect(await readFallbackContextWindow('openai', 'gpt-5.6-sol', 'test')).toBe(400_000);
    expect(await readFallbackContextWindow('gemini', 'gemini-3.5-flash', 'test')).toBe(1_000_000);
    expect(await readFallbackContextWindow('openrouter', 'x-ai/grok-4-fast', 'test')).toBe(256_000);
    expect(await readFallbackContextWindow('openai', 'o3-2025-04-16', 'test')).toBe(200_000);
  });

  test('the reading sees the provider and the model id, and is asked once per pair', async () => {
    const { port, requests } = familyPort(() => 'claude');
    withPort(port);
    await readFallbackContextWindow('amazon-bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'test');
    await readFallbackContextWindow('amazon-bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'test');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toEqual({ provider: 'amazon-bedrock', model_id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' });
    expect(knownFallbackContextWindow('amazon-bedrock', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
  });

  test('a model with no documented family gets the conservative window', async () => {
    withPort(familyPort(() => 'none').port);
    expect(await readFallbackContextWindow('google', 'gemma-3-27b-it', 'test')).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  test('a reading too weak to act on gets the conservative window, not the family it leans to', async () => {
    withPort(familyPort(() => 'gemini', 0.5).port);
    expect(await readFallbackContextWindow('google', 'gemini-x', 'test')).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(knownFallbackContextWindow('google', 'gemini-x')).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  test('before the model has been read, the synchronous lookup gives the conservative window without asking', () => {
    const { port, requests } = familyPort(() => 'gemini');
    withPort(port);
    expect(knownFallbackContextWindow('gemini', 'gemini-3-pro')).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(requests).toHaveLength(0);
  });
});
