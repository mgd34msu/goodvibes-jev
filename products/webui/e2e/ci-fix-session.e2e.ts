/**
 * CI fix-session, the "open session" affordances, on both start paths:
 *   - auto-start: the started session's REAL id rides the ci.watches.run verb
 *     result, the CI view offers Open fix session.
 *   - accepted "fix this?" offer: the broker stamps the started session's REAL
 *     id onto the resolved APPROVED approval record, published live, the
 *     approvals view's resolved card offers Open fix session once the record
 *     updates post-acceptance.
 * The stamped id is always a real attachable session (never an internal
 * scheduling handle, SDK bb4b9c30), so opening lands on a LIVE session view:
 * these tests assert the chat surface actually shows the spawned session, not
 * an id it reconciled away. A failed spawn carries fixSessionError instead,
 * rendered as an honest error line, never a dead open button.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon, type MockDaemon } from './support/mock-daemon';
import { detailPane, gotoView, openRow } from './support/app';
import { CI_FIX_OFFER_APPROVAL } from './support/seed';

/** New, CI watch: a watch on acme/example that starts a fix session on failure. It opens once created. */
async function createFixingWatch(page: Page, daemon: MockDaemon) {
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('menuitem', { name: 'CI watch' }).click();
  const dialog = page.getByRole('dialog', { name: 'Watch CI' });
  await dialog.getByLabel('Repository').fill('acme/example');
  await dialog.getByLabel('Delivery channel').fill('slack:#ci');
  await dialog.getByLabel('Start a fix session on failure').check();
  await dialog.getByRole('button', { name: /Create watch/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(daemon.requests.filter((r) => r.method === 'POST' && r.path === '/api/ci/watches').map((r) => r.body))
    .toEqual([expect.objectContaining({ repo: 'acme/example', deliveryChannel: 'slack:#ci', triggerFixSession: true })]);
  await expect(detailPane(page)).toBeVisible();
}

/** Runs the open watch now and waits for the run's answer. */
async function checkNow(page: Page, daemon: MockDaemon) {
  await detailPane(page).getByRole('button', { name: /Check now/ }).click();
  await expect.poll(() => daemon.requests.filter((r) => r.method === 'POST' && /^\/api\/ci\/watches\/[^/]+\/run$/.test(r.path)).length).toBe(1);
  await expect(detailPane(page).getByLabel('CI report')).toBeVisible();
}

test('a failed watch that starts a fix session offers to open it, and opening lands on the live session', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  // The old CI link lands on Work, Processes.
  await gotoView(page, 'ci-watches');
  await createFixingWatch(page, daemon);
  await checkNow(page, daemon);

  const openButton = detailPane(page).getByRole('button', { name: 'Open fix session' });
  await expect(openButton).toBeVisible();

  await openButton.click();
  // Live-session proof: the URL keeps the spawned session's id; the app strips unknown
  // session ids, so it surviving means the session exists.
  await expect(page).toHaveURL(/view=chat/);
  await expect(page).toHaveURL(/session=sess-ci-fix-1/);
});

test('accepting a "fix this?" offer stamps the spawned session id, and opening lands on the live session', async ({ page }) => {
  const daemon = await installMockDaemon(page, { approvals: [CI_FIX_OFFER_APPROVAL] });
  await gotoView(page, 'work');

  // The offer is an ordinary approval under Needs you; accept it.
  const detail = await openRow(page, 'start a fix session for lint?');
  await detail.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => daemon.approvalActions.length).toBeGreaterThan(0);
  expect(daemon.approvalActions[0]).toMatchObject({ approvalId: CI_FIX_OFFER_APPROVAL.id, action: 'approve' });

  // After acceptance the record updates and the resolved detail gains the affordance.
  const openButton = detailPane(page).getByRole('button', { name: /Open fix session/ });
  await expect(openButton).toBeVisible();
  await openButton.click();
  await expect(page).toHaveURL(/view=chat/);
  await expect(page).toHaveURL(/session=sess-ci-fix-1/);
});

test('a failed spawn on an accepted offer never grows an open button', async ({ page }) => {
  const daemon = await installMockDaemon(page, {
    approvals: [CI_FIX_OFFER_APPROVAL],
    ciFixSessionError: 'background automation is disabled on this daemon',
  });
  await gotoView(page, 'work');
  const detail = await openRow(page, 'start a fix session for lint?');
  await detail.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => daemon.approvalActions.map((a) => a.action)).toEqual(['approve']);
  // The record resolved (no decision left to make)…
  await expect(detailPane(page).getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  // …and with no session spawned there is nothing to open.
  await expect(detailPane(page).getByRole('button', { name: /Open fix session/ })).toHaveCount(0);
});

test('a failed spawn on the auto-start path never grows an open button', async ({ page }) => {
  const daemon = await installMockDaemon(page, { ciFixSessionError: 'background automation is disabled on this daemon' });
  await gotoView(page, 'ci-watches');
  await createFixingWatch(page, daemon);
  await checkNow(page, daemon);

  await expect(page.getByRole('button', { name: 'Open fix session' })).toHaveCount(0);
});

test('denying a "fix this?" offer never grows an open-session affordance', async ({ page }) => {
  const daemon = await installMockDaemon(page, { approvals: [CI_FIX_OFFER_APPROVAL] });
  await gotoView(page, 'work');
  const detail = await openRow(page, 'start a fix session for lint?');
  await detail.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect.poll(() => daemon.approvalActions.map((a) => a.action)).toEqual(['deny']);
  await expect(detailPane(page).getByRole('button', { name: 'Deny', exact: true })).toHaveCount(0);
  await expect(detailPane(page).getByRole('button', { name: /Open fix session/ })).toHaveCount(0);
});

test('a passing watch (or one without fix-on-failure) shows no open-session affordance', async ({ page }) => {
  // The seeded watch has triggerFixSession:false; running it never starts a fix session.
  await installMockDaemon(page);
  await gotoView(page, 'ci-watches');
  const detail = await openRow(page, 'acme/example');
  await detail.getByRole('button', { name: /Check now/ }).click();
  await expect(detail.getByLabel('CI report')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open fix session' })).toHaveCount(0);
});
