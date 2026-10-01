/**
 * Push "Allow"/"Deny" hand-off: opening the deep link the service worker builds
 * for an approval action button (`#approval-action=…&approval-id=…`) makes the
 * authenticated app run the real approve/deny call and scrub the fragment.
 */
import { test, expect, type Locator } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';

const approvalRow = (scope: Locator) => scope.locator('.gv-row', { hasText: /^Approve bash/ });

for (const [action, decision] of [['Allow', 'approve'], ['Deny', 'deny']] as const) {
  test(`an ${action} hand-off sends the ${decision} call for the seeded approval and moves it to finished`, async ({ page }) => {
    const daemon = await installMockDaemon(page);

    await page.goto(`/?view=approvals-tasks#approval-action=${decision}&approval-id=appr-e2e-1`);

    // The decision call reached the daemon for exactly the seeded approval.
    await expect.poll(() => daemon.approvalActions.map((a) => `${a.approvalId}:${a.action}`)).toEqual([`appr-e2e-1:${decision}`]);
    // The one-shot action fragment is scrubbed from the URL.
    await expect.poll(() => new URL(page.url()).hash).not.toContain('approval-action');
    // The approval left Needs you and now sits among finished work.
    await expect(approvalRow(page.getByRole('region', { name: 'Needs you' }))).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Show' }).click();
    await page.getByRole('option', { name: 'Active and finished' }).click();
    await expect(approvalRow(page.getByRole('region', { name: 'Finished' }))).toHaveCount(1);
  });
}
