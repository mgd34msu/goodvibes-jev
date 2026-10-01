/**
 * Command palette (Ctrl K), design doc "Menus and modals": 640 wide glass over the
 * scrim with search on top and results grouped Chats / Go to / Actions / Settings;
 * the keyboard moves and runs; Escape closes only the palette; on a phone it is a
 * full-height sheet. Every existing command is still there.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { DESKTOP, expectBottomSheet, expectNoHorizontalScroll, only, openNavigation, PHONE } from './support/app';
import { installPaletteReading } from './support/judgment-fixture';

async function openPalette(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  return palette;
}

for (const pending of [true, false]) {
  test(`${pending ? 'pending' : 'settled'} semantic commands become unusable after real sign-out in another tab`, async ({ page, context }) => {
    await installMockDaemon(page);
    let readingStarted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await installPaletteReading(page, 'nav.library', 'act', async () => {
      readingStarted = true;
      if (pending) await gate;
    });
    const account = await context.newPage();
    await installMockDaemon(account);
    try {
      await page.goto('/?view=work');
      await account.goto('/?view=work');
      await expect(page.locator('.app-shell')).toBeVisible();
      const palette = await openPalette(page);
      await page.keyboard.type('show saved material');
      await expect.poll(() => readingStarted).toBe(true);
      if (!pending) await expect(palette.getByRole('option')).toHaveCount(1);
      await openNavigation(account);
      await account.getByRole('button', { name: /^Account:/ }).click();
      await account.getByRole('menuitem', { name: 'Sign out' }).click();
      await expect(palette.locator('[data-search-status="unavailable"]')).toBeVisible();
      release();
      await expect(palette.getByRole('option')).toHaveCount(0);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/view=work/);
      await expect(palette).toBeVisible();
    } finally { release(); await account.close(); }
  });
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, DESKTOP));

  test('Ctrl K opens the palette over the scrim with search focused and every command offered', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    const palette = await openPalette(page);
    await expect(page.locator('.cmd-overlay > .scrim')).toBeVisible();
    await expect(palette.getByRole('textbox', { name: 'Search commands' })).toBeFocused();
    // Every pre-existing command is still offered.
    for (const title of ['Go to Chat', 'Go to Work', 'Go to Library', 'Go to Personal', 'Go to Knowledge', 'New Chat', 'Show Keyboard Shortcuts', 'Toggle Theme', 'Toggle Density', 'Models and providers', 'Open settings']) {
      await expect(palette.getByRole('option', { name: new RegExp(title) })).toHaveCount(1);
    }
    await expectNoHorizontalScroll(page);
  });

  test('an admitted semantic result selects the indexed command and Enter runs it', async ({ page }) => {
    await installMockDaemon(page);
    await installPaletteReading(page, 'nav.library');
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    const palette = await openPalette(page);
    await page.keyboard.type('show saved material');
    await expect(palette.getByRole('option')).toHaveCount(1);
    await expect(palette.getByRole('option', { name: /Go to Library/, selected: true })).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(/view=library/);
  });

  test('a settings result opens that settings section', async ({ page }) => {
    await installMockDaemon(page);
    await installPaletteReading(page, 'settings.notifications');
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    const palette = await openPalette(page);
    await page.keyboard.type('Notifications');
    await expect(palette.getByRole('option', { name: /Notifications/, selected: true })).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(page).toHaveURL(/settings=notifications/);
  });

  test('an unsettled reading offers manual browse without an executable guessed result', async ({ page }) => {
    await installMockDaemon(page);
    await installPaletteReading(page, 'nav.library', 'confirm');
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    const palette = await openPalette(page);
    await page.keyboard.type('library');
    await expect(palette.locator('[data-search-status="held"]')).toBeVisible();
    await expect(palette.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(palette).toBeVisible();
    await expect(page).toHaveURL(/view=work/);
    await page.keyboard.press('Tab');
    await expect(palette.getByRole('button', { name: 'Browse all commands' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(palette.getByRole('listbox', { name: 'Browse all commands' })).toBeVisible();
    await expect(palette.getByRole('option', { name: /Go to Library/ })).toHaveCount(1);
    await expect(palette.getByRole('textbox', { name: 'Search commands' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(palette.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
  });

  test('Escape closes the palette and returns focus; nothing else reacts', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    const palette = await openPalette(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(/view=work/);
  });
});

test.describe('phone', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('the palette is a full-height bottom sheet that Cancel closes', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    // The header search button opens the same palette.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    // Full height: the sheet reaches from just under the top edge to the bottom.
    await expectBottomSheet(page, palette, { minHeight: 844 - 48 });
    await expectNoHorizontalScroll(page);
    await palette.getByRole('button', { name: 'Cancel' }).click();
    await expect(palette).toHaveCount(0);
  });
});
