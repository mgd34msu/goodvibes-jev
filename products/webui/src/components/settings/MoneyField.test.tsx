import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MoneyField } from './MoneyField';

function render(props: { value: number; currency: string; onCommit: (value: number) => void }): {
  container: HTMLElement;
  input: HTMLInputElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(MoneyField, props));
  });
  const input = container.querySelector('input') as HTMLInputElement;
  return {
    container,
    input,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function typeAndBlur(input: HTMLInputElement, text: string): void {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  flushSync(() => {
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  flushSync(() => {
    // React's onBlur listens on the bubbling native 'focusout' event (plain
    // 'blur' does not bubble, so React never observes it via delegation).
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

describe('MoneyField', () => {
  test('renders the live stored value as-is, with no unit conversion', () => {
    const { input, unmount } = render({ value: 19.99, currency: 'USD', onCommit: () => {} });
    expect(input.value).toBe('19.99');
    unmount();
  });

  test('shows the currency code', () => {
    const { container, unmount } = render({ value: 0, currency: 'GBP', onCommit: () => {} });
    expect(container.textContent).toContain('GBP');
    unmount();
  });

  test('a whole-number amount renders and commits 1:1; "100" stays 100, never scaled', () => {
    const { input, unmount } = render({ value: 100, currency: 'JPY', onCommit: () => {} });
    expect(input.value).toBe('100');
    unmount();

    const commits: number[] = [];
    const second = render({ value: 0, currency: 'JPY', onCommit: (v) => commits.push(v) });
    typeAndBlur(second.input, '100');
    expect(commits).toEqual([100]);
    second.unmount();
  });

  test('typing an amount and blurring commits the exact number typed, unscaled', () => {
    const commits: number[] = [];
    const { input, unmount } = render({ value: 0, currency: 'USD', onCommit: (v) => commits.push(v) });
    typeAndBlur(input, '19.99');
    expect(commits).toEqual([19.99]);
    unmount();
  });

  test('a round amount commits as typed: "50" stays 50, never becomes 5000', () => {
    const commits: number[] = [];
    const { input, unmount } = render({ value: 0, currency: 'USD', onCommit: (v) => commits.push(v) });
    typeAndBlur(input, '50');
    expect(commits).toEqual([50]);
    unmount();
  });

  test('a leading currency symbol is tolerated and stripped before commit', () => {
    const commits: number[] = [];
    const { input, unmount } = render({ value: 0, currency: 'USD', onCommit: (v) => commits.push(v) });
    typeAndBlur(input, '$100');
    expect(commits).toEqual([100]);
    unmount();
  });

  test('an invalid amount shows an inline error and does not commit', () => {
    const commits: number[] = [];
    const { input, container, unmount } = render({ value: 0, currency: 'USD', onCommit: (v) => commits.push(v) });
    typeAndBlur(input, 'not-a-number');
    expect(commits).toEqual([]);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    unmount();
  });

  test('a negative amount is refused', () => {
    const commits: number[] = [];
    const { input, container, unmount } = render({ value: 0, currency: 'USD', onCommit: (v) => commits.push(v) });
    typeAndBlur(input, '-5');
    expect(commits).toEqual([]);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    unmount();
  });

  test('leaving the value unchanged does not commit', () => {
    let commitCount = 0;
    const { input, unmount } = render({ value: 19.99, currency: 'USD', onCommit: () => { commitCount += 1; } });
    typeAndBlur(input, '19.99');
    expect(commitCount).toBe(0);
    unmount();
  });
});
