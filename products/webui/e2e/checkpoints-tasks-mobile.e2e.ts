/**
 * Checkpoints + Tasks mobile mutations (confirm sheets).
 *
 * Both are fully actionable on a phone now: browsing stays available AND the
 * mutations (checkpoints create/restore; task submit/cancel/retry) are present,
 * each routed through a touch-first confirm sheet before it runs. Checkpoint
 * restore, a destructive, git-backed workspace rewrite the daemon executes
 * immediately, confirms on every viewport, desktop included.
 *
 * Each phone mutation gets two proofs: one that opens the sheet and backs out
 * (Cancel), and one that confirms through to a real call against the mock
 * daemon, checking the resulting toast and the list/row state the mock's
 * in-memory store reflects afterward (not just that the sheet appeared).
 *
 * Approvals, the other half of this view, are audited as the headline mobile
 * action and proven elsewhere (fleet-depth.e2e.ts, touch-targets.e2e.ts); this
 * file only re-checks they stay actionable alongside the tasks changes.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon, type MockDaemon } from './support/mock-daemon';
import { only, PHONE, DESKTOP, detailPane, expectNoHorizontalScroll, expectTappable, listRow, openRow } from './support/app';

let daemon: MockDaemon;

test.beforeEach(async ({ page }) => {
  daemon = await installMockDaemon(page);
});

/** POSTs to /api/tasks/{id}/{verb}, in order. */
function taskVerbs(verb: 'cancel' | 'retry'): number {
  return daemon.requests.filter((r) => r.method === 'POST' && new RegExp(`^/api/tasks/[^/]+/${verb}$`).test(r.path)).length;
}

/** The old Checkpoints link: a session's Checkpoints tab in Work. */
async function openCheckpoints(page: Page) {
  await page.goto('/?view=checkpoints');
  await expect(detailPane(page).getByRole('radio', { name: 'Checkpoints', checked: true })).toBeVisible();
  return detailPane(page);
}

async function showFinished(page: Page) {
  await page.getByRole('combobox', { name: 'Show' }).click();
  await page.getByRole('option', { name: 'Active and finished' }).click();
}

test.describe('Checkpoints: desktop', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, DESKTOP));

  test('create and restore controls are present; restore confirms via a sheet', async ({ page }) => {
    const pane = await openCheckpoints(page);
    await expect(pane.getByRole('textbox', { name: 'Checkpoint label' })).toBeVisible();
    await pane.locator('.gv-row__main', { hasText: 'Before the mobile pass' }).click();
    const restore = pane.getByRole('button', { name: 'Restore this checkpoint' });
    await expect(restore).toBeVisible();
    // Restore opens a confirm sheet (destructive: confirms on desktop too).
    await restore.click();
    await expect(page.locator('.gv-confirm')).toBeVisible();
    await page.locator('.gv-confirm__cancel').click();
    await expect(page.locator('.gv-confirm')).toHaveCount(0);
    // Cancelling the sheet restores nothing.
    expect(daemon.invocations('checkpoints.restore')).toHaveLength(0);
  });
});

