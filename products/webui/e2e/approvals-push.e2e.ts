/**
 * Approvals push (control.approval_update), the webui's own SSE consumer
 * (useApprovalUpdates), not the SDK's node-side stream helper. Proves a pushed
 * approval-update frame drives a real render change (a new pending card
 * appearing) rather than only the poll fallback, see mock-daemon.ts's
 * approvalUpdateFrames option for how the mock ties the emitted frame to a
 * genuinely new record in the daemon's live approvals store.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { PENDING_APPROVAL, PENDING_APPROVAL_SAME_CLASS } from './support/seed';

test('a pushed approval-update frame lists a new pending approval without a manual refresh', async ({ page }) => {
  await installMockDaemon(page, {
    approvals: [PENDING_APPROVAL],
    approvalUpdateFrames: [PENDING_APPROVAL_SAME_CLASS],
  });
  await page.goto('/?view=work');

  const needs = page.getByRole('region', { name: 'Needs you' });
  await expect(needs.locator('.gv-row', { hasText: 'Run the full test suite before merging' })).toBeVisible();
  await expect(needs.locator('.gv-row', { hasText: 'Typecheck the workspace' })).toHaveCount(0);

  // The mock emits the seeded approval-update frame ~1s after the subscription
  // opens, no click, no manual refresh: the push path alone drives this.
  await expect(needs.locator('.gv-row', { hasText: 'Typecheck the workspace' })).toBeVisible({ timeout: 5000 });
});
