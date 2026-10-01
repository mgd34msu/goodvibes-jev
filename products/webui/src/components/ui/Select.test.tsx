import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Select } from './Select';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let value = 'project';
const parentKeys: string[] = [];

const OPTIONS = [
  { value: 'project', label: 'Project' },
  { value: 'global', label: 'Global' },
  { value: 'session', label: 'Session' },
];

function renderSelect(): void {
  flushSync(() => {
    root.render(
      // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- test harness: records keys that reach the parent
      <div onKeyDown={(e) => parentKeys.push(e.key)}>
        <Select aria-label="Scope" value={value} options={OPTIONS} onChange={(v) => { value = v; renderSelect(); }} />
      </div>,
    );
  });
}

function key(target: Element, k: string): void {
  flushSync(() => {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}
const trigger = () => container.querySelector('button') as HTMLButtonElement;
const listbox = () => document.querySelector('[role="listbox"]');

beforeEach(() => {
  value = 'project';
  parentKeys.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  renderSelect();
});
afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('Select: a styled listbox, no native select', () => {
  test('renders a button trigger showing the current label, never a <select>', () => {
    expect(trigger().textContent).toContain('Project');
  });

  test('ArrowDown opens on the selected option; arrows move; Enter picks and closes', () => {
    key(trigger(), 'ArrowDown');
    const list = listbox()!;
    expect(list).not.toBeNull();
    expect(document.activeElement).toBe(list);
    const activeId = () => list.getAttribute('aria-activedescendant');
    expect(document.getElementById(activeId()!)?.textContent).toContain('Project');
    key(list, 'ArrowDown');
    expect(document.getElementById(activeId()!)?.textContent).toContain('Global');
    key(list, 'Enter');
    expect(value).toBe('global');
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().textContent).toContain('Global');
  });

  test('a letter jumps to the next option starting with it', () => {
    key(trigger(), 'Enter');
    const list = listbox()!;
    key(list, 's');
    expect(document.getElementById(list.getAttribute('aria-activedescendant')!)?.textContent).toContain('Session');
  });

  test('Escape closes the list and never reaches what is underneath', () => {
    key(trigger(), 'Enter');
    parentKeys.length = 0;
    key(listbox()!, 'Escape');
    expect(listbox()).toBeNull();
    expect(parentKeys).not.toContain('Escape');
    expect(value).toBe('project');
  });
});
