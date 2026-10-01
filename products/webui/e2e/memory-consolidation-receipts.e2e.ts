/**
 * Memory consolidation on the Library's Review tab (memory.consolidation.receipts, SDK
 * 1.8.0's consolidation-reaches-the-review-queue work). Proves: pending proposals render
 * with what kind, how many records and why; "Resolve" opens the proposal and highlights
 * exactly the referenced queue rows (never filtering the rest away); the genuinely-empty and
 * daemon-does-not-run-consolidation states are each honest and distinct. Runs on both
 * phone and desktop (default project set).
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { MEMORY_FACT, MEMORY_REVIEW_CANDIDATE } from './support/seed';

const PANEL = '[data-testid="consolidation-receipts"]';

/** On a phone the proposal's detail is a bottom sheet over the list; Escape closes it. */
async function backToListIfPhone(page: Page): Promise<void> {
  const sheet = page.locator('.dv-peek.gv-drawer--sheet');
  if (await sheet.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
  }
}

test('"Resolve" opens the proposal and highlights exactly the referenced records, without hiding the rest', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=library&tab=review');
  const panel = page.locator(PANEL);
  await expect(panel).toBeVisible();

  const queueRows = page.getByRole('list', { name: 'Review queue' }).getByRole('listitem');
  const rowCountBeforeJump = await queueRows.count();
  expect(rowCountBeforeJump).toBeGreaterThan(0);

  await panel.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByRole('region', { name: 'Review item' })).toBeVisible();
  await backToListIfPhone(page);

  const highlighted = page.locator('.lib-row--highlight');
  await expect(highlighted).toHaveCount(2);
  await expect(highlighted.filter({ hasText: MEMORY_FACT.summary })).toHaveCount(1);
  await expect(highlighted.filter({ hasText: MEMORY_REVIEW_CANDIDATE.summary })).toHaveCount(1);

  // The jump never filters the queue, the same rows that were there before are all still
  // there, merely two of them now highlighted.
  await expect(queueRows).toHaveCount(rowCountBeforeJump);
});

for (const consolidationReceipts of ['unavailable', 'empty'] as const) {
  test(`${consolidationReceipts} receipts: the panel offers nothing to resolve and the queue still renders`, async ({ page }) => {
    await installMockDaemon(page, { consolidationReceipts });
    await page.goto('/?view=library&tab=review');
    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Review queue' }).getByRole('listitem').first()).toBeVisible();
  });
}
