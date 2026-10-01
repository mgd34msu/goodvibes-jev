import { afterEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { StatusBadge } from './StatusBadge';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function render(value: string, catalogId?: string, vocabulary: 'badge' | 'library-dot' = 'badge'): HTMLElement {
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<StatusBadge value={value} catalogId={catalogId} vocabulary={vocabulary} />));
  return container.querySelector('[data-classification]') as HTMLElement;
}
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });

describe('StatusBadge: explicit producer catalog', () => {
  test.each([
    ['healthy', 'account-auth.healthy', 'ok'],
    ['expired', 'account-auth.expired', 'bad'],
    ['expiring', 'account-auth.expiring', 'warning'],
    ['unconfigured', 'account-auth.unconfigured', 'neutral'],
    ['closed', 'session.closed', 'neutral'],
    ['running', 'knowledge-job.running', 'ok'],
  ])('%s uses its authoritative %s mapping', (value, catalogId, tone) => {
    const badge = render(value!, catalogId);
    expect(badge.getAttribute('data-tone')).toBe(tone!);
    expect(badge.getAttribute('data-classification')).toBe('structured');
    expect(badge.textContent).toBe(value!);
  });

  test('the same knowledge job uses the separate library-dot vocabulary', () => {
    const badge = render('running', 'knowledge-job.running', 'library-dot');
    expect(badge.getAttribute('data-tone')).toBe('info');
    expect(badge.textContent).toBe('running');
  });

  test.each([
    ['task did not fail', undefined], ['healthy', undefined],
    ['status unavailable', 'account-auth.status unavailable'], ['future-state', 'knowledge-job.future-state'],
  ])('unread %s remains visibly unclassified without a guessed tone or request', (value, catalogId) => {
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      requests++; throw new Error('unexpected classification request');
    }, { preconnect: original.preconnect });
    try {
      const badge = render(value!, catalogId);
      expect(badge.getAttribute('data-classification')).toBe('unavailable');
      expect(badge.hasAttribute('data-tone')).toBe(false);
      expect(badge.textContent).toBe(`${value} · unclassified`);
      expect(badge.querySelector('.gv-dot')).toBeNull();
      expect(requests).toBe(0);
    } finally { globalThis.fetch = original; }
  });
});
