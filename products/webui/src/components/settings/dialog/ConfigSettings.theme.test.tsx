/** Production typed rows/provider with genuine config route validation and disk persistence. */
import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTerminalThemeHost, themeConfigRequest, type TerminalThemeHost } from '../../../../e2e/support/terminal-theme-host';
import { CONFIG_SCHEMA_ENTRIES } from '../../../lib/generated/config-schema';
import { buildSettingsModel } from '../../../lib/settings-model';
import { ThemeProvider } from '../../../hooks/useTheme';
import { THEME_PREFERENCES_KEY, THEMES } from '../../../lib/theme';
import { ToastProvider } from '../../../lib/toast';
import { SettingsField } from '../SettingsField';

let host: TerminalThemeHost;
async function config(method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
  const response = await host.dispatch(themeConfigRequest(method, body));
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : 'Config rejected';
    throw Object.assign(new Error(message), { status: response.status, body: value });
  }
  return value;
}
mock.module('../../../lib/goodvibes', () => ({
  runBrowserJudgment: async () => { throw new Error('No semantic reading fixture'); },
  sdk: { operator: { config: {
    get: () => config('GET'),
    set: (key: string, value: unknown) => config('POST', { key, value }),
  } } },
}));
const { ConfigSettingsProvider, ConfigGroupList, RawConfigEditor, useConfigSettings } = await import('./ConfigSettings');

