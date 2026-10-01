/**
 * StatusBadge: a free-text status word classified into a tone (exposed as
 * data-tone), with the word itself as the only text.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { StatusBadge } from './StatusBadge';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render(value: string): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<StatusBadge value={value} />));
  return container.querySelector('[data-tone]') as HTMLElement;
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe('StatusBadge', () => {
  const cases: [string, string][] = [
    ['healthy', 'ok'],
    ['pending approval', 'warning'],
    ['task failed', 'bad'],
    // Provider auth-freshness vocabulary (src/lib/provider-status.ts).
    ['expired', 'bad'],
    ['expiring', 'warning'],
    ['unconfigured', 'neutral'],
    ['status unavailable', 'neutral'],
  ];

  for (const [value, tone] of cases) {
    test(`"${value}" carries the ${tone} tone and the word itself`, () => {
      const badge = render(value);
      expect(badge.getAttribute('data-tone')).toBe(tone);
      expect(badge.textContent).toBe(value);
    });
  }
});
