/**
 * ModelPricesEditor, the pricing.modelPrices structured editor. Verifies the
 * per-model rows render, and that add / edit / remove each commit the FULL
 * replacement table (the daemon's one-key config.set contract), with honest
 * inline validation instead of silent coercion.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ModelPricesEditor } from './ModelPricesEditor';

function render(value: unknown, onCommit: (next: Record<string, unknown>) => Promise<void>, initialModelKey?: string) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(<ModelPricesEditor value={value} onCommit={onCommit} {...(initialModelKey ? { initialModelKey } : {})} />);
  });
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  flushSync(() => {
    setter?.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function click(el: Element | null | undefined): void {
  flushSync(() => {
    el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
}

const TABLE = {
  'anthropic:claude-3-5-haiku': { input: 0.8, output: 4 },
  'openrouter:deepseek/deepseek-chat': { input: 0.14, output: 0.28, cacheRead: 0.014 },
};

describe('ModelPricesEditor', () => {
  test('renders one row per entry with the full rate summary', () => {
    const { el, unmount } = render(TABLE, async () => {});
    const rows = [...el.querySelectorAll('.price-row')];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('anthropic:claude-3-5-haiku');
    expect(rows[0].textContent).toContain('$0.8');
    expect(rows[0].textContent).toContain('$4');
    expect(rows[1].textContent).toContain('$0.014');
    unmount();
  });

  test('empty table renders no rows', () => {
    const { el, unmount } = render({}, async () => {});
    expect(el.querySelectorAll('.price-row').length).toBe(0);
    unmount();
  });

  test('adding an entry commits the whole replacement table', async () => {
    const commits: Record<string, unknown>[] = [];
    const { el, unmount } = render(TABLE, async (next) => {
      commits.push(next);
    });
    click(el.querySelector('.model-prices-add'));
    setInputValue(el.querySelector('input[aria-label="Model key (provider:model)"]') as HTMLInputElement, 'local:llama-3.3');
    setInputValue(el.querySelector('input[aria-label="Input price (USD per 1M tokens)"]') as HTMLInputElement, '0');
    setInputValue(el.querySelector('input[aria-label="Output price (USD per 1M tokens)"]') as HTMLInputElement, '0');
    click(el.querySelector('.model-prices-form button[type="submit"]'));
    await settle();
    expect(commits.length).toBe(1);
    expect(Object.keys(commits[0]).sort()).toEqual([
      'anthropic:claude-3-5-haiku',
      'local:llama-3.3',
      'openrouter:deepseek/deepseek-chat',
    ]);
    expect(commits[0]['local:llama-3.3']).toEqual({ input: 0, output: 0 });
    unmount();
  });

  test('an invalid draft surfaces the problem and never commits', async () => {
    const commits: unknown[] = [];
    const { el, unmount } = render({}, async (next) => {
      commits.push(next);
    });
    setInputValue(el.querySelector('input[aria-label="Model key (provider:model)"]') as HTMLInputElement, 'no-colon-model');
    setInputValue(el.querySelector('input[aria-label="Input price (USD per 1M tokens)"]') as HTMLInputElement, '1');
    setInputValue(el.querySelector('input[aria-label="Output price (USD per 1M tokens)"]') as HTMLInputElement, '2');
    click(el.querySelector('.model-prices-form button[type="submit"]'));
    await settle();
    expect(commits.length).toBe(0);
    expect(el.querySelector('.model-prices-error')).not.toBeNull();
    unmount();
  });

  test('editing an existing row pre-fills the form and commits the updated table', async () => {
    const commits: Record<string, unknown>[] = [];
    const { el, unmount } = render(TABLE, async (next) => {
      commits.push(next);
    });
    click(el.querySelector('button[aria-label="Edit price for anthropic:claude-3-5-haiku"]'));
    const inputRate = el.querySelector('input[aria-label="Input price (USD per 1M tokens)"]') as HTMLInputElement;
    expect(inputRate.value).toBe('0.8');
    setInputValue(inputRate, '1.6');
    click(el.querySelector('.model-prices-form button[type="submit"]'));
    await settle();
    expect(commits.length).toBe(1);
    expect(commits[0]['anthropic:claude-3-5-haiku']).toEqual({ input: 1.6, output: 4 });
    expect(commits[0]['openrouter:deepseek/deepseek-chat']).toEqual({ input: 0.14, output: 0.28, cacheRead: 0.014 });
    unmount();
  });

  test('remove commits the table without that entry', async () => {
    const commits: Record<string, unknown>[] = [];
    const { el, unmount } = render(TABLE, async (next) => {
      commits.push(next);
    });
    click(el.querySelector('button[aria-label="Remove price for anthropic:claude-3-5-haiku"]'));
    await settle();
    expect(commits.length).toBe(1);
    expect(Object.keys(commits[0])).toEqual(['openrouter:deepseek/deepseek-chat']);
    unmount();
  });

  test('a rejected commit surfaces the daemon error inline and keeps the form open', async () => {
    const { el, unmount } = render({}, async () => {
      throw new Error('Validation failed: prices must be finite numbers >= 0');
    });
    setInputValue(el.querySelector('input[aria-label="Model key (provider:model)"]') as HTMLInputElement, 'a:b');
    setInputValue(el.querySelector('input[aria-label="Input price (USD per 1M tokens)"]') as HTMLInputElement, '1');
    setInputValue(el.querySelector('input[aria-label="Output price (USD per 1M tokens)"]') as HTMLInputElement, '2');
    click(el.querySelector('.model-prices-form button[type="submit"]'));
    await settle();
    expect(el.querySelector('.model-prices-error')?.textContent).toContain('Validation failed');
    expect(el.querySelector('.model-prices-form')).not.toBeNull();
    unmount();
  });

  test('initialModelKey pre-fills the add form for "set a price for this model"', () => {
    const { el, unmount } = render({}, async () => {}, 'openrouter:qwen/qwen-2.5');
    const keyInput = el.querySelector('input[aria-label="Model key (provider:model)"]') as HTMLInputElement;
    expect(keyInput.value).toBe('openrouter:qwen/qwen-2.5');
    unmount();
  });
});
