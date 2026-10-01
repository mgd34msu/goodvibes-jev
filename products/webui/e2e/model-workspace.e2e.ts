/**
 * Model Workspace, the multi-target model picker (main/helper/tool/tts/
 * embeddings) launched from the "Change" button beside the current model in
 * Settings, Models and providers. Runs on
 * BOTH phone and desktop (no `only()` gate): the modal must be usable at
 * either width, per the honest-bar (no horizontal scroll, no broken control).
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon, type MockDaemon } from './support/mock-daemon';
import type { Locator, Page } from '@playwright/test';
import { expectNoHorizontalScroll, only, openSettings, PHONE, expectBottomSheet } from './support/app';

/**
 * Pick a routing target: a segmented radio on desktop, a select on a phone
 * (five targets do not fit one segmented row at 390 wide).
 */
async function pickTarget(page: Page, dialog: Locator, label: string): Promise<void> {
  const radio = dialog.getByRole('radio', { name: label });
  if (await radio.count()) {
    await radio.click();
    return;
  }
  await dialog.getByRole('combobox', { name: 'Model routing target' }).click();
  await page.getByRole('option', { name: label }).click();
}

let daemon: MockDaemon;

test.beforeEach(async ({ page }) => {
  daemon = await installMockDaemon(page);
  const settings = await openSettings(page, 'models');
  await expect(settings.getByTestId('current-model')).toBeVisible();
});

test.describe('phone: the dialog is a full-width bottom sheet (MOBILE-ADAPT)', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('the panel is a tall bottom sheet instead of floating as a centered card', async ({ page }) => {
    await page.getByRole('button', { name: 'Change model' }).click();
    const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
    await expect(dialog).toBeVisible();
    // A phone dialog is a bottom sheet: full width on the bottom edge, and this
    // one's content makes it as tall as a sheet gets (32 short of the top).
    await expectBottomSheet(page, dialog, { minHeight: 844 - 32 - 1 });
    await expectNoHorizontalScroll(page);
  });
});

test('opens from the "Change model" launcher and shows all five TUI-parity targets', async ({ page }) => {
  await page.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
  await expect(dialog).toBeVisible();
  const labels = ['Main Chat', 'Helper Model', 'Tool LLM', 'TTS LLM', 'Embeddings'];
  if (await dialog.getByRole('radio').count()) {
    for (const label of labels) await expect(dialog.getByRole('radio', { name: label })).toBeVisible();
  } else {
    await dialog.getByRole('combobox', { name: 'Model routing target' }).click();
    for (const label of labels) await expect(page.getByRole('option', { name: label })).toBeVisible();
    await page.getByRole('option', { name: 'Main Chat' }).click();
  }
  await expectNoHorizontalScroll(page);
});

test('Escape closes the workspace and leaves the settings dialog open underneath', async ({ page }) => {
  await page.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
});

test('the price filter is enabled because the catalog carries tier data', async ({ page }) => {
  await page.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
  await expect(dialog.locator('.model-workspace-row', { hasText: 'gpt-5' }).first()).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Price' })).toBeEnabled();
});

test('the capability filter is disabled because the catalog carries no capability data', async ({ page }) => {
  await page.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
  await expect(dialog.locator('.model-workspace-row').first()).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Capability' })).toBeDisabled();
});

const configWrites = (daemon: MockDaemon) => daemon.requests
  .filter((r) => r.method === 'POST' && r.path === '/config')
  .map((r) => r.body as { key: string; value: unknown });
const modelSelects = (daemon: MockDaemon) => daemon.requests
  .filter((r) => r.method === 'PATCH' && r.path === '/api/models/current')
  .map((r) => (r.body as { registryKey?: string }).registryKey);

test('main target: Use on GPT-5 sets the current model and marks that row current', async ({ page }) => {
  await page.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
  const gptRow = dialog.locator('.model-workspace-row', { hasText: 'gpt-5' });
  await gptRow.getByRole('button', { name: 'Use' }).click();
  await expect.poll(() => modelSelects(daemon)).toEqual([expect.stringMatching(/:gpt-5$/)]);
  expect(configWrites(daemon)).toHaveLength(0);
  await expect(gptRow.getByRole('button', { name: 'Current' })).toBeVisible();
});

test('helper target: selecting a model routes through config.set, not models.select; the main selection is untouched', async ({ page }) => {
  await page.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
  await pickTarget(page, dialog, 'Helper Model');
  const gptRow = dialog.locator('.model-workspace-row', { hasText: 'gpt-5' });
  await gptRow.getByRole('button', { name: 'Use' }).click();
  await expect.poll(() => configWrites(daemon)).toEqual([
    { key: 'helper.globalProvider', value: 'openai' },
    { key: 'helper.globalModel', value: 'gpt-5' },
    { key: 'helper.enabled', value: true },
  ]);
  // The main selection is untouched: no models.select went out.
  expect(modelSelects(daemon)).toHaveLength(0);
});

test('embeddings target has no model concept; lists providers only, "Use" writes the provider id alone', async ({ page }) => {
  await page.getByRole('button', { name: 'Change model' }).click();
  const dialog = page.getByRole('dialog', { name: 'Model Workspace' });
  await pickTarget(page, dialog, 'Embeddings');
  const openaiRow = dialog.locator('.model-workspace-row', { hasText: 'openai' });
  await openaiRow.getByRole('button', { name: 'Use' }).click();
  await expect.poll(() => configWrites(daemon)).toEqual([{ key: 'provider.embeddingProvider', value: 'openai' }]);
  expect(modelSelects(daemon)).toHaveLength(0);
  await expect(openaiRow.getByRole('button', { name: 'Current' })).toBeVisible();
});
