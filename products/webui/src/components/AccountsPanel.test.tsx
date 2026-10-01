import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { AccountsPanel } from './AccountsPanel';

const SNAPSHOT = {
  capturedAt: 1,
  configuredCount: 1,
  issueCount: 1,
  providers: [
    {
      providerId: 'openai',
      configured: true,
      modelCount: 2,
      activeRoute: 'subscription',
      authFreshness: 'expiring',
      usageWindows: [{ label: '5-hour window', detail: 'rolling limit applies' }],
      issues: ['Token refreshes soon'],
      recommendedActions: ['Re-authenticate before it expires'],
    },
    {
      providerId: 'mistral',
      configured: false,
      modelCount: 0,
      activeRoute: 'unconfigured',
      authFreshness: 'unconfigured',
      usageWindows: [],
      issues: [],
      recommendedActions: [],
    },
  ],
};

function render(props: Partial<React.ComponentProps<typeof AccountsPanel>> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(AccountsPanel, {
        data: undefined,
        isLoading: false,
        isError: false,
        error: null,
        onRetry: () => {},
        ...props,
      }),
    );
  });
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

describe('AccountsPanel: honest states, never a fabricated one', () => {
  test('loading shows a skeleton, not stale/empty content', () => {
    const { el, unmount } = render({ isLoading: true });
    expect(el.querySelector('[aria-busy="true"]')).not.toBeNull();
    unmount();
  });

  test('an error shows ErrorState with retry, not a blank panel', () => {
    let retried = false;
    const { el, unmount } = render({ isError: true, error: new Error('boom'), onRetry: () => { retried = true; } });
    const retryButton = [...el.querySelectorAll('button')].find((b) => /retry/i.test(b.textContent ?? ''));
    flushSync(() => retryButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
    expect(retried).toBe(true);
    unmount();
  });

  test('renders per-provider active route, freshness, usage windows, issues, and recommended actions', () => {
    const { el, unmount } = render({ data: SNAPSHOT });
    expect(el.textContent).toContain('subscription');
    expect(el.textContent).toContain('expiring');
    expect(el.textContent).toContain('5-hour window');
    expect(el.textContent).toContain('rolling limit applies');
    expect(el.textContent).toContain('Token refreshes soon');
    expect(el.textContent).toContain('Re-authenticate before it expires');
    expect(el.textContent).toContain('unconfigured');
    expect([...el.querySelectorAll('[data-classification="structured"]')].map((badge) => badge.getAttribute('data-tone'))).toEqual(['warning', 'neutral']);
    unmount();
  });
});
