/** The sidebar must fold and reopen regardless of which needs-you query wins. */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { FLEET_BLOCKED_NODE, PENDING_APPROVAL } from './support/seed';
import { DESKTOP, detailPane, listRow, only, openRow } from './support/app';

for (const first of ['approval', 'process'] as const) {
  test(`desktop sidebar survives ${first}-first loading and repeated close/open`, async ({ page }, testInfo) => {
    only(testInfo, DESKTOP);
    await installMockDaemon(page);
    let release!: () => void;
    const pendingSource = new Promise<void>((resolve) => { release = resolve; });
    let approvalReads = 0;
    let heldSource = false;
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      // Boot reads approvals separately. Let that read finish so Work mounts;
      // hold only Work's read when proving fleet-first arrival.
      if (path === '/api/approvals') {
        approvalReads += 1;
        if (first === 'process' && approvalReads > 1) {
          heldSource = true;
          await pendingSource;
        }
      }
      if (first === 'approval' && path === '/api/control-plane/methods/fleet.snapshot/invoke') {
        heldSource = true;
        await pendingSource;
      }
      await route.fallback();
    });

    const approvalTitle = PENDING_APPROVAL.request.analysis.summary;
    const firstTitle = first === 'approval' ? approvalTitle : FLEET_BLOCKED_NODE.label;
    const otherTitle = first === 'approval' ? FLEET_BLOCKED_NODE.label : approvalTitle;
    const other = first === 'approval' ? 'process' : 'approval';
    const detail = detailPane(page);
    const shell = page.locator('.app-shell');
    try {
      await page.goto('/?view=work&tab=all');
      await expect(detail).toContainText(firstTitle);
      await expect(detail.getByRole('button', { name: `Close ${first}`, exact: true })).toBeVisible();
      await expect(shell).toHaveAttribute('data-sidebar', 'rail');

      expect(heldSource).toBe(true);

      // Finish the other query without stealing the already-open detail.
      release();
      await expect(listRow(page, otherTitle)).toBeVisible();
      await expect(detail).toContainText(firstTitle);
      await detail.getByRole('button', { name: `Close ${first}`, exact: true }).click();
      await expect(detail).toBeHidden();
      await expect(shell).toHaveAttribute('data-sidebar', 'expanded');

      // A later explicit selection must fold the sidebar again, and closing
      // that different detail must still restore it rather than auto-reopening.
      await openRow(page, otherTitle);
      await expect(detail).toContainText(otherTitle);
      await expect(shell).toHaveAttribute('data-sidebar', 'rail');
      await detail.getByRole('button', { name: `Close ${other}`, exact: true }).click();
      await expect(detail).toBeHidden();
      await expect(shell).toHaveAttribute('data-sidebar', 'expanded');
    } finally {
      release();
    }
  });
}
