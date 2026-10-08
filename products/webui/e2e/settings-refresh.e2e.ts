import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { configGetResponse } from './support/seed';
import { openSettings, expectNoHorizontalScroll } from './support/app';

/** Mutable config endpoint with a held refetch; every other route stays hermetic. */
async function configHarness(page: Page) {
  const daemon = await installMockDaemon(page);
  const config: Record<string, unknown> = {
    ...configGetResponse(),
    display: { theme: 'vaporwave', stream: true, collapseThreshold: 30 },
    provider: { ...configGetResponse().provider, systemPromptFile: 'initial.md' },
    payments: { currency: 'USD', budget: { dailyItem: 100 } },
  };
  function set(key: string, value: unknown): void {
    const parts = key.split('.');
    let parent = config;
    for (const part of parts.slice(0, -1)) {
      const child = parent[part];
      if (!child || typeof child !== 'object' || Array.isArray(child)) parent[part] = {};
      parent = parent[part] as Record<string, unknown>;
    }
    const leaf = parts.at(-1);
    if (!leaf) throw new Error('Config key must not be empty');
    parent[leaf] = value;
  }
  let hold: Promise<void> | undefined;
  let held = false;
  await page.route('**/config', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { key: string; value: unknown };
      set(body.key, body.value);
      await route.fulfill({ json: { success: true, ...body } });
      return;
    }
    if (hold) {
      held = true;
      await hold;
      hold = undefined;
    }
    await route.fulfill({ json: config });
  });
  return {
    set,
    writes: (key: string) => daemon.requests
      .filter((request) => request.method === 'POST' && request.path === '/config')
      .map((request) => request.body as { key: string; value: unknown })
      .filter((request) => request.key === key)
      .map((request) => request.value),
    holdRefetch: () => {
      held = false;
      let release!: () => void;
      hold = new Promise<void>((resolve) => { release = resolve; });
      return { release, started: () => held };
    },
  };
}

for (const fixture of [
  { name: 'string', key: 'provider.systemPromptFile', section: 'models', page: 'Models and providers', initial: 'initial.md', latest: 'remote.md', edit: 'mine.md', value: 'mine.md', trigger: 'payments.budget.dailyItem' },
  { name: 'number', key: 'display.collapseThreshold', section: 'general', page: 'General', initial: '30', latest: 50, edit: '42', value: 42, trigger: 'display.stream' },
  { name: 'money', key: 'payments.budget.dailyItem', section: 'usage', page: 'Models and providers', initial: '100', latest: 200, edit: '$150', value: 150, trigger: 'provider.systemPromptFile' },
]) {
  async function open(page: Page) {
    const dialog = await openSettings(page, fixture.section);
    if (await dialog.locator('.settings-pane').count() === 0) {
      await dialog.getByRole('button', { name: fixture.page, exact: true }).click();
    }
    const row = dialog.locator(`[data-config-key="${fixture.key}"]`);
    const input = row.locator('input');
    await expect(input).toHaveValue(fixture.initial);
    return { dialog, row, input };
  }
  async function saveSibling(page: Page): Promise<void> {
    const row = page.locator(`[data-config-key="${fixture.trigger}"]`);
    if (fixture.trigger === 'display.stream') {
      await row.getByRole('switch').click();
    } else {
      await row.locator('input').fill(fixture.trigger.startsWith('payments.') ? '123' : 'refresh.md');
      await row.locator('input').blur();
    }
  }

  test(`${fixture.name}: config refetch updates an untouched mounted field without writing it`, async ({ page }) => {
    const server = await configHarness(page);
    const { input } = await open(page);
    server.set(fixture.key, fixture.latest);
    await saveSibling(page);
    await expect(input).toHaveValue(String(fixture.latest));
    await input.focus();
    await input.blur();
    await input.focus();
    await input.press('Enter');
    expect(server.writes(fixture.key)).toEqual([]);
    await expectNoHorizontalScroll(page);
  });

  test(`${fixture.name}: refresh during editing requires explicit choice and cancel never writes`, async ({ page }, testInfo) => {
    const server = await configHarness(page);
    const { dialog, row, input } = await open(page);
    const refresh = server.holdRefetch();
    await saveSibling(page);
    await expect.poll(refresh.started).toBe(true);
    await input.fill(fixture.edit);
    server.set(fixture.key, fixture.latest);
    refresh.release();
    await expect(row.getByRole('alert')).toContainText('This setting changed elsewhere');
    await expect(input).toHaveValue(fixture.edit);
    await expectNoHorizontalScroll(page);
    await testInfo.attach(`${fixture.name}-refresh-conflict`, {
      body: await page.screenshot(), contentType: 'image/png',
    });
    await input.blur();
    expect(server.writes(fixture.key)).toEqual([]);
    await row.getByRole('button', { name: 'Use latest' }).click();
    await expect(input).toHaveValue(String(fixture.latest));
    await input.fill(fixture.edit);
    await input.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(input).toHaveValue(String(fixture.latest));
    await input.blur();
    expect(server.writes(fixture.key)).toEqual([]);
    await input.fill(fixture.edit);
    await input.press('Enter');
    await expect.poll(() => server.writes(fixture.key)).toEqual([fixture.value]);
    await expect(input).toBeEnabled();
    await input.focus();
    await input.blur();
    expect(server.writes(fixture.key)).toEqual([fixture.value]);
    await expectNoHorizontalScroll(page);
    await input.focus();
    await input.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page).not.toHaveURL(/settings=/);
  });

  test(`${fixture.name}: Save my edit explicitly replaces a conflicting refreshed value once`, async ({ page }) => {
    const server = await configHarness(page);
    const { row, input } = await open(page);
    const refresh = server.holdRefetch();
    await saveSibling(page);
    await expect.poll(refresh.started).toBe(true);
    await input.fill(fixture.edit);
    server.set(fixture.key, fixture.latest);
    refresh.release();
    await expect(row.getByRole('alert')).toContainText('This setting changed elsewhere');
    await input.blur();
    expect(server.writes(fixture.key)).toEqual([]);
    await row.getByRole('button', { name: 'Save my edit' }).click();
    await expect.poll(() => server.writes(fixture.key)).toEqual([fixture.value]);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue(String(fixture.value));
    await expect(row.getByRole('alert')).toHaveCount(0);
    await input.focus();
    await input.press('Enter');
    expect(server.writes(fixture.key)).toEqual([fixture.value]);
  });

}