function ThemeRows() {
  const { groups } = useConfigSettings();
  return <><ConfigGroupList groups={groups.filter(group => group.id === 'display')} /><RawConfigEditor /></>;
}
const cleanups: (() => void)[] = [];
function render(content: React.ReactNode = <ConfigSettingsProvider><ThemeRows /></ConfigSettingsProvider>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  flushSync(() => root.render(<QueryClientProvider client={client}><ToastProvider><ThemeProvider>{content}</ThemeProvider></ToastProvider></QueryClientProvider>));
  cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
  return { el, client };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Theme row did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
    flushSync(() => {});
  }
}
function trigger(el: HTMLElement) { return el.querySelector<HTMLButtonElement>('[data-config-key="display.theme"] [role="combobox"]')!; }
function openOptions(el: HTMLElement) {
  flushSync(() => trigger(el).dispatchEvent(new MouseEvent('click', { bubbles: true })));
  return [...document.body.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
}
function pick(el: HTMLElement, name: string) {
  const option = openOptions(el).find(item => item.textContent === name);
  if (!option) throw new Error(`Missing theme option: ${name}`);
  flushSync(() => option.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  host?.cleanup();
  localStorage.removeItem(THEME_PREFERENCES_KEY);
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});
const schema = CONFIG_SCHEMA_ENTRIES.find(entry => entry.key === 'display.theme')!;

test('an absent SettingsField uses the generated goodvibes default and exact enum choices', () => {
  const field = buildSettingsModel({}).find(group => group.id === 'display')!.plainRows.find(row => row.key === 'display.theme')!;
  const writes: unknown[] = [];
  const { el } = render(<SettingsField field={field} onCommit={async (...args) => { writes.push(args); }} />);
  expect(schema.type).toBe('enum');
  expect(schema.default).toBe('goodvibes');
  expect(schema.enumValues).toHaveLength(13);
  expect(trigger(el).textContent).toBe('goodvibes');
  expect(el.querySelector('.settings-field-default')?.textContent).toBe('default');
  expect(openOptions(el).map(option => option.textContent)).toEqual([...schema.enumValues!]);
  expect(el.querySelector('[data-config-key="display.theme"] input')).toBeNull();
  expect(el.querySelector('[data-config-key="display.theme"]')?.getAttribute('data-daemon-owned')).toBe('false');
  expect(writes).toEqual([]);
});

test('a noncanonical current enum value from an older host stays visible without a silent write', () => {
  const field = buildSettingsModel({ display: { theme: ' NoRd ' } }).find(group => group.id === 'display')!.plainRows.find(row => row.key === 'display.theme')!;
  const writes: unknown[] = [];
  const { el } = render(<SettingsField field={field} onCommit={async (...args) => { writes.push(args); }} />);
  expect(trigger(el).textContent).toBe(' NoRd ');
  const options = openOptions(el);
  expect(options.map(option => option.textContent)).toEqual([' NoRd ', ...schema.enumValues!]);
  expect(options.filter(option => option.getAttribute('aria-selected') === 'true').map(option => option.textContent)).toEqual([' NoRd ']);
  expect(writes).toEqual([]);
});

for (const [index, appearance] of THEMES.entries()) {
  const saved = [undefined, 'vaporwave', 'nord', ' NoRd '][index];
  test(`${appearance} browser appearance stays separate from ${JSON.stringify(saved ?? 'fresh')} terminal config`, async () => {
    host = createTerminalThemeHost(saved);
    const browserPreference = JSON.stringify({ theme: appearance, density: 'compact' });
    localStorage.setItem(THEME_PREFERENCES_KEY, browserPreference);
    const { el, client } = render();
    await waitFor(() => Boolean(trigger(el)));
    const current = saved?.trim().toLowerCase() ?? 'goodvibes';
    expect(trigger(el).textContent).toBe(current);
    const options = openOptions(el);
    expect(options.map(option => option.textContent)).toEqual([...schema.enumValues!]);
    expect(options.filter(option => option.getAttribute('aria-selected') === 'true').map(option => option.textContent)).toEqual([current]);
    const nord = options.find(option => option.textContent === 'dracula')!;
    flushSync(() => nord.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await waitFor(() => trigger(el).textContent === 'dracula' && !trigger(el).disabled);
    expect(host.requests.filter(request => request.method === 'POST')).toEqual([{ method: 'POST', body: { key: 'display.theme', value: 'dracula' }, status: 200 }]);
    expect(host.persisted()).toMatchObject({ display: { theme: 'dracula' } });
    expect(el.querySelector('[data-config-key="display.theme"] .settings-field-persisted')?.textContent).toContain(host.settingsPath);
    expect(host.manager.get('display.themeMode')).toBe(saved === undefined ? 'auto' : 'light');
    host.replaceSavedTheme('solarized');
    await client.invalidateQueries({ queryKey: ['config'] });
    await waitFor(() => trigger(el).textContent === 'solarized');
    expect(localStorage.getItem(THEME_PREFERENCES_KEY)).toBe(browserPreference);
    expect(document.documentElement.getAttribute('data-theme')).toBe(appearance);
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });
}

test('a real handler refusal keeps the old enum value and shows an inline error, never a receipt', async () => {
  host = createTerminalThemeHost('vaporwave');
  host.setWriteAccess(false);
  const { el } = render();
  await waitFor(() => Boolean(trigger(el)));
  pick(el, 'dracula');
  await waitFor(() => Boolean(el.querySelector('.settings-field-error')));
  expect(trigger(el).textContent).toBe('vaporwave');
  expect(el.querySelector('.settings-field-error')?.textContent).toContain('Admin role required');
  expect(el.querySelector('[data-config-key="display.theme"] .settings-field-persisted')).toBeNull();
  expect(host.manager.get('display.theme')).toBe('vaporwave');
  expect(host.requests.filter(request => request.method === 'POST').map(request => request.status)).toEqual([403]);
});

test('an unsupported Advanced theme write shows genuine validation feedback without changing the enum', async () => {
  host = createTerminalThemeHost('nord');
  const { el } = render();
  await waitFor(() => Boolean(trigger(el)));
  const key = el.querySelector<HTMLInputElement>('.settings-advanced input')!;
  const value = el.querySelector<HTMLTextAreaElement>('.settings-advanced textarea')!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(key, 'display.theme');
    key.dispatchEvent(new Event('input', { bubbles: true }));
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(value, '"not-a-theme"');
    value.dispatchEvent(new Event('input', { bubbles: true }));
  });
  flushSync(() => el.querySelector('.settings-advanced form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await waitFor(() => Boolean(el.querySelector('.settings-advanced [role="alert"]')));
  expect(el.querySelector('.settings-advanced [role="alert"]')?.textContent).toContain('display.theme');
  expect(host.requests.filter(request => request.method === 'POST').map(request => request.status)).toEqual([400]);
  expect(trigger(el).textContent).toBe('nord');
  expect(host.manager.get('display.theme')).toBe('nord');
  expect(el.querySelector('[data-config-key="display.theme"] .settings-field-persisted')).toBeNull();
});
