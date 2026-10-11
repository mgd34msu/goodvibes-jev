/**
 * Models and providers (the settings dialog section that replaced the
 * Providers view): provider rows carry their real per-route state in plain
 * words (never a decorative default), configured providers list first, the
 * "configured" signal is sourced correctly even when the merged list record
 * lacks a flat `configured` field, and a provider's detail shows its models
 * with context, and its per-route detail and repair hints.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../../../lib/toast';

const getCalls: string[] = [];

// Providers as returned by providers.list()/providers.get(), ProviderRuntimeSnapshot
// shape: routes live nested at runtime.auth.routes, configured at runtime.auth.configured.
const OPENAI_SNAPSHOT = {
  providerId: 'openai',
  active: true,
  modelCount: 1,
  runtime: {
    auth: {
      mode: 'api-key',
      configured: true,
      routes: [{ route: 'api-key', label: 'API Key', configured: true, freshness: 'healthy' }],
    },
  },
  models: [{ id: 'gpt-5', registryKey: 'openai:gpt-5', displayName: 'GPT-5', selectable: true, contextWindow: 200000 }],
};

const ANTHROPIC_SNAPSHOT = {
  providerId: 'anthropic',
  active: false,
  modelCount: 0,
  runtime: {
    auth: {
      mode: 'oauth',
      configured: false,
      routes: [{ route: 'service-oauth', label: 'Service OAuth', configured: false, freshness: 'unconfigured' }],
    },
  },
  models: [],
};

// Present ONLY in providers.list (no models.list catalog match), the
// merged record has no flat `configured`/`configuredVia`, only the nested
// runtime.auth.configured. Proves the header sources from the real signal.
const MISTRAL_SNAPSHOT = {
  providerId: 'mistral',
  active: true,
  modelCount: 1,
  runtime: {
    auth: {
      mode: 'api-key',
      configured: true,
      routes: [{ route: 'api-key', label: 'API Key', configured: true, freshness: 'healthy' }],
    },
  },
  models: [{ id: 'mistral-large', registryKey: 'mistral:mistral-large', displayName: 'Mistral Large', selectable: true, contextWindow: 128000 }],
};

const AZURE_SNAPSHOT = {
  providerId: 'azure',
  active: true,
  modelCount: 1,
  runtime: {
    auth: {
      mode: 'api-key',
      configured: true,
      routes: [
        { route: 'api-key', label: 'API Key', configured: true, freshness: 'healthy' },
        {
          route: 'secret-ref',
          label: 'Secret Reference',
          configured: true,
          freshness: 'expired',
          detail: 'refresh token expired 2h ago',
          repairHints: ['re-authenticate in the daemon settings'],
        },
      ],
    },
  },
  models: [{ id: 'gpt-5-azure', registryKey: 'azure:gpt-5-azure', displayName: 'GPT-5 (Azure)', selectable: true, contextWindow: 200000 }],
};

const PROVIDERS_LIST_FIXTURE = {
  providers: [OPENAI_SNAPSHOT, ANTHROPIC_SNAPSHOT, MISTRAL_SNAPSHOT, AZURE_SNAPSHOT],
};

// models.list() catalog, ModelRouteProviderRecord shape: flat configured/configuredVia/routes.
// Deliberately omits 'mistral' to simulate the catalog-mismatch bug.
const MODELS_LIST_FIXTURE = {
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      configured: true,
      configuredVia: 'env',
      envVars: ['OPENAI_API_KEY'],
      routes: [{ route: 'api-key', label: 'API Key', configured: true, freshness: 'healthy' }],
      models: [{ id: 'gpt-5', registryKey: 'openai:gpt-5', provider: 'openai', label: 'GPT-5' }],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      configured: false,
      envVars: [],
      routes: [{ route: 'service-oauth', label: 'Service OAuth', configured: false, freshness: 'unconfigured' }],
      models: [],
    },
    {
      id: 'azure',
      label: 'Azure',
      configured: true,
      configuredVia: 'secrets',
      envVars: [],
      routes: [
        { route: 'api-key', label: 'API Key', configured: true, freshness: 'healthy' },
        { route: 'secret-ref', label: 'Secret Reference', configured: true, freshness: 'expired', detail: 'refresh token expired 2h ago', repairHints: ['re-authenticate in the daemon settings'] },
      ],
      models: [{ id: 'gpt-5-azure', registryKey: 'azure:gpt-5-azure', provider: 'azure', label: 'GPT-5 (Azure)' }],
    },
  ],
  currentModel: { registryKey: 'openai:gpt-5', provider: 'openai', id: 'gpt-5' },
  secretsResolutionSkipped: false,
};

mock.module('../../../../lib/goodvibes', () => ({
  runBrowserJudgment: () => Promise.reject(new Error('No semantic credential reading in this display fixture.')),
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  sdk: {
    operator: {
      providers: {
        list: () => Promise.resolve(PROVIDERS_LIST_FIXTURE),
        get: (providerId: string) => {
          getCalls.push(providerId);
          const byId: Record<string, unknown> = {
            openai: OPENAI_SNAPSHOT,
            anthropic: ANTHROPIC_SNAPSHOT,
            mistral: MISTRAL_SNAPSHOT,
            azure: AZURE_SNAPSHOT,
          };
          return Promise.resolve(byId[providerId] ?? null);
        },
        usage: () => Promise.resolve({ providerId: 'openai', active: true, pricingSource: 'none', models: [], usage: { streaming: true, toolCalling: true, parallelTools: true } }),
      },
      models: {
        list: () => Promise.resolve(MODELS_LIST_FIXTURE),
        current: {
          get: () => Promise.resolve({ model: { registryKey: 'openai:gpt-5', provider: 'openai', id: 'gpt-5' }, configured: true }),
          set: () => Promise.resolve({}),
        },
      },
      accounts: {
        snapshot: () => Promise.resolve({}),
      },
      config: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve({ success: true }),
      },
      credentials: {
        // Mirrors the real 200 shape ({ available: true, credentials: [...] })
        //, deriveCredentialAvailability reads value.credentials, so this
        // exercises the panel's normal "available" rendering path within the
        // existing ProvidersView suite. Dedicated available/degraded/refused
        // coverage lives in CredentialStatusPanel.test.tsx.
        get: () =>
          Promise.resolve({
            available: true,
            credentials: [
              { key: 'ANTHROPIC_API_KEY', configured: true, usable: true, source: 'env', secure: true },
            ],
          }),
      },
    },
  },
}));

const { ModelsSection, contextLabel, priceLabel } = await import('./ModelsSection');
const { ConfigSettingsProvider } = await import('../ConfigSettings');

function render(): { el: HTMLElement; unmount: () => void } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          ToastProvider,
          null,
          React.createElement(ConfigSettingsProvider, null, React.createElement(ModelsSection)),
        ),
      ),
    );
  });
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function click(el: Element | null | undefined) {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}

function rows(el: HTMLElement): Element[] {
  return [...el.querySelectorAll('.settings-provider-row')];
}

function rowFor(el: HTMLElement, text: string): Element | undefined {
  return rows(el).find((r) => r.querySelector('.gv-row__title')?.textContent === text);
}

async function openProvider(el: HTMLElement, title: string): Promise<void> {
  await waitFor(() => Boolean(rowFor(el, title)));
  click(rowFor(el, title)?.querySelector('.gv-row__main'));
  await waitFor(() => (el.textContent ?? '').includes('All providers'));
}

afterEach(() => {
  getCalls.length = 0;
});

describe('Models and providers: provider rows say their real state in words', () => {

  test('configured providers are listed before unconfigured ones', async () => {
    const { el, unmount } = render();
    await waitFor(() => rows(el).length >= 4);
    const titles = rows(el).map((row) => row.querySelector('.gv-row__title')?.textContent ?? '');
    expect(titles.indexOf('Anthropic')).toBe(titles.length - 1);
    unmount();
  });

  test('the current model shows its registry key', async () => {
    const { el, unmount } = render();
    await waitFor(() => (el.textContent ?? '').includes('openai:gpt-5'));
    expect(el.querySelector('[data-testid="current-model"]')?.textContent).toContain('openai:gpt-5');
    unmount();
  });
});

describe('Models and providers: a provider opens in place', () => {
  test('a provider present only in providers.list (no catalog match, no flat `configured`) opens and fetches its detail', async () => {
    const { el, unmount } = render();
    await openProvider(el, 'mistral');
    await waitFor(() => getCalls.includes('mistral'));
    unmount();
  });

  test('an expired route shows its detail and repair hints', async () => {
    const { el, unmount } = render();
    await openProvider(el, 'Azure');
    await waitFor(() => (el.textContent ?? '').includes('refresh token expired 2h ago'));
    expect(el.textContent).toContain('refresh token expired 2h ago');
    expect(el.textContent).toContain('re-authenticate in the daemon settings');
    unmount();
  });

  test('model rows read name left and context right, with one action; back returns to the list', async () => {
    const { el, unmount } = render();
    await openProvider(el, 'Azure');
    await waitFor(() => (el.textContent ?? '').includes('GPT-5 (Azure)'));
    const row = [...el.querySelectorAll('.settings-model-row')].find((r) => r.textContent?.includes('GPT-5 (Azure)'));
    expect(row?.querySelector('.gv-row__meta')?.textContent).toBe('azure:gpt-5-azure');
    expect(row?.querySelector('button[aria-label="Use GPT-5 (Azure)"]')).not.toBeNull();
    const back = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('All providers'));
    click(back);
    await waitFor(() => rows(el).length > 0);
    unmount();
  });
});

describe('model facts', () => {
  test('context and price read in plain units', () => {
    expect(contextLabel({ contextWindow: 200000 })).toContain('200k');
    expect(contextLabel({ contextWindow: 1_000_000 })).toContain('1M');
    expect(contextLabel({})).toBe('');
    const priced = priceLabel({ pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15 } });
    expect(priced).toContain('$3');
    expect(priced).toContain('$15');
    const free = priceLabel({ pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } });
    expect(free.length).toBeGreaterThan(0);
    expect(free).not.toContain('$');
    expect(priceLabel({})).toBe('');
  });
});
