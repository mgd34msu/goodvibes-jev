/** Product cancellation over genuine runner → authenticated daemon HTTP captures. */
import { expect, test, type Page } from '@playwright/test';
import { detailPane, expectNoHorizontalScroll, nextFrames, openRow } from './support/app';
import {
  installCancellationDaemon, LIVE_CANCELLATION, RETAINED_CANCELLATION,
  type CancellationCapture,
} from './support/contract-cancellation-fixture';

const ACKNOWLEDGED = 'Cancellation acknowledged. Child processes may still be stopping. Files already changed may be incomplete.';
const NOT_LIVE = 'No live contract was cancelled. This may be a retained record without a live runner. Check contract and process details for the current state.';
const UNKNOWN = 'Cancellation outcome is unknown. Refresh contract and process details before deciding whether to cancel again. The request will not be retried automatically.';
const REASON = 'Cancelled by the user from WebUI.';

async function openContract(page: Page, capture: CancellationCapture) {
  await page.goto('/?view=work&tab=processes');
  const detail = await openRow(page, capture.before.record.goal);
  await expect(detail.locator('.contract-tree')).toBeVisible();
  return detail;
}
async function askToCancel(page: Page) {
  await detailPane(page).getByRole('button', { name: 'Cancel contract', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Cancel this contract?', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Files already changed may be incomplete; cancellation does not undo them.');
  return dialog;
}
async function closeContract(page: Page) {
  if (test.info().project.name === 'phone') await page.getByRole('button', { name: 'All work', exact: true }).click();
  else await page.getByRole('button', { name: 'Close contract', exact: true }).click();
  await expect(detailPane(page)).toHaveCount(0);
}
function reads(daemon: Awaited<ReturnType<typeof installCancellationDaemon>>, id: string) {
  return {
    list: daemon.requests.filter(request => request.method === 'GET' && request.path === '/api/contracts').length,
    detail: daemon.requests.filter(request => request.method === 'GET' && request.path === `/api/contracts/${id}`).length,
    process: daemon.requests.filter(request => request.methodId === 'fleet.snapshot').length,
  };
}
async function expectRefreshed(daemon: Awaited<ReturnType<typeof installCancellationDaemon>>, capture: CancellationCapture, before: ReturnType<typeof reads>) {
  for (const kind of ['list', 'detail', 'process'] as const) await expect.poll(() => reads(daemon, capture.before.record.id)[kind]).toBeGreaterThan(before[kind]);
}
function expectOnlyCancel(daemon: Awaited<ReturnType<typeof installCancellationDaemon>>, capture: CancellationCapture) {
  expect(daemon.writes).toHaveLength(1);
  expect(daemon.writes[0]).toMatchObject({
    method: 'POST', path: `/api/contracts/${capture.before.record.id}/cancel`,
    body: { reason: REASON },
  });
  expect(daemon.writes[0]?.authorization).toMatch(/^Bearer .+/);
  expect(daemon.requests.filter(request => request.methodId?.startsWith('contracts.') || request.methodId?.startsWith('workLedger.'))).toEqual([]);
  expect(daemon.requests.filter(request => request.path.startsWith('/api/contracts') && request.method !== 'GET')).toHaveLength(1);
  expect(daemon.requests.filter(request => request.path.startsWith('/api/work-ledger/'))).toEqual([]);
}

test('Cancel requires the explicit product confirmation; Keep running and Escape never send a write', async ({ page }) => {
  const daemon = await installCancellationDaemon(page, LIVE_CANCELLATION);
  await openContract(page, LIVE_CANCELLATION);
  const dialog = await askToCancel(page);
  await expect(dialog).toContainText(LIVE_CANCELLATION.before.record.goal);
  await expect(dialog.getByRole('button', { name: 'Keep running', exact: true })).toBeFocused();
  expect(daemon.writes).toHaveLength(0);
  await expectNoHorizontalScroll(page);
  const path = test.info().outputPath('contract-cancellation-confirmation.png');
  await page.screenshot({ path, fullPage: true });
  await test.info().attach('Contract cancellation warning and explicit confirmation', { path, contentType: 'image/png' });
  await dialog.getByRole('button', { name: 'Keep running', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(detailPane(page).getByRole('button', { name: 'Cancel contract', exact: true })).toBeFocused();
  await askToCancel(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await closeContract(page);
  await nextFrames(page);
  expect(daemon.writes).toHaveLength(0);
});

test('true acknowledges cancellation and refreshes contract/list/process data without claiming child drainage', async ({ page }) => {
  const daemon = await installCancellationDaemon(page, LIVE_CANCELLATION, { hold: true });
  try {
    const detail = await openContract(page, LIVE_CANCELLATION);
    const before = reads(daemon, LIVE_CANCELLATION.before.record.id);
    const dialog = await askToCancel(page);
    // Two real DOM activation events in one turn exercise the pending guard.
    await dialog.getByRole('button', { name: 'Cancel contract', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => daemon.pendingCount).toBe(1);
    await expect(detail.getByRole('button', { name: 'Cancelling…', exact: true })).toBeDisabled();
    await expect(dialog).toHaveCount(0);
    expectOnlyCancel(daemon, LIVE_CANCELLATION);
    await daemon.release();
    await expect(detail.getByRole('status').filter({ hasText: ACKNOWLEDGED })).toBeVisible();
    await expectRefreshed(daemon, LIVE_CANCELLATION, before);
    await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toHaveCount(0);
    // The same reason is also recorded in the closed Decision history. Read
    // the authoritative Error fact in Recorded result, not its first text match.
    const result = detail.getByRole('region', { name: 'Recorded result', exact: true });
    const error = result.locator('.dv-facts__row').filter({ has: page.getByText('Error', { exact: true }) }).locator('dd');
    const status = result.locator('.dv-facts__row').filter({ has: page.getByText('Status', { exact: true }) }).locator('dd');
    await expect(error).toHaveText(REASON);
    await expect(error).toBeVisible();
    await expect(status).toHaveText('cancelled');
    await expect(status).toBeVisible();
    await expectNoHorizontalScroll(page);
    for (const [scope, label] of [
      [detail.getByRole('status').filter({ hasText: ACKNOWLEDGED }), 'acknowledgement'],
      [result, 'recorded-result'],
    ] as const) {
      await scope.scrollIntoViewIfNeeded();
      const path = test.info().outputPath(`contract-cancellation-${label}.png`);
      await page.screenshot({ path, fullPage: true });
      await test.info().attach(`Contract cancellation ${label}`, { path, contentType: 'image/png' });
    }
    await detail.getByRole('button', { name: 'Refresh contract', exact: true }).click();
    await nextFrames(page);
    expectOnlyCancel(daemon, LIVE_CANCELLATION);
  } finally { await daemon.release(); }
});

test('false is a retained-record outcome and preserves the authoritative nonterminal status', async ({ page }) => {
  const daemon = await installCancellationDaemon(page, RETAINED_CANCELLATION);
  const detail = await openContract(page, RETAINED_CANCELLATION);
  const before = reads(daemon, RETAINED_CANCELLATION.before.record.id);
  await (await askToCancel(page)).getByRole('button', { name: 'Cancel contract', exact: true }).click();
  await expect(detail.getByRole('status').filter({ hasText: NOT_LIVE })).toBeVisible();
  await expectRefreshed(daemon, RETAINED_CANCELLATION, before);
  await expect(detail.getByText(ACKNOWLEDGED, { exact: true })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toBeEnabled();
  await expect(detail.locator('.contract-tree')).toContainText('running');
  const dialog = await askToCancel(page);
  expectOnlyCancel(daemon, RETAINED_CANCELLATION);
  await dialog.getByRole('button', { name: 'Keep running', exact: true }).click();
  expectOnlyCancel(daemon, RETAINED_CANCELLATION);
  await expectNoHorizontalScroll(page);
});

for (const response of ['disconnected', 'malformed', 'server-error'] as const) {
  test(`${response} cancellation response is unknown and never automatically replays the POST`, async ({ page }) => {
    // The retained capture deliberately remains nonterminal, so an automatic
    // status poll cannot make the unknown-outcome lock disappear by accident.
    const daemon = await installCancellationDaemon(page, RETAINED_CANCELLATION, { response });
    const detail = await openContract(page, RETAINED_CANCELLATION);
    await (await askToCancel(page)).getByRole('button', { name: 'Cancel contract', exact: true }).click();
    await expect(detail.getByRole('alert').filter({ hasText: UNKNOWN })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toBeDisabled();
    expectOnlyCancel(daemon, RETAINED_CANCELLATION);
    if (response === 'disconnected') {
      await closeContract(page);
      await openRow(page, RETAINED_CANCELLATION.before.record.goal);
      await expect(detail.getByRole('alert').filter({ hasText: UNKNOWN })).toBeVisible();
      await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toBeDisabled();
      expectOnlyCancel(daemon, RETAINED_CANCELLATION);
    }
    const before = reads(daemon, RETAINED_CANCELLATION.before.record.id);
    await detail.getByRole('button', { name: 'Refresh contract', exact: true }).click();
    await expectRefreshed(daemon, RETAINED_CANCELLATION, before);
    await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toBeEnabled();
    const dialog = await askToCancel(page);
    await dialog.getByRole('button', { name: 'Keep running', exact: true }).click();
    await nextFrames(page);
    expectOnlyCancel(daemon, RETAINED_CANCELLATION);
    await expectNoHorizontalScroll(page);
  });
}

test('closing a contract while cancellation is pending cannot reopen its detail on late acknowledgement', async ({ page }) => {
  const daemon = await installCancellationDaemon(page, LIVE_CANCELLATION, { hold: true });
  try {
    await openContract(page, LIVE_CANCELLATION);
    await (await askToCancel(page)).getByRole('button', { name: 'Cancel contract', exact: true }).click();
    await expect.poll(() => daemon.pendingCount).toBe(1);
    await closeContract(page);
    await daemon.release();
    await nextFrames(page);
    await expect(detailPane(page)).toHaveCount(0);
    await expect(page.getByText(ACKNOWLEDGED, { exact: true })).toHaveCount(0);
    expectOnlyCancel(daemon, LIVE_CANCELLATION);
  } finally { await daemon.release(); }
});
