import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { normaliseCombo, eventToCombo, useHotkeys } from './useHotkeys';
import type { HotkeyBinding } from './useHotkeys';

// In the test environment, navigator is undefined, so isMac() returns false.
// Therefore "mod" normalises to "Control".

describe('normaliseCombo', () => {
  test('normalises single letter to lowercase', () => {
    expect(normaliseCombo('K')).toBe('k');
  });

  test('normalises mod+k to Control+k (non-Mac env)', () => {
    // In test env: no navigator -> isMac() = false -> mod = Control
    expect(normaliseCombo('mod+k')).toBe('Control+k');
  });

  test('normalises ctrl alias to Control', () => {
    expect(normaliseCombo('ctrl+k')).toBe('Control+k');
  });

  test('normalises cmd alias to Meta', () => {
    expect(normaliseCombo('cmd+k')).toBe('Meta+k');
  });

  test('normalises meta alias to Meta', () => {
    expect(normaliseCombo('meta+k')).toBe('Meta+k');
  });

  test('normalises alt token to Alt', () => {
    expect(normaliseCombo('alt+f')).toBe('Alt+f');
  });

  test('normalises shift token to Shift', () => {
    expect(normaliseCombo('shift+Enter')).toBe('Shift+Enter');
  });

  test('normalises mod+shift+n correctly', () => {
    expect(normaliseCombo('mod+shift+n')).toBe('Control+Shift+n');
  });

  test('normalises two-key sequence "g c"', () => {
    expect(normaliseCombo('g c')).toBe('g c');
  });

  test('normalises two-key sequence with uppercase "G C"', () => {
    expect(normaliseCombo('G C')).toBe('g c');
  });

  test('normalises two-key sequence with modified first key "Ctrl+x y"', () => {
    expect(normaliseCombo('Ctrl+x y')).toBe('Control+x y');
  });

  test('normalises named key Escape', () => {
    expect(normaliseCombo('Escape')).toBe('Escape');
  });

  test('normalises named key Enter', () => {
    expect(normaliseCombo('Enter')).toBe('Enter');
  });

  test('handles extra whitespace in sequence', () => {
    expect(normaliseCombo('  g   c  ')).toBe('g c');
  });

  test('question mark passthrough: single printable', () => {
    // "?" is a single char, normalises to "?"
    expect(normaliseCombo('?')).toBe('?');
  });
});

describe('eventToCombo', () => {
  /** Minimal KeyboardEvent-like stub */
  function mkEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: 'a',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides,
    } as KeyboardEvent;
  }

  test('plain letter produces lowercase key', () => {
    expect(eventToCombo(mkEvent({ key: 'k' }))).toBe('k');
  });

  test('Ctrl+k produces Control+k', () => {
    expect(eventToCombo(mkEvent({ key: 'k', ctrlKey: true }))).toBe('Control+k');
  });

  test('Meta+k produces Meta+k', () => {
    expect(eventToCombo(mkEvent({ key: 'k', metaKey: true }))).toBe('Meta+k');
  });

  test('Ctrl+Shift+N produces Control+Shift+n (Shift kept when Ctrl also held)', () => {
    // key="N" length 1, but Ctrl is also held, so Shift is NOT suppressed.
    // This is the regression: previously produced "Control+n" (Shift incorrectly dropped).
    expect(eventToCombo(mkEvent({ key: 'N', ctrlKey: true, shiftKey: true }))).toBe('Control+Shift+n');
  });

  test('Shift+? (bare shifted printable, no other modifier) does NOT include Shift prefix', () => {
    // "?" is a single printable char (length 1), no Ctrl/Meta/Alt, Shift is suppressed
    expect(eventToCombo(mkEvent({ key: '?', shiftKey: true }))).toBe('?');
  });

  test('Shift+ArrowUp includes Shift (named key)', () => {
    expect(eventToCombo(mkEvent({ key: 'ArrowUp', shiftKey: true }))).toBe('Shift+ArrowUp');
  });

  test('Shift+Enter includes Shift (named key)', () => {
    expect(eventToCombo(mkEvent({ key: 'Enter', shiftKey: true }))).toBe('Shift+Enter');
  });

  test('Alt+f produces Alt+f', () => {
    expect(eventToCombo(mkEvent({ key: 'f', altKey: true }))).toBe('Alt+f');
  });

  test('Escape produces Escape', () => {
    expect(eventToCombo(mkEvent({ key: 'Escape' }))).toBe('Escape');
  });

  test('Meta+Ctrl+k includes both modifiers', () => {
    expect(eventToCombo(mkEvent({ key: 'k', metaKey: true, ctrlKey: true }))).toBe('Meta+Control+k');
  });

  test('space bar (key = " ") is treated as named; Shift IS included', () => {
    // key === ' ' has length 1 but the guard is key !== ' ', so Shift is included
    expect(eventToCombo(mkEvent({ key: ' ', shiftKey: true }))).toBe('Shift+ ');
  });

  test('Meta+Shift+N keeps Shift when Meta is held', () => {
    // Same class of bug as Ctrl+Shift+N, Shift must NOT be suppressed when Meta is held
    expect(eventToCombo(mkEvent({ key: 'N', metaKey: true, shiftKey: true }))).toBe('Meta+Shift+n');
  });

  test('Alt+Shift+X keeps Shift when Alt is held', () => {
    // Shift must NOT be suppressed when Alt is also held
    expect(eventToCombo(mkEvent({ key: 'X', altKey: true, shiftKey: true }))).toBe('Alt+Shift+x');
  });
});

