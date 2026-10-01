/**
 * Command palette (Ctrl K), design doc "Menus and modals": 640 wide glass over the
 * scrim with search on top and results grouped Chats / Go to / Actions / Settings;
 * the keyboard moves and runs; Escape closes only the palette; on a phone it is a
 * full-height sheet. Every existing command is still there.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { DESKTOP, expectBottomSheet, expectNoHorizontalScroll, only, PHONE } from './support/app';

async function openPalette(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  return palette;
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

  test('typing filters; arrows move; Enter runs the command and closes', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    const palette = await openPalette(page);
    await page.keyboard.type('go to libr');
    await expect(palette.getByRole('option')).toHaveCount(1);
    await expect(palette.getByRole('option', { name: /Go to Library/, selected: true })).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(/view=library/);
  });

  test('a settings result opens that settings section', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    const palette = await openPalette(page);
    await page.keyboard.type('Notifications');
    await expect(palette.getByRole('option', { name: /Notifications/, selected: true })).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await expect(page).toHaveURL(/settings=notifications/);
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
