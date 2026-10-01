/**
 * Viewport-locked shell invariants, proven in a real browser: the PAGE never
 * scrolls; the account avatar tracks the connection and its menu works from the
 * keyboard; the brand wordmark is never clipped; and on desktop the sidebar folds
 * to its rail while a right-side detail is open, then restores.
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { installMockDaemon } from './support/mock-daemon';
import { DESKTOP, nextFrames, only, openNavigation } from './support/app';

test('the page never scrolls: every pane owns its own overflow', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=work');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.view-frame')).not.toBeEmpty();
  await expect(page.locator('.dv-list')).toBeVisible();

  const m = await page.evaluate(() => ({
    docScrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  // The document is exactly one viewport tall; body scroll is impossible.
  expect(m.docScrollHeight).toBe(m.innerHeight);

  await page.mouse.wheel(0, 2000);
  await nextFrames(page);
  expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
});

test('the avatar reflects the live connection, and the account menu opens and closes from the keyboard', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=work');
  await expect(page.locator('.app-shell')).toBeVisible();

  await openNavigation(page);
  const account = page.getByRole('button', { name: /^Account: / });
  await expect(account).toBeVisible();
  // The avatar's dot carries the connection state (green once the probe answers).
  await expect(page.locator('.shell-avatar').first()).toHaveAttribute('data-tone', 'ok');
  await account.click();
  const menu = page.getByRole('menu', { name: 'Account' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toBeVisible();
  await expect(menu.getByRole('menuitemcheckbox', { name: /GoodVibes Neon/ })).toBeVisible();
  // Escape closes the menu and returns focus to the account button.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(account).toBeFocused();
});

test('in chat only the transcript scrolls and the composer stays pinned', async ({ page }) => {
  const daemon = await installChatMockDaemon(page);
  await page.goto('/?view=chat');
  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toBeVisible();
  void daemon;

  const before = await composer.evaluate((el) => el.getBoundingClientRect().top);
  // Whatever the transcript holds, scrolling the document must be a no-op and
  // the composer must not move.
  await page.mouse.wheel(0, 2000);
  await nextFrames(page);
  const after = await page.evaluate(() => ({
    docScrollTop: document.documentElement.scrollTop,
    composerTop: document.querySelector('textarea[aria-label="Message GoodVibes"]')!.getBoundingClientRect().top,
  }));
  expect(after.docScrollTop).toBe(0);
  expect(Math.round(after.composerTop)).toBe(Math.round(before));
});

test('the brand wordmark is never clipped', async ({ page }) => {
  await installChatMockDaemon(page);
  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await openNavigation(page);
  const brand = page.locator('.shell-brand__word').first();
  await expect(brand).toBeVisible();
  const m = await brand.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  // No overflow means no visual truncation is even possible.
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
});

/** A right-side detail: a memory record in Library's list and detail split. */
async function openMemoryDetail(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.dv-list .gv-row__main').first().click();
  await expect(page.locator('.dv-detail')).toBeVisible();
}

test.describe('sidebar auto-collapse (desktop)', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    only(testInfo, DESKTOP);
  });

  test('a right-side detail folds the sidebar to the rail; closing it restores the sidebar', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=library&tab=memory');
    const sidebar = page.locator('.shell-sidebar');
    await expect(sidebar).toHaveAttribute('data-form', 'expanded');
    const width = () => sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const expandedWidth = await width();

    await openMemoryDetail(page);
    await expect(sidebar).toHaveAttribute('data-form', 'rail');
    // The rail genuinely gives the width back to the content once the change settles.
    await expect.poll(width).toBeLessThan(expandedWidth / 2);
    // The rail keeps every destination one click away, each named for a screen reader.
    // (Work's name carries its needs-you count, "Work, 3 need you", hence the prefix match.)
    for (const name of ['New chat', 'Search', 'Work', 'Library', 'Personal']) {
      await expect(sidebar.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
    }

    await page.keyboard.press('Escape');
    await expect(sidebar).toHaveAttribute('data-form', 'expanded');
    await expect.poll(width).toBe(expandedWidth);
  });

  test('a sidebar the person collapsed stays collapsed after the detail closes', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=library&tab=memory');
    const sidebar = page.locator('.shell-sidebar');
    await sidebar.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(sidebar).toHaveAttribute('data-form', 'rail');

    await openMemoryDetail(page);
    await expect(sidebar).toHaveAttribute('data-form', 'rail');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dv-detail')).toHaveCount(0);
    await expect(sidebar).toHaveAttribute('data-form', 'rail');
  });

  test('a pinned sidebar does not auto-collapse at 1280 wide', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=library&tab=memory');
    const sidebar = page.locator('.shell-sidebar');
    await sidebar.getByRole('button', { name: 'Pin sidebar open' }).click();
    await openMemoryDetail(page);
    await expect(page.locator('.dv-detail')).toBeVisible();
    await expect(sidebar).toHaveAttribute('data-form', 'expanded');
  });

  test('Ctrl B shows the full sidebar over the content while a detail holds the rail', async ({ page }) => {
    await installMockDaemon(page);
    await page.goto('/?view=library&tab=memory');
    const sidebar = page.locator('.shell-sidebar');
    await openMemoryDetail(page);
    await expect(sidebar).toHaveAttribute('data-form', 'rail');
    const slot = page.locator('.shell-sidebar-slot');
    const slotWidth = () => slot.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const sidebarWidth = () => sidebar.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    // The layout column follows the rail once, after the sidebar's own collapse
    // animation; wait for it to settle before measuring.
    await expect.poll(async () => (await slotWidth()) === (await sidebarWidth()) && (await slotWidth()) < 260).toBe(true);
    const railWidth = await slotWidth();

    await page.keyboard.press('Control+b');
    await expect(sidebar).toHaveAttribute('data-form', 'peek');
    // Peek shows the full sidebar over the content: the sidebar grows past the
    // rail while the layout column keeps the rail's width, so nothing is pushed.
    await expect.poll(sidebarWidth).toBe(260);
    expect(await slotWidth()).toBe(railWidth);
  });
});
