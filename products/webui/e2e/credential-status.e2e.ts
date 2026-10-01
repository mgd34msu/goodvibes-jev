/**
 * Credential status panel (Settings, Credentials), the cross-surface credential-status
 * facade's display-site adoption. Proves the three honest outcomes render
 * against a real HTTP round-trip through the mock daemon (mock-daemon.ts's
 * `credentials` option), not just against a unit-mocked module.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { expectNoHorizontalScroll, openSettings } from './support/app';

test('available: one row per credential the daemon reports, and no degraded notice', async ({ page }) => {
  await installMockDaemon(page, { credentials: 'available' });
  await openSettings(page, 'credentials');
  const panel = page.locator('.credential-status');
  await expect(panel.getByRole('list', { name: 'Credentials' }).getByRole('listitem')).toHaveCount(3);
  await expect(panel.getByRole('status')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

for (const outcome of ['store-unavailable', 'admin-required'] as const) {
  test(`${outcome}: the refused read shows a status notice and never a credentials list`, async ({ page }) => {
    await installMockDaemon(page, { credentials: outcome });
    await openSettings(page, 'credentials');
    const panel = page.locator('.credential-status');
    await expect(panel.getByRole('status')).toBeVisible();
    await expect(panel.getByRole('list', { name: 'Credentials' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
}
