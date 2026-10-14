/** Strict editable references, with genuine daemon validation and disk persistence. */
import { expect, test } from '@playwright/test';
import type { JudgmentFallbackSettings } from '@goodvibes-jev/engine/sdk/platform/config';
import { parseBrowserJudgmentRequest } from '@goodvibes-jev/engine/daemon-sdk';
import { expectNoHorizontalScroll, openSettings } from './support/app';
import { installTerminalThemeDaemon } from './support/terminal-theme-fixture';

test('fallback-reference arrays save and reload without exposing inline credentials', async ({ page }) => {
  const daemon = await installTerminalThemeDaemon(page);
  const { host } = daemon;
  const original = [
    { endpoint: 'https://first.example.test/v1', model: 'jev-latest', keySource: 'env', keyName: 'FIRST_JEV_KEY' },
    { endpoint: 'https://second.example.test', model: 'jev-latest', keySource: 'secret', keyName: 'judgment/second-key' },
  ] satisfies JudgmentFallbackSettings[];
  const replacement = [
    { endpoint: 'https://backup.example.test/v1', model: 'jev-latest', keySource: 'secret', keyName: 'judgment/backup-key' },
    { endpoint: 'https://last.example.test', model: 'jev-latest', keySource: 'env', keyName: 'LAST_JEV_KEY' },
  ] satisfies JudgmentFallbackSettings[];
  try {
    host.manager.set('judgment.fallbacks', original);
    host.reload();
    const dialog = await openSettings(page, 'all');
    const field = dialog.locator('[data-config-key="judgment.fallbacks"]');
    const editor = field.getByRole('textbox', { name: 'judgment.fallbacks', exact: true });
    await expect(editor).toHaveValue(JSON.stringify(original, null, 2));
    await editor.fill(JSON.stringify(replacement, null, 2));
    await field.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(field.getByRole('status')).toContainText(host.settingsPath);
    expect(host.persisted()).toMatchObject({ judgment: { fallbacks: replacement } });
    host.reload();
    expect(host.manager.get('judgment.fallbacks')).toEqual(replacement);
    await page.reload();
    await expect(editor).toHaveValue(JSON.stringify(replacement, null, 2));
    await expectNoHorizontalScroll(page);

    const malformed = [{ ...replacement[0], apiKey: 'synthetic-inline-private-value' }];
    await editor.fill(JSON.stringify(malformed));
    await field.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(field.getByRole('alert')).toHaveText('Value must be a valid fallback-reference array.');
    expect(host.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(host.manager.get('judgment.fallbacks')).toEqual(replacement);

    // The escape hatch reaches genuine server validation rather than admitting
    // an inline credential through a second write path.
    const advanced = dialog.locator('.settings-advanced');
    await advanced.getByPlaceholder('settings.path').fill('judgment.fallbacks');
    await advanced.getByPlaceholder('JSON or text').fill(JSON.stringify(malformed));
    await advanced.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(advanced.getByRole('alert')).toContainText('judgment.fallbacks');
    expect(host.manager.get('judgment.fallbacks')).toEqual(replacement);
    expect(host.persisted()).toMatchObject({ judgment: { fallbacks: replacement } });
    expect(host.requests.filter(request => request.method === 'POST')).toEqual([
      { method: 'POST', body: { key: 'judgment.fallbacks', value: replacement }, status: 200 },
      { method: 'POST', body: { key: 'judgment.fallbacks', value: malformed }, status: 400 },
    ]);
    for (const request of daemon.requests.filter(request => request.path === '/api/judgment/batteries/run')) {
      const reading = parseBrowserJudgmentRequest(request.body);
      if (reading.battery !== 'webui.config.credential-key' && reading.battery !== 'webui.settings.card-material-key') continue;
      expect(reading.input.keys).not.toContain('judgment.fallbacks');
      expect(reading.input.keys.some(key => key.startsWith('judgment.fallbacks.'))).toBe(false);
      expect(JSON.stringify(reading.input)).not.toContain('judgment/backup-key');
      expect(JSON.stringify(reading.input)).not.toContain('synthetic-inline-private-value');
    }
  } finally {
    try { await page.unroute('**/config'); } finally { host.cleanup(); }
  }
});
