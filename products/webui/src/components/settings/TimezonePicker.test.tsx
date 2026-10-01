import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TimezonePicker } from './TimezonePicker';
import { UNSET_TIMEZONE_LABEL, UNSET_TIMEZONE_VALUE } from '../../lib/timezones';

function render(props: { value: string; onCommit: (value: string) => void }): {
  container: HTMLElement;
  select: HTMLButtonElement;
  search: HTMLInputElement;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(TimezonePicker, props));
  });
  const select = container.querySelector('.gv-select__trigger') as HTMLButtonElement;
  const search = container.querySelector('input[type="search"]') as HTMLInputElement;
  return {
    container,
    select,
    search,
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

describe('TimezonePicker', () => {
  test('renders a select with the explicit "UTC (unset)" option always present', () => {
    const { select, unmount } = render({ value: '', onCommit: () => {} });
    // The unset value reads as its explicit label on the trigger.
    expect(select.textContent).toContain(UNSET_TIMEZONE_LABEL);
    expect(optionLabels(select)).toContain(UNSET_TIMEZONE_LABEL);
    unmount();
  });

  test('renders real IANA zone names as options', () => {
    const { select, unmount } = render({ value: '', onCommit: () => {} });
    expect(optionLabels(select)).toContain('America/New_York');
    unmount();
  });

  test('the current value is selected when it is a real zone', () => {
    const { select, unmount } = render({ value: 'Europe/London', onCommit: () => {} });
    expect(select.textContent).toContain('Europe/London');
    unmount();
  });

  test('selecting a real zone commits that exact IANA name', () => {
    const commits: string[] = [];
    const { select, unmount } = render({ value: '', onCommit: (v) => commits.push(v) });
    selectLabel(select, 'Asia/Tokyo');
    expect(commits).toEqual(['Asia/Tokyo']);
    unmount();
  });

  test('selecting the unset option commits the unset value', () => {
    const commits: string[] = [];
    const { select, unmount } = render({ value: 'Asia/Tokyo', onCommit: (v) => commits.push(v) });
    selectLabel(select, UNSET_TIMEZONE_LABEL);
    expect(commits).toEqual([UNSET_TIMEZONE_VALUE]);
    unmount();
  });

  test('typing in the search box filters the zone list to matching names', () => {
    const { select, search, unmount } = render({ value: '', onCommit: () => {} });
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      nativeSetter.call(search, 'New_York');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const labels = optionLabels(select);
    expect(labels).toContain('America/New_York');
    // Zones that clearly do not match the query are filtered out.
    expect(labels).not.toContain('Europe/London');
    unmount();
  });

  test('a search that filters out the current value still keeps it selectable, pinned in', () => {
    const { select, search, unmount } = render({ value: 'Europe/London', onCommit: () => {} });
    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      nativeSetter.call(search, 'tokyo');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(optionLabels(select)).toContain('Europe/London');
    expect(select.textContent).toContain('Europe/London');
    unmount();
  });
});
