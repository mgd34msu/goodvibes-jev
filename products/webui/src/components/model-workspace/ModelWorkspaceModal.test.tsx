import { afterEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';

const PROVIDERS_RESPONSE = {
  providers: [
    {
      providerId: 'anthropic',
      active: true,
      configured: true,
      models: [
        { id: 'claude-opus-4', registryKey: 'anthropic:claude-opus-4', displayName: 'Claude Opus 4', tier: 'premium', pricing: { inputPerMillionTokens: 15, outputPerMillionTokens: 75, currency: 'USD' } },
      ],
    },
    {
      providerId: 'openai',
      active: true,
      configured: true,
      models: [
        { id: 'gpt-5', registryKey: 'openai:gpt-5', displayName: 'GPT-5' },
      ],
    },
  ],
};

const selectCalls: string[] = [];
const configSetCalls: [string, unknown][] = [];

mock.module('../../lib/goodvibes', () => ({
  sdk: {
    operator: {
      providers: { list: () => Promise.resolve(PROVIDERS_RESPONSE) },
      models: {
        current: {
          get: () => Promise.resolve({ model: { registryKey: 'anthropic:claude-opus-4', provider: 'anthropic', id: 'claude-opus-4' } }),
          set: (registryKey: string) => {
            selectCalls.push(registryKey);
            return Promise.resolve({});
          },
        },
      },
      config: {
        get: () => Promise.resolve({ helper: { enabled: false, globalProvider: '', globalModel: '' }, provider: { embeddingProvider: 'hashed-local' } }),
        set: (key: string, value: unknown) => {
          configSetCalls.push([key, value]);
          return Promise.resolve({ success: true, key, value });
        },
      },
    },
  },
}));

const { ModelWorkspaceModal } = await import('./ModelWorkspaceModal');

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(ToastProvider, null, React.createElement(ModelWorkspaceModal, { open: true, onClose: () => {} })),
      ),
    );
  });
  return {
    // document.body: kit overlays (dialogs, drawers, menus) portal there.
    el: document.body,
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

function click(el: Element | null | undefined) {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  selectCalls.length = 0;
  configSetCalls.length = 0;
});

describe('ModelWorkspaceModal: multi-target routing', () => {
  test('offers all five targets', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[role="radiogroup"]')));
    expect(el.querySelectorAll('[role="radiogroup"] [role="radio"]')).toHaveLength(5);
    unmount();
  });

  test('the current model row is marked current, shows its price, and only other rows can be chosen', async () => {
    const { el, unmount } = render();
    await waitFor(() => el.textContent?.includes('claude-opus-4') ?? false);
    const opusRow = [...el.querySelectorAll('.model-workspace-row')].find((r) => r.textContent?.includes('Claude Opus 4'));
    expect(opusRow?.querySelector('[aria-current]')).not.toBeNull();
    expect(opusRow?.textContent).toContain('$15');
    expect(opusRow?.textContent).toContain('$75');
    expect(opusRow?.querySelector('button')?.hasAttribute('disabled')).toBe(true);
    const gptRow = [...el.querySelectorAll('.model-workspace-row')].find((r) => r.textContent?.includes('GPT-5'));
    expect(gptRow?.querySelector('[aria-current]')).toBeNull();
    expect(gptRow?.querySelector('button')?.hasAttribute('disabled')).toBe(false);
    unmount();
  });

  test('the price filter is enabled; real tier data is present in this fixture', async () => {
    const { el, unmount } = render();
    await waitFor(() => el.textContent?.includes('claude-opus-4') ?? false);
    const priceSelect = el.querySelector('.model-workspace-filter button[aria-label="Price"]');
    expect(priceSelect).not.toBeNull();
    expect(priceSelect?.hasAttribute('disabled')).toBe(false);
    unmount();
  });

  test('the capability filter is disabled, no wire data exists for it', async () => {
    const { el, unmount } = render();
    await waitFor(() => el.textContent?.includes('claude-opus-4') ?? false);
    const capabilitySelect = el.querySelector('.model-workspace-filter button[aria-label="Capability"]');
    expect(capabilitySelect).not.toBeNull();
    expect(capabilitySelect?.hasAttribute('disabled')).toBe(true);
    unmount();
  });

  test('main target: selecting a model calls models.current.set with its registryKey, never config.set', async () => {
    const { el, unmount } = render();
    await waitFor(() => el.textContent?.includes('GPT-5') ?? false);
    const gpt5Row = [...el.querySelectorAll('.model-workspace-row')].find((r) => r.textContent?.includes('GPT-5'));
    click(gpt5Row?.querySelector('button'));
    await waitFor(() => selectCalls.length > 0);
    expect(selectCalls).toEqual(['openai:gpt-5']);
    expect(configSetCalls).toEqual([]);
    unmount();
  });

  test('helper target: selecting a model writes globalProvider + globalModel + enabled via config.set, never models.current.set', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[role="radiogroup"]')));
    const helperTab = [...el.querySelectorAll('[role="radio"]')].find((t) => t.textContent === 'Helper Model');
    click(helperTab);
    await waitFor(() => el.textContent?.includes('GPT-5') ?? false);
    const gpt5Row = [...el.querySelectorAll('.model-workspace-row')].find((r) => r.textContent?.includes('GPT-5'));
    click(gpt5Row?.querySelector('button'));
    await waitFor(() => configSetCalls.length >= 3);
    expect(configSetCalls).toEqual([
      ['helper.globalProvider', 'openai'],
      ['helper.globalModel', 'gpt-5'],
      ['helper.enabled', true],
    ]);
    expect(selectCalls).toEqual([]);
    unmount();
  });

  test('embeddings target: no model concept; lists providers only, "Use" writes provider.embeddingProvider alone', async () => {
    const { el, unmount } = render();
    await waitFor(() => Boolean(el.querySelector('[role="radiogroup"]')));
    const embeddingsTab = [...el.querySelectorAll('[role="radio"]')].find((t) => t.textContent === 'Embeddings');
    click(embeddingsTab);
    await waitFor(() => Boolean([...el.querySelectorAll('.model-workspace-row')].find((r) => r.textContent?.includes('openai'))));
    expect(el.textContent).not.toContain('claude-opus-4');
    const openaiRow = [...el.querySelectorAll('.model-workspace-row')].find((r) => r.textContent?.includes('openai'));
    click(openaiRow?.querySelector('button'));
    await waitFor(() => configSetCalls.length > 0);
    expect(configSetCalls).toEqual([['provider.embeddingProvider', 'openai']]);
    unmount();
  });
});
