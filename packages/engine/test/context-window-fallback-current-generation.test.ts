import { expect, test } from 'bun:test';
import { FALLBACK_CONTEXT_WINDOW, knownFallbackContextWindow, readFallbackContextWindow } from '../sdk/src/platform/providers/context-window-fallback.js';

test('missing endpoint limits remain estimates regardless of the apparent model family', async () => {
  for (const [provider, model] of [['anthropic', 'claude-fable-5'], ['openai', 'gpt-5.6-sol'], ['google', 'gemini-x'], ['custom', 'unknown']]) {
    expect(knownFallbackContextWindow(provider!, model!)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(await readFallbackContextWindow(provider!, model!, 'test')).toBe(FALLBACK_CONTEXT_WINDOW);
  }
});