// ---------------------------------------------------------------------------
// DISPATCH-LEVEL tests: the real hook, mounted, fed real keydown events.
//
// useHotkeys registers one keydown listener on `document`; everything below
// dispatches a KeyboardEvent through the DOM (happy-dom) and asserts which
// handler ran, whether the event's default was cancelled, and what the
// sequence state did across two keypresses. Nothing here re-implements the
// hook's dispatch loop, a bug in the loop is a failure here.
// ---------------------------------------------------------------------------

interface Mounted {
  fired: string[];
  unmount: () => void;
}

function mountHotkeys(bindings: (Omit<HotkeyBinding, 'handler'> & { id: string })[]): Mounted {
  const fired: string[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Owner(): null {
    useHotkeys(bindings.map(({ id, combo, allowInInput }) => ({
      combo,
      allowInInput,
      handler: () => { fired.push(id); },
    })));
    return null;
  }
  flushSync(() => { root.render(React.createElement(Owner)); });
  return {
    fired,
    unmount: () => {
      flushSync(() => { root.unmount(); });
      container.remove();
    },
  };
}

/** Dispatch a keydown on `target` (default: document) and report whether the default was cancelled. */
function press(
  key: string,
  mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {},
  target: EventTarget = document,
): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

// The bindings CommandProvider advertises (test env is non-Mac, so mod = Control).
const ADVERTISED = [
  { id: 'mod+k', combo: 'mod+k', allowInInput: true },
  { id: '?', combo: '?' },
  { id: 'g c', combo: 'g c' },
  { id: 'g k', combo: 'g k' },
  { id: 'g p', combo: 'g p' },
  { id: 'g a', combo: 'g a' },
  { id: 'mod+shift+n', combo: 'mod+shift+n', allowInInput: true },
];

describe('useHotkeys dispatch: the mounted hook fires the right handler for a real keydown', () => {
  let mounted: Mounted;
  beforeEach(() => { mounted = mountHotkeys(ADVERTISED); });
  afterEach(() => { mounted.unmount(); });

  test('Ctrl+k fires mod+k and cancels the browser default', () => {
    const prevented = press('k', { ctrlKey: true });
    expect(mounted.fired).toEqual(['mod+k']);
    expect(prevented).toBe(true);
  });

  test('Ctrl+Shift+N fires mod+shift+n (Shift is kept when Ctrl is held)', () => {
    press('N', { ctrlKey: true, shiftKey: true });
    expect(mounted.fired).toEqual(['mod+shift+n']);
  });

  test('Shift+/ arrives as key "?" and fires the ? binding', () => {
    press('?', { shiftKey: true });
    expect(mounted.fired).toEqual(['?']);
  });

  test('an unbound key fires nothing and leaves the default alone', () => {
    const prevented = press('z');
    expect(mounted.fired).toEqual([]);
    expect(prevented).toBe(false);
  });

  test('one keydown fires at most one binding', () => {
    press('k', { ctrlKey: true });
    press('k', { ctrlKey: true });
    expect(mounted.fired).toEqual(['mod+k', 'mod+k']);
  });
});

describe('useHotkeys dispatch: two-key sequences', () => {
  let mounted: Mounted;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mounted = mountHotkeys(ADVERTISED);
  });
  afterEach(() => {
    mounted.unmount();
    jest.useRealTimers();
  });

  test('g then c fires "g c"; the first key alone fires nothing and is not swallowed', () => {
    const firstPrevented = press('g');
    expect(mounted.fired).toEqual([]);
    expect(firstPrevented).toBe(false);
    const secondPrevented = press('c');
    expect(mounted.fired).toEqual(['g c']);
    expect(secondPrevented).toBe(true);
  });

  test('each second key selects its own sequence binding after the same first key', () => {
    for (const [second, id] of [['k', 'g k'], ['p', 'g p'], ['a', 'g a']] as const) {
      press('g');
      press(second);
      expect(mounted.fired.at(-1)).toBe(id);
    }
  });

  test('the second key after the timeout does not complete the sequence', () => {
    press('g');
    jest.setSystemTime(new Date('2026-01-01T00:00:01.500Z'));
    press('c');
    expect(mounted.fired).toEqual([]);
  });

  test('an unrelated key between the two cancels the pending sequence', () => {
    press('g');
    press('x');
    press('c');
    expect(mounted.fired).toEqual([]);
  });

  test('a completed sequence does not stay armed for a second completion', () => {
    press('g');
    press('c');
    press('c');
    expect(mounted.fired).toEqual(['g c']);
  });
});

