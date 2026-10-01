/**
 * The new-chat greeting: which part of the day an hour falls in, and the name it greets.
 */
import { describe, expect, test } from 'bun:test';
import { greeting, greetingName, greetingPhrase } from './new-chat';

describe('greetingPhrase', () => {
  test('morning from 5 to noon, afternoon to 6 pm, evening otherwise', () => {
    const morning = greetingPhrase(5);
    const afternoon = greetingPhrase(12);
    const evening = greetingPhrase(18);
    expect(new Set([morning, afternoon, evening]).size).toBe(3);
    expect(greetingPhrase(11)).toBe(morning);
    expect(greetingPhrase(17)).toBe(afternoon);
    expect(greetingPhrase(23)).toBe(evening);
    expect(greetingPhrase(2)).toBe(evening);
  });
});

describe('greetingName and greeting', () => {
  test('a display name is used as given; an email shows its local part', () => {
    expect(greetingName('Mike')).toBe('Mike');
    expect(greetingName('mike@goodvibes.local')).toBe('mike');
    const text = greeting(20, greetingName('Mike'));
    expect(text).toContain(greetingPhrase(20));
    expect(text).toContain('Mike');
  });

  test('no name greets without one', () => {
    expect(greetingName('')).toBe('');
    expect(greetingName(undefined)).toBe('');
    expect(greeting(9, '')).toBe(greetingPhrase(9));
  });
});