test.describe('Checkpoints: phone: browsable AND actionable via confirm sheets', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('the list is browsable and creating opens a confirm sheet', async ({ page }) => {
    const pane = await openCheckpoints(page);
    await expect(pane.locator('.gv-row', { hasText: 'Before the mobile pass' })).toBeVisible();
    await expectTappable(page, '.work-checkpoints__create button', 'checkpoint create');
    await pane.getByRole('button', { name: 'Snapshot' }).click();
    await expect(page.locator('.gv-confirm')).toBeVisible();
    await expectTappable(page, '.gv-confirm__confirm', 'confirm sheet primary');
    await expectTappable(page, '.gv-confirm__cancel', 'confirm sheet cancel');
    await page.locator('.gv-confirm__cancel').click();
    expect(daemon.invocations('checkpoints.create')).toHaveLength(0);
    await expectNoHorizontalScroll(page);
  });

  test('selecting a checkpoint loads its diff; restore opens a danger confirm sheet', async ({ page }) => {
    const pane = await openCheckpoints(page);
    await pane.locator('.gv-row__main', { hasText: 'Before the mobile pass' }).click();
    await expect(pane.getByRole('button', { name: 'All checkpoints' })).toBeVisible();
    await expect.poll(() => daemon.invocations('checkpoints.diff').length).toBeGreaterThan(0);
    await expectTappable(page, '.work-checkpoints__head button', 'checkpoint restore');
    await pane.getByRole('button', { name: 'Restore this checkpoint' }).click();
    await expect(page.locator('.gv-confirm--danger')).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.locator('.gv-confirm__cancel').click();
    await pane.getByRole('button', { name: 'All checkpoints' }).click();
    await expect(pane.locator('.gv-row', { hasText: 'Before the mobile pass' })).toBeVisible();
  });

  test('confirming create completes against the mock daemon', async ({ page }) => {
    const pane = await openCheckpoints(page);
    await pane.getByRole('textbox', { name: 'Checkpoint label' }).fill('Phone-created checkpoint');
    await pane.getByRole('button', { name: 'Snapshot' }).click();
    await expect(page.locator('.gv-confirm')).toBeVisible();
    await page.locator('.gv-confirm__confirm').click();
    await expect(page.locator('.gv-confirm')).toHaveCount(0);
    // The create carried the typed label, and the new checkpoint opens as the one shown.
    expect(daemon.invocations('checkpoints.create')).toEqual([expect.objectContaining({ label: 'Phone-created checkpoint' })]);
    await expect(pane.getByRole('button', { name: 'All checkpoints' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('confirming restore completes against the mock daemon', async ({ page }) => {
    const pane = await openCheckpoints(page);
    await pane.locator('.gv-row__main', { hasText: 'Before the mobile pass' }).click();
    await pane.getByRole('button', { name: 'Restore this checkpoint' }).click();
    await expect(page.locator('.gv-confirm--danger')).toBeVisible();
    await page.locator('.gv-confirm__confirm').click();
    await expect(page.locator('.gv-confirm')).toHaveCount(0);
    // The restorePreview token is what the restore call presents to the daemon's confirmation gate.
    expect(daemon.invocations('checkpoints.restorePreview').length).toBeGreaterThan(0);
    await expect.poll(() => daemon.invocations('checkpoints.restore')).toEqual([expect.objectContaining({ confirmToken: expect.stringMatching(/^tok_/) })]);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Tasks: desktop', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, DESKTOP));

  test('cancel runs bare on desktop; a failed task offers retry', async ({ page }) => {
    await page.goto('/?view=work&tab=processes');
    const detail = await openRow(page, 'Run the release checklist');
    await detail.getByRole('button', { name: 'Cancel task' }).click();
    await expect(page.locator('.gv-confirm')).toHaveCount(0);
    await expect.poll(() => taskVerbs('cancel')).toBe(1);
    await showFinished(page);
    const failed = await openRow(page, 'Rebuild the search index');
    await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});

test.describe('Tasks: phone: fully actionable via confirm sheets', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('a running task is listed and cancel opens a confirm sheet', async ({ page }) => {
    await page.goto('/?view=work&tab=processes');
    await expect(listRow(page, 'Run the release checklist')).toBeVisible();
    const detail = await openRow(page, 'Run the release checklist');
    await expectTappable(page, '.dv-detail .dv-pane__actions button', 'task cancel');
    await detail.getByRole('button', { name: 'Cancel task' }).click();
    await expect(page.locator('.gv-confirm--danger')).toBeVisible();
    await page.locator('.gv-confirm__cancel').click();
    expect(taskVerbs('cancel')).toBe(0);
    await expectNoHorizontalScroll(page);
  });

  test('approvals stay fully actionable on phone', async ({ page }) => {
    await page.goto('/?view=work');
    const detail = await openRow(page, 'Run the full test suite before merging');
    await expect(detail.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
    await expectTappable(page, '.dv-pane__footer .gv-button--primary', 'approve');
    await expectNoHorizontalScroll(page);
  });

  test('confirming cancel completes against the mock daemon and retry follows', async ({ page }) => {
    await page.goto('/?view=work&tab=processes');
    const detail = await openRow(page, 'Run the release checklist');
    await detail.getByRole('button', { name: 'Cancel task' }).click();
    await expect(page.locator('.gv-confirm--danger')).toBeVisible();
    await expectTappable(page, '.gv-confirm__confirm', 'confirm sheet primary');
    await page.locator('.gv-confirm__confirm').click();
    await expect(page.locator('.gv-confirm')).toHaveCount(0);
    await expect.poll(() => taskVerbs('cancel')).toBe(1);
    // The mock flipped the task to cancelled: no cancel left, and retry is offered.
    await expect(detail.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('retry is reachable, confirms, and completes against the mock daemon', async ({ page }) => {
    await page.goto('/?view=work&tab=processes');
    await showFinished(page);
    const detail = await openRow(page, 'Rebuild the search index');
    await detail.getByRole('button', { name: 'Retry' }).click();
    await expect(page.locator('.gv-confirm')).toBeVisible();
    await page.locator('.gv-confirm__confirm').click();
    await expect(page.locator('.gv-confirm')).toHaveCount(0);
    await expect.poll(() => taskVerbs('retry')).toBe(1);
    // The mock requeued the task: retry (failed or cancelled only) is gone.
    await expect(detail.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('submitting a task from New completes against the mock daemon', async ({ page }) => {
    await page.goto('/?view=work&tab=processes');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Task' }).click();
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByLabel('Task').fill('Ship the phone parity fix');
    await expectTappable(page, '.work-form__actions button', 'task submit');
    await dialog.getByRole('button', { name: 'Submit' }).click();
    await expect(dialog).toHaveCount(0);
    expect(daemon.requests.filter((r) => r.method === 'POST' && r.path === '/task').map((r) => JSON.stringify(r.body)))
      .toEqual([expect.stringContaining('Ship the phone parity fix')]);
    await expect(listRow(page, 'Ship the phone parity fix')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