describe('useHotkeys dispatch: typing in an editable element', () => {
  let mounted: Mounted;
  let input: HTMLInputElement;
  beforeEach(() => {
    mounted = mountHotkeys(ADVERTISED);
    input = document.createElement('input');
    document.body.appendChild(input);
  });
  afterEach(() => {
    input.remove();
    mounted.unmount();
  });

  test('a binding without allowInInput does not fire from inside an input', () => {
    const prevented = press('?', { shiftKey: true }, input);
    expect(mounted.fired).toEqual([]);
    expect(prevented).toBe(false);
  });

  test('a sequence is not even armed from inside an input', () => {
    press('g', {}, input);
    press('c');
    expect(mounted.fired).toEqual([]);
  });

  test('bindings with allowInInput fire from inside an input', () => {
    press('k', { ctrlKey: true }, input);
    press('N', { ctrlKey: true, shiftKey: true }, input);
    expect(mounted.fired).toEqual(['mod+k', 'mod+shift+n']);
  });

  test('a textarea is guarded the same way', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    try {
      press('?', { shiftKey: true }, textarea);
      expect(mounted.fired).toEqual([]);
    } finally {
      textarea.remove();
    }
  });
});

describe('useHotkeys lifecycle', () => {
  test('unmounting removes the listener', () => {
    const mounted = mountHotkeys(ADVERTISED);
    mounted.unmount();
    press('k', { ctrlKey: true });
    expect(mounted.fired).toEqual([]);
  });

  test('the latest bindings are read on each keydown without re-registering', () => {
    const fired: string[] = [];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    function Owner({ combo }: { combo: string }): null {
      useHotkeys([{ combo, handler: () => { fired.push(combo); } }]);
      return null;
    }
    flushSync(() => { root.render(React.createElement(Owner, { combo: 'mod+k' })); });
    flushSync(() => { root.render(React.createElement(Owner, { combo: 'mod+j' })); });
    press('k', { ctrlKey: true });
    press('j', { ctrlKey: true });
    expect(fired).toEqual(['mod+j']);
    flushSync(() => { root.unmount(); });
    container.remove();
  });
});
