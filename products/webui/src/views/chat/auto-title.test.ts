/**
 * Unit tests for the client-side auto-title derivation (deriveChatTitle).
 *
 * There is deliberately no server auto-title verb; the web UI derives a concise title
 * from the first user message and feeds companion.chat.sessions.update. The derivation
 * must be honest and stable: a clean short line passes through, a long line is clipped on
 * a word boundary with an ellipsis, and an empty/whitespace message yields '' so the
 * caller leaves the existing title untouched rather than writing a blank one.
 */
import { describe, expect, test } from 'bun:test';
import { deriveChatTitle } from './message-utils';

describe('deriveChatTitle', () => {
  test('passes a short single line through, trimming trailing punctuation', () => {
    expect(deriveChatTitle('Fix the login bug')).toBe('Fix the login bug');
    expect(deriveChatTitle('What is a monad?')).toBe('What is a monad');
  });

  test('uses the first non-empty line and collapses inner whitespace', () => {
    expect(deriveChatTitle('\n\n  Deploy   the   worker  \nmore text')).toBe('Deploy the worker');
  });

  test('clips a long message on a word boundary and adds an ellipsis', () => {
    const long = 'Please refactor the entire authentication subsystem to support rotating operator tokens';
    const title = deriveChatTitle(long, 40);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title).not.toContain('  ');
  });

  test('returns empty string for an empty or whitespace-only message', () => {
    expect(deriveChatTitle('')).toBe('');
    expect(deriveChatTitle('   \n  ')).toBe('');
  });
});
