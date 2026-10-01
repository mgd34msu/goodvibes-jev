/**
 * Phone smoke: every view renders at 390x844 with no horizontal
 * overflow and a tappable key affordance. Honest bar, a view that can only show an
 * empty/degraded state still must not scroll sideways or hide its primary control.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { only, PHONE, closeNavigation, expectNoHorizontalScroll, expectTappable, openNavigation, openSettings } from './support/app';

test.beforeEach(async ({ page }, testInfo) => {
  only(testInfo, PHONE);
  await installMockDaemon(page);
});

const VIEWS: { view: string; label: string }[] = [
  { view: 'chat', label: 'Chat' },
  { view: 'work', label: 'Work' },
  { view: 'work&tab=sessions', label: 'Work sessions' },
  { view: 'work&tab=processes', label: 'Work processes' },
  { view: 'checkpoints', label: 'Checkpoints (old link)' },
  { view: 'checkin', label: 'Check-ins (old link, opens Settings)' },
  { view: 'library&tab=knowledge', label: 'Knowledge' },
  { view: 'library&tab=memory', label: 'Memory' },
  { view: 'library&tab=review', label: 'Review' },
  { view: 'personal&tab=calendar', label: 'Calendar' },
  { view: 'personal&tab=mail', label: 'Mail' },
  { view: 'personal&tab=occasions', label: 'Occasions' },
];

for (const { view, label } of VIEWS) {
  test(`${label} renders on a phone with no horizontal overflow`, async ({ page }) => {
    await page.goto(`/?view=${view}`);
    await expect(page.locator('.app-shell')).toBeVisible();
    // The view frame mounted with content.
    const frame = page.locator('.view-frame');
    await expect(frame).toBeVisible();
    await expect(frame).not.toBeEmpty();
    // No sideways scroll, the cardinal phone sin.
    await expectNoHorizontalScroll(page);
    // The header's controls (the navigation menu button and new chat) clear the touch
    // floor on every view, chat included: the phone header is always there.
    await expectTappable(page, '.shell-header .gv-icon-button', `${label} header control`);
  });
}

test('Work: the list is usable; refresh is tappable, rows readable and 56 tall', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');
  await expect(page.locator('.dv-page')).toBeVisible();
  await expectTappable(page, '.dv-filters .gv-icon-button', 'work refresh');
  const row = page.locator('.dv-list .gv-row').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(55.5);
  await expectNoHorizontalScroll(page);
});

test('Chat: the composer input and send button are present and tappable', async ({ page }) => {
  await page.goto('/?view=chat');
  await expect(page.locator('.shell-main[data-view="chat"]')).toBeVisible();
  await expectNoHorizontalScroll(page);
  // The chat composer textarea is reachable; the send button clears the touch floor.
  await expect(page.locator('.composer textarea, textarea').first()).toBeVisible();
  await expectTappable(page, '.send-button', 'chat send');
});

test('Settings: every section renders full-screen on a phone with no horizontal overflow', async ({ page }) => {
  for (const section of ['general', 'account', 'devices', 'people', 'models', 'credentials', 'usage', 'voice', 'notifications', 'memory', 'permissions', 'network', 'all', 'about']) {
    const dialog = await openSettings(page, section);
    // General opens on the section list (the phone's first screen); every other
    // link opens straight on its section.
    await expect(dialog.locator(section === 'general' ? '.settings-nav' : '.settings-pane')).not.toBeEmpty();
    await expectNoHorizontalScroll(page);
    // The head's buttons (back to the list, close) clear the touch floor.
    await expectTappable(page, '.settings-pane-head .gv-icon-button', `${section} settings head button`);
  }
});

test('drawer opened on a phone does not trap; the scrim closes it from any view', async ({ page }) => {
  await page.goto('/?view=work');
  await expect(page.locator('.app-shell')).toBeVisible();
  // No permanent rail on a phone: the workspace has the full width.
  await expect(page.locator('.shell-sidebar')).toHaveCount(0);
  await openNavigation(page);
  const drawer = page.getByRole('dialog', { name: 'Navigation' });
  await expect(drawer.getByRole('button', { name: /^Work/ })).toBeVisible();
  // Tap the dimmed strip RIGHT of the open drawer (85% of the width).
  await closeNavigation(page);
  await expectNoHorizontalScroll(page);
});

test('a destination picked in the drawer navigates and closes the drawer', async ({ page }) => {
  await page.goto('/?view=work');
  await openNavigation(page);
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('button', { name: 'Library' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
  await expect(page).toHaveURL(/view=library/);
  // Library's own tabs keep Memory, Knowledge and Review one tap away.
  await expect(page.getByRole('radiogroup', { name: 'Library sections' })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
