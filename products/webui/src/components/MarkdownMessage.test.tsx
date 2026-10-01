/**
 * MarkdownMessage code blocks: syntax highlighting, a labelled copy action, and
 * decorative (hidden from assistive tech) line numbers when asked for.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MarkdownMessage } from './MarkdownMessage';

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

describe('MarkdownMessage', () => {
  test('a fenced code block renders its code and offers a copy action', () => {
    const el = render(<MarkdownMessage content={'```ts\nconst answer = 42;\n```'} />);
    expect(el.querySelector('button[aria-label="Copy code"]')).not.toBeNull();
    expect(el.querySelector('pre')?.textContent).toContain('const answer = 42;');
  });

  test('line numbers are rendered per line and hidden from assistive tech', () => {
    const el = render(<MarkdownMessage content={'```bash\nbun test\nbun run build\n```'} lineNumbers />);
    const numbers = [...el.querySelectorAll('pre [aria-hidden="true"]')].map((n) => n.textContent);
    expect(numbers).toEqual(['1', '2']);
    expect(el.querySelector('pre')?.textContent).toContain('bun run build');
  });

  test('without line numbers no hidden numbering spans exist', () => {
    const el = render(<MarkdownMessage content={'```bash\nbun test\n```'} lineNumbers={false} />);
    expect(el.querySelectorAll('pre [aria-hidden="true"]')).toHaveLength(0);
  });
});
