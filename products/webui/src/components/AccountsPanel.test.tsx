import { describe, expect, test } from 'bun:test';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
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
      active: true,
      configured: true,
      oauthReady: false,
      pendingLogin: false,
      availableRoutes: ['subscription'],
      preferredRoute: 'subscription',
      activeRouteReason: 'Native subscription route',
      notes: [],
      routeRecords: [],
      modelCount: 2,
      activeRoute: 'subscription',
      authFreshness: 'expiring',
      usageWindows: [{ label: '5-hour window', detail: 'rolling limit applies' }],
      issues: ['Token refreshes soon'],
      recommendedActions: [{ description: 'Re-authenticate before it expires', command: { name: 'subscription', args: ['login', 'openai', 'start'] } }],
    },
    {
      providerId: 'mistral',
      active: false,
      configured: false,
      oauthReady: false,
      pendingLogin: false,
      availableRoutes: [],
      preferredRoute: 'unconfigured',
      activeRouteReason: 'Native unconfigured route',
      notes: [],
      routeRecords: [],
      modelCount: 0,
      activeRoute: 'unconfigured',
      authFreshness: 'unconfigured',
      usageWindows: [],
      issues: [],
      recommendedActions: [],
    },
  ],
} satisfies OperatorMethodOutput<'accounts.snapshot'>;

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
  test('renders actual native object advice with and without commands as read-only descriptions', () => {
    const nativeSnapshot = {
  "capturedAt": 1,
  "configuredCount": 0,
  "issueCount": 0,
  "providers": [
    {
      "providerId": "aihubmix",
      "active": false,
      "modelCount": 20,
      "configured": false,
      "oauthReady": false,
      "pendingLogin": false,
      "availableRoutes": [
        "unconfigured"
      ],
      "preferredRoute": "unconfigured",
      "activeRoute": "unconfigured",
      "activeRouteReason": "No usable auth route is configured for this provider.",
      "authFreshness": "unconfigured",
      "notes": [],
      "usageWindows": [],
      "issues": [],
      "recommendedActions": [
        {
          "description": "Configure an API key or OAuth-backed route for aihubmix.",
          "command": {
            "name": "secrets",
            "args": [
              "set",
              "AIHUBMIX_API_KEY"
            ]
          }
        },
        {
          "description": "Set AIHUBMIX_API_KEY or store one of those keys in /secrets."
        },
        {
          "description": "Use /secrets link <KEY> <secret-ref> to attach Bitwarden, Vaultwarden, BWS, or another supported SecretRef."
        },
        {
          "description": "Repair the provider service credential in /services or the settings surface."
        }
      ],
      "routeRecords": []
    }
  ]
} satisfies OperatorMethodOutput<'accounts.snapshot'>;
    const { el, unmount } = render({ data: nativeSnapshot });
    const descriptions = [...el.querySelectorAll('.accounts-panel__actions-list li')].map((item) => item.textContent);
    expect(descriptions).toEqual(nativeSnapshot.providers[0].recommendedActions.map((action) => action.description));
    expect(el.querySelector('.accounts-panel__actions-list button')).toBeNull();
    expect(el.textContent).toContain(nativeSnapshot.providers[0].activeRoute);
    expect(el.textContent).toContain(nativeSnapshot.providers[0].authFreshness);
    for (const issue of nativeSnapshot.providers[0].issues) expect(el.textContent).toContain(issue);
    unmount();
  });

});
