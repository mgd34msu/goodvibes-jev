/** Typed shared setting, with genuine daemon config validation and disk persistence. */
import { expect, test } from '@playwright/test';
import { CONFIG_SCHEMA_ENTRIES } from '../src/lib/generated/config-schema';
import { expectNoHorizontalScroll, openSettings } from './support/app';
import { installTerminalThemeDaemon } from './support/terminal-theme-fixture';

test('tree connectors offer canonical choices and retain saved values after browser and config reload', async ({ page }) => {
  const { host } = await installTerminalThemeDaemon(page);
  try {
    const schema = CONFIG_SCHEMA_ENTRIES.find(entry => entry.key === 'display.treeGlyphs');
    expect(schema).toMatchObject({ type: 'enum', default: 'rounded', enumValues: ['rounded', 'square', 'ascii'] });
    const dialog = await openSettings(page, 'general');
    if (await dialog.locator('.settings-pane').count() === 0) {
      await dialog.getByRole('button', { name: 'General', exact: true }).click();
    }
    const field = dialog.locator('[data-config-key="display.treeGlyphs"]');
    const select = field.getByRole('combobox', { name: 'display.treeGlyphs', exact: true });
    await expect(select).toHaveText('rounded');
    await select.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveText(['rounded', 'square', 'ascii']);
    await page.getByRole('listbox').getByRole('option', { name: 'ascii', exact: true }).click();
    await expect(select).toHaveText('ascii');
    await expect(select).toBeEnabled();
    await expect(field.getByRole('status')).toContainText(host.settingsPath);
    expect(host.persisted()).toMatchObject({ display: { treeGlyphs: 'ascii' } });
    host.reload();
    expect(host.manager.get('display.treeGlyphs')).toBe('ascii');
    expect(host.manager.get('display.theme')).toBe('goodvibes');
    await page.reload();
    if (await dialog.locator('.settings-pane').count() === 0) {
      await dialog.getByRole('button', { name: 'General', exact: true }).click();
    }
    await expect(select).toHaveText('ascii');
    await expectNoHorizontalScroll(page);

    const advanced = dialog.locator('.settings-advanced');
    await advanced.getByPlaceholder('settings.path').fill('display.treeGlyphs');
    await advanced.getByPlaceholder('JSON or text').fill('"invented-style"');
    await advanced.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(advanced.getByRole('alert')).toContainText('display.treeGlyphs');
    await expect(select).toHaveText('ascii');
    expect(host.manager.get('display.treeGlyphs')).toBe('ascii');
    expect(host.requests.filter(request => request.method === 'POST')).toEqual([
      { method: 'POST', body: { key: 'display.treeGlyphs', value: 'ascii' }, status: 200 },
      { method: 'POST', body: { key: 'display.treeGlyphs', value: 'invented-style' }, status: 400 },
    ]);
  } finally {
    try { await page.unroute('**/config'); } finally { host.cleanup(); }
  }
});
