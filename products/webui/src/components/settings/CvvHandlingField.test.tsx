import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CvvHandlingField } from './CvvHandlingField';

const ENUM_VALUES = ['stored', 'prompt'] as const;

function render(props: { value: string; onCommit: (value: string) => void }): {
  container: HTMLElement;
  select: HTMLButtonElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(CvvHandlingField, { ...props, enumValues: ENUM_VALUES }));
  });
  const select = container.querySelector('.gv-select__trigger') as HTMLButtonElement;
  return {
    container,
    select,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

/** The kit Select's trigger; its listbox is portaled to document.body while open. */
function openOptions(trigger: HTMLButtonElement): HTMLElement[] {
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    flushSync(() => { trigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  }
  return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
}

function optionLabels(trigger: HTMLButtonElement): string[] {
  return openOptions(trigger).map((o) => o.textContent ?? '');
}

function selectLabel(trigger: HTMLButtonElement, label: string): void {
  const option = openOptions(trigger).find((o) => o.textContent === label);
  if (!option) throw new Error(`no option "${label}"`);
  flushSync(() => { option.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('CvvHandlingField', () => {
  test('shows the current mode and offers both modes', () => {
    const { select, unmount } = render({ value: 'stored', onCommit: () => {} });
    expect(select.textContent).toContain('stored');
    expect(optionLabels(select)).toEqual(['stored', 'prompt']);
    unmount();
  });

  test('starting on "stored" shows no warning', () => {
    const { container, unmount } = render({ value: 'stored', onCommit: () => {} });
    expect(container.querySelector('[data-testid="cvv-prompt-warning"]')).toBeNull();
    unmount();
  });

  test('starting on "prompt" shows the warning immediately (a saved config already set to prompt)', () => {
    const { container, unmount } = render({ value: 'prompt', onCommit: () => {} });
    expect(container.querySelector('[data-testid="cvv-prompt-warning"]')).not.toBeNull();
    unmount();
  });

  test('selecting "prompt" surfaces the trade-off warning at the moment of selection', () => {
    const commits: string[] = [];
    const { container, select, unmount } = render({ value: 'stored', onCommit: (v) => commits.push(v) });
    selectLabel(select, 'prompt');
    expect(commits).toEqual(['prompt']);
    expect(container.querySelector('[data-testid="cvv-prompt-warning"]')).not.toBeNull();
    unmount();
  });

  test('selecting "stored" does not surface a warning, and commits', () => {
    const commits: string[] = [];
    const { container, select, unmount } = render({ value: 'prompt', onCommit: (v) => commits.push(v) });
    selectLabel(select, 'stored');
    expect(commits).toEqual(['stored']);
    expect(container.querySelector('[data-testid="cvv-prompt-warning"]')).toBeNull();
    unmount();
  });

  test('switching from prompt back to stored removes the warning', () => {
    const { container, select, unmount } = render({ value: 'prompt', onCommit: () => {} });
    expect(container.querySelector('[data-testid="cvv-prompt-warning"]')).not.toBeNull();
    selectLabel(select, 'stored');
    expect(container.querySelector('[data-testid="cvv-prompt-warning"]')).toBeNull();
    unmount();
  });
});
