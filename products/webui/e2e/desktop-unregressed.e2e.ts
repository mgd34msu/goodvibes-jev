/**
 * Desktop unregressed: the responsive changes are phone-scoped. At 1280px the
 * sidebar is expanded (no drawer, no scrim), the Sessions list and detail sit
 * side-by-side (no master-detail collapse, no phone back button), and the steer
 * still sends.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon, type MockDaemon } from './support/mock-daemon';
import { STEERABLE_SESSION } from './support/seed';
import { only, DESKTOP, detailPane, expectNoHorizontalScroll, openRow } from './support/app';

let daemon: MockDaemon;

test.beforeEach(async ({ page }, testInfo) => {
  only(testInfo, DESKTOP);
  daemon = await installMockDaemon(page, { approvals: [] });
});

test('the sidebar is expanded on desktop, with no phone drawer', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.shell-sidebar[data-form="expanded"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Open navigation/ })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('Work shows list and detail side by side, no phone back button, and the rail while the detail is open', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');
  await openRow(page, STEERABLE_SESSION.title);

  // Both panes visible together on desktop.
  await expect(page.locator('.dv-list')).toBeVisible();
  await expect(detailPane(page).getByRole('list', { name: 'Transcript' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All work' })).toHaveCount(0);
  // The detail is a large right panel: the sidebar folds to its rail.
  await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar', 'rail');
});

test('steer still sends on desktop', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');
  const detail = await openRow(page, STEERABLE_SESSION.title);
  const input = detail.getByRole('textbox', { name: 'Steer message' });
  await input.fill('Desktop steer path still works');
  await input.press('Enter');
  await expect.poll(() => daemon.steerRequests
    .filter((r) => r.sessionId === STEERABLE_SESSION.id)
    .some((r) => JSON.stringify(r.body).includes('Desktop steer path still works')), { timeout: 10_000 }).toBe(true);
});

test('Work filters by kind with its own segmented control, and the tab rides the URL', async ({ page }) => {
  await page.goto('/?view=work');
  const kinds = page.getByRole('radiogroup', { name: 'Kind of work' });
  await expect(kinds.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
  await kinds.getByRole('radio', { name: 'Processes' }).click();
  await expect(page).toHaveURL(/view=work&tab=processes/);
  await expect(kinds.getByRole('radio', { name: 'Processes' })).toHaveAttribute('aria-checked', 'true');
  // The temporary destination switch is gone.
  await expect(page.getByRole('radiogroup', { name: 'Work sections' })).toHaveCount(0);
});
