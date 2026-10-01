/**
 * DataBlock: a titled section that renders a string as markdown, anything else
 * as a copyable JSON block, and an empty value as the empty sentence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DataBlock } from './DataBlock';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(element: React.ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(element));
  return container;
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('DataBlock', () => {
  test('the title is rendered', () => {
    const el = render(<DataBlock title="My Section" value="some content" />);
    expect(el.textContent).toContain('My Section');
  });

  test('undefined, null and an empty array render no code block', () => {
    for (const value of [undefined, null, []]) {
      const el = render(<DataBlock title="T" value={value} />);
      expect(el.querySelector('pre')).toBeNull();
      flushSync(() => root.unmount());
      container.remove();
    }
    // afterEach unmounts once more; leave a mounted root for it.
    render(<DataBlock title="T" value={undefined} />);
  });

  test('a custom empty sentence is rendered', () => {
    const el = render(<DataBlock title="T" value={undefined} empty="Nothing to show" />);
    expect(el.textContent).toContain('Nothing to show');
  });

  test('a string renders as markdown, not as a code block', () => {
    const el = render(<DataBlock title="Notes" value="Hello **world**" />);
    expect(el.querySelector('strong')?.textContent).toBe('world');
    expect(el.querySelector('pre')).toBeNull();
    expect(el.querySelector('button[aria-label="Copy value"]')).toBeNull();
  });

  test('an object renders as pretty JSON in a code block with a copy action', () => {
    const el = render(<DataBlock title="Data" value={{ user: { name: 'Alice', roles: ['admin'] }, count: 42 }} />);
    const pre = el.querySelector('pre')!;
    expect(pre).not.toBeNull();
    expect(JSON.parse(pre.textContent ?? '')).toEqual({ user: { name: 'Alice', roles: ['admin'] }, count: 42 });
    expect(el.querySelector('strong')).toBeNull();
    expect(el.querySelector('button[aria-label="Copy value"]')).not.toBeNull();
  });

  test('a number and a non-empty array also take the code-block path', () => {
    const number = render(<DataBlock title="Count" value={99} />);
    expect(number.querySelector('pre')?.textContent).toBe('99');
    flushSync(() => root.unmount());
    container.remove();

    const list = render(<DataBlock title="List" value={['a', 'b']} />);
    expect(JSON.parse(list.querySelector('pre')?.textContent ?? '')).toEqual(['a', 'b']);
  });
});
