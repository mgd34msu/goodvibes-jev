/** Typed terminal config through the production WebUI and real on-disk route host. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CONFIG_SCHEMA_ENTRIES } from '../src/lib/generated/config-schema';
import { THEMES, THEME_PREFERENCES_KEY } from '../src/lib/theme';
import { expectNoHorizontalScroll, openNavigation, openSettings } from './support/app';
import { installTerminalThemeDaemon } from './support/terminal-theme-fixture';

const schema = CONFIG_SCHEMA_ENTRIES.find(entry => entry.key === 'display.theme');
if (!schema) throw new Error('Generated display.theme metadata is missing');
const themeOptions = schema.enumValues ?? [];
async function general(page: Page): Promise<Locator> {
  const dialog = await openSettings(page, 'general');
  if (await dialog.locator('.settings-pane').count() === 0) {
    await dialog.getByRole('button', { name: 'General', exact: true }).click();
  }
  await expect(dialog.locator('.settings-pane')).toBeVisible();
  return dialog;
}
function terminalTheme(dialog: Locator) { return dialog.locator('[data-config-key="display.theme"]'); }
async function pick(page: Page, trigger: Locator, value: string) {
  await trigger.click();
  await page.getByRole('listbox').getByRole('option', { name: value, exact: true }).click();
}
async function close(page: Page) {
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
  await expect(page).not.toHaveURL(/settings=/);
}

for (const [index, appearance] of THEMES.entries()) {
  const saved = [undefined, 'vaporwave', 'nord', ' NoRd '][index];
  test(`${appearance} browser appearance: ${JSON.stringify(saved ?? 'fresh default')} terminal theme selects, persists and settles`, async ({ page }) => {
    const { host } = await installTerminalThemeDaemon(page, saved);
    try {
      const preference = JSON.stringify({ theme: appearance, density: 'compact' });
      await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: THEME_PREFERENCES_KEY, value: preference });
      let dialog = await general(page);
      let field = terminalTheme(dialog);
      let select = field.getByRole('combobox', { name: 'display.theme', exact: true });
      const currentTheme = saved?.trim().toLowerCase() ?? 'goodvibes';
      await expect(select).toHaveText(currentTheme);
      await expect(field).toHaveAttribute('data-daemon-owned', 'false');
      await expect(field.locator('input')).toHaveCount(0);
      await expect(dialog.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio')).toHaveText(['Light', 'Dark', 'Auto']);
      await expect(dialog.getByRole('switch', { name: 'GoodVibes Neon', exact: true })).toHaveAttribute('aria-checked', String(appearance === 'neon'));
      expect(schema.type).toBe('enum');
      expect(schema.default).toBe('goodvibes');
      expect(schema.enumValues).toHaveLength(13);
      await select.click();
      const options = page.getByRole('listbox').getByRole('option');
      const expected = themeOptions;
      await expect.poll(() => options.evaluateAll(items => items.map(item => item.textContent))).toEqual(expected);
      const current = options.and(page.locator('[aria-selected="true"]'));
      await expect(current).toHaveCount(1);
      await expect(current).toHaveJSProperty('textContent', currentTheme);
      expect(host.requests.filter(request => request.method === 'POST')).toEqual([]);
      await page.getByRole('listbox').getByRole('option', { name: 'dracula', exact: true }).click();
      await expect(select).toHaveText('dracula');
      await expect(select).toBeEnabled();
      await expect(field.getByRole('status')).toContainText(host.settingsPath);
      expect(host.requests.filter(request => request.method === 'POST')).toEqual([{ method: 'POST', body: { key: 'display.theme', value: 'dracula' }, status: 200 }]);
      host.reload();
      expect(host.manager.get('display.theme')).toBe('dracula');
      expect(host.persisted()).toMatchObject({ display: { theme: 'dracula' } });
      expect(host.manager.get('display.themeMode')).toBe(saved === undefined ? 'auto' : 'light');
      expect(host.siblingTheme()).toBe('goodvibes');
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
      expect(await page.evaluate(key => localStorage.getItem(key), THEME_PREFERENCES_KEY)).toBe(preference);
      await expectNoHorizontalScroll(page);
      await test.info().attach(`${test.info().project.name}-${appearance}-terminal-theme`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

      // These are settled navigation cases only. No claim about pending-write
      // Close/Account reconciliation is made by this theme metadata regression.
      await close(page);
      await openNavigation(page);
      await page.getByRole('button', { name: /^Account: / }).click();
      await page.getByRole('menu', { name: 'Account' }).getByRole('menuitem', { name: /^Settings/ }).click();
      dialog = page.getByRole('dialog', { name: 'Settings' });
      if (await dialog.locator('.settings-pane').count() === 0) await dialog.getByRole('button', { name: 'General', exact: true }).click();
      await expect(terminalTheme(dialog).getByRole('combobox', { name: 'display.theme', exact: true })).toHaveText('dracula');
      const back = dialog.getByRole('button', { name: 'Back to settings' });
      if (await back.isVisible()) await back.click();
      await dialog.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Account', exact: true }).click();
      await expect(page).toHaveURL(/settings=account/);
      await expect(dialog.getByRole('region', { name: 'Current sign-in' })).toBeVisible();
      await close(page);

      // Prove authoritative reload with a real external edit, not a receipt echo.
      host.replaceSavedTheme('solarized');
      dialog = await general(page);
      await page.reload();
      dialog = page.getByRole('dialog', { name: 'Settings' });
      if (await dialog.locator('.settings-pane').count() === 0) await dialog.getByRole('button', { name: 'General', exact: true }).click();
      field = terminalTheme(dialog);
      select = field.getByRole('combobox', { name: 'display.theme', exact: true });
      await expect(select).toHaveText('solarized');
      await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
      expect(await page.evaluate(key => localStorage.getItem(key), THEME_PREFERENCES_KEY)).toBe(preference);
      expect(host.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    } finally {
      try { await page.unroute('**/config'); } finally { host.cleanup(); }
    }
  });
}

test('real theme validation rejects Advanced garbage, and a refused enum save keeps its current selection', async ({ page }) => {
  const { host } = await installTerminalThemeDaemon(page, 'vaporwave');
  try {
    const dialog = await general(page);
    const field = terminalTheme(dialog);
    const select = field.getByRole('combobox', { name: 'display.theme', exact: true });
    const advanced = dialog.locator('.settings-advanced');
    await advanced.getByPlaceholder('settings.path').fill('display.theme');
    await advanced.getByPlaceholder('JSON or text').fill('"not-a-theme"');
    await advanced.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(advanced.getByRole('alert')).toContainText('display.theme');
    await expect(select).toHaveText('vaporwave');
    expect(host.requests.filter(request => request.method === 'POST').map(request => request.status)).toEqual([400]);
    expect(host.manager.get('display.theme')).toBe('vaporwave');
    host.setWriteAccess(false);
    await pick(page, select, 'dracula');
    await expect(field.getByRole('alert')).toBeVisible();
    await expect(select).toHaveText('vaporwave');
    await expect(field.getByRole('status')).toHaveCount(0);
    expect(host.requests.filter(request => request.method === 'POST').map(request => request.status)).toEqual([400, 403]);
    host.reload();
    expect(host.manager.get('display.theme')).toBe('vaporwave');
    await expectNoHorizontalScroll(page);
  } finally {
    try { await page.unroute('**/config'); } finally { host.cleanup(); }
  }
});
