/**
 * CredentialStatusPanel, the credential-status facade's display-site adoption.
 *
 * Proves the three honest outcomes render distinctly and that no secret byte
 * can ever reach the DOM: the panel only ever reads
 * key/configured/usable/source/secure off CredentialStatusEntry, a type that
 * carries no value field by construction (see provider-status.ts).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ---------------------------------------------------------------------------
// Module mock, mutable per-test credentials.get implementation
// ---------------------------------------------------------------------------

let _credentialsGet: () => Promise<unknown> = () => Promise.resolve({ available: true, credentials: [] });

mock.module('../lib/goodvibes', () => ({
  sdk: {
    operator: {
      credentials: {
        get: () => _credentialsGet(),
      },
    },
  },
}));

const { CredentialStatusPanel } = await import('./CredentialStatusPanel');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function render(selectedProviderId?: string): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(CredentialStatusPanel, { selectedProviderId }),
      ),
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

function rejection(status: number, body: unknown): Promise<never> {
  return Promise.reject(
    Object.assign(new Error(`GET /config/credentials failed: ${status}`), { status, body }),
  );
}

afterEach(() => {
  _credentialsGet = () => Promise.resolve({ available: true, credentials: [] });
});

// ---------------------------------------------------------------------------
// AVAILABLE, configured/usable, configured-but-unusable, and unconfigured
// ---------------------------------------------------------------------------

describe('CredentialStatusPanel: available (credentials.get resolves)', () => {
  test('a credential renders with its key and source', async () => {
    _credentialsGet = () =>
      Promise.resolve({
        available: true,
        credentials: [{ key: 'ANTHROPIC_API_KEY', configured: true, usable: true, source: 'env', secure: true }],
      });
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('ANTHROPIC_API_KEY'));
    expect(el.textContent).toContain('env');
    unmount();
  });

  test('a credential key matching the selected provider id is highlighted, a non-matching one is not', async () => {
    _credentialsGet = () =>
      Promise.resolve({
        available: true,
        credentials: [
          { key: 'ANTHROPIC_API_KEY', configured: true, usable: true, source: 'env' },
          { key: 'OPENAI_API_KEY', configured: true, usable: true, source: 'env' },
        ],
      });
    const { el, unmount } = render('anthropic');
    await waitFor(() => (el.textContent ?? '').includes('ANTHROPIC_API_KEY'));
    const rows = [...el.querySelectorAll('li')];
    const anthropicRow = rows.find((r) => r.textContent?.includes('ANTHROPIC_API_KEY'));
    const openaiRow = rows.find((r) => r.textContent?.includes('OPENAI_API_KEY'));
    expect(anthropicRow?.querySelector('[aria-current]')).not.toBeNull();
    expect(openaiRow?.querySelector('[aria-current]')).toBeNull();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// DEGRADED, the facade's honest unavailable states, never fabricated-configured
// ---------------------------------------------------------------------------

describe('CredentialStatusPanel: degraded and refused reads', () => {
  for (const [label, impl] of [
    ['a 503 CREDENTIAL_STORE_UNAVAILABLE', () => rejection(503, { error: 'Shared credential store unavailable', code: 'CREDENTIAL_STORE_UNAVAILABLE' })],
    ['a METHOD_NOT_FOUND from an older daemon', () => rejection(404, { error: 'Unknown gateway method', code: 'METHOD_NOT_FOUND' })],
    ['a transport failure', () => Promise.reject(new Error('fetch failed'))],
    ['a 403 admin refusal', () => rejection(403, { error: 'Admin role required' })],
  ] as const) {
    test(`${label} renders the degraded status and no credential rows`, async () => {
      _credentialsGet = impl as typeof _credentialsGet;
      const { el, unmount } = render();
      await waitFor(() => Boolean(el.querySelector('.credential-status__degraded[role="status"]')));
      expect(el.querySelectorAll('li')).toHaveLength(0);
      unmount();
    });
  }
});

// ---------------------------------------------------------------------------
// SECRET-FREE PIN, the type carries no value field; pin it dynamically too.
// ---------------------------------------------------------------------------

describe('CredentialStatusPanel: no secret bytes can render', () => {
  test('even if a wire response smuggled a `value`/`secret` field, the rendered DOM never contains it', async () => {
    _credentialsGet = () =>
      Promise.resolve({
        available: true,
        credentials: [
          {
            key: 'ANTHROPIC_API_KEY',
            configured: true,
            usable: true,
            source: 'env',
            // A malicious/buggy daemon build could add these, the entry
            // extraction in deriveCredentialAvailability only reads the five
            // known fields, so they must never reach the DOM.
            value: 'sk-ant-super-secret-do-not-render',
            secret: 'sk-ant-super-secret-do-not-render',
          },
        ],
      });
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('ANTHROPIC_API_KEY'));
    expect(el.textContent).not.toContain('sk-ant-super-secret-do-not-render');
    unmount();
  });
});
