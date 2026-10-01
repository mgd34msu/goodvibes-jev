/**
 * Touch-target audit: every interactive control on the phone hero journey
 * clears a 44px floor, measured from the RENDERED box (not the source). The session
 * delete is reachable without hover.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { STEERABLE_SESSION } from './support/seed';
import { only, PHONE, expectTappable, openNavigation } from './support/app';

test.beforeEach(async ({ page }, testInfo) => {
  only(testInfo, PHONE);
  await installMockDaemon(page);
});

test('every control on the steer-from-phone journey is >=44px', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');
  await expect(page.locator('.app-shell')).toBeVisible();

  // Header controls: the navigation menu button (it opens the drawer) and new chat.
  await expectTappable(page, '.shell-header .gv-icon-button', 'header menu button');
  await expectTappable(page, '.shell-header .gv-icon-button >> nth=-1', 'header new chat');

  // Drawer nav items, the tap that opens a view.
  await openNavigation(page);
  await expectTappable(page, '.shell-drawer .shell-nav-item', 'drawer nav item');
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: /^Work/ }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();

  // Work: the kind filter, refresh and the rows themselves.
  await expectTappable(page, '.dv-filters .gv-segmented__item', 'work kind filter');
  await expectTappable(page, '.dv-filters .gv-icon-button', 'work refresh');
  await expectTappable(page, '.dv-list .gv-row', 'work row');

  // Open a session → steer controls.
  await page.locator('.dv-list .gv-row__main', { hasText: STEERABLE_SESSION.title }).first().click();
  await expect(page.getByRole('list', { name: 'Transcript' })).toBeVisible();

  await expectTappable(page, '.dv-detail__back .gv-button', 'back to all work');
  await expectTappable(page, '.steer-composer__input', 'steer input');
  await expectTappable(page, '.steer-composer__send', 'steer send');
});

test('the chat delete is touch-reachable (not hover-only) in the Recent list', async ({ page }) => {
  await page.goto('/?view=chat');
  await expect(page.locator('.shell-main[data-view="chat"]')).toBeVisible();
  // Open the drawer so the Recent chat list (with its per-row delete) is visible.
  await openNavigation(page);

  // The mock seeds two chats (mock-daemon.ts companionChatSessions), so a missing
  // delete control is a failure here, never a reason to skip.
  const del = page.locator('.shell-drawer .shell-recent__delete').first();
  await expect(del).toBeVisible();
  // Reachable means: rendered, non-zero opacity (not the hover-only opacity:0), 44px.
  const opacity = await del.evaluate((el) => getComputedStyle(el).opacity);
  expect(Number(opacity)).toBeGreaterThan(0.5);
  await expectTappable(page, '.shell-drawer .shell-recent__delete', 'chat delete');
});

test('nav labels are legible in the open drawer, no mid-word truncation', async ({ page }) => {
  await page.goto('/?view=work');
  await openNavigation(page);

  // Every nav label renders its full text without an ellipsis clip (scrollWidth fits).
  const clipped = await page.locator('.shell-drawer .shell-nav .shell-nav-item__label').evaluateAll((els) =>
    els
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent),
  );
  expect(clipped, `truncated nav labels: ${clipped.join(', ')}`).toEqual([]);
});
