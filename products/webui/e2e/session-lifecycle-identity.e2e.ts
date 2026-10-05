/** Phone/desktop lifecycle ownership and unknown-outcome proofs over synthetic HTTP. */
import { expect, test, type Page } from '@playwright/test';
import { detailPane, expectNoHorizontalScroll, listRow, nextFrames, openRow } from './support/app';
import {
  installSessionLifecycleDaemon, LIFECYCLE_SESSION, LIFECYCLE_TOKEN,
  REPLACEMENT_SESSION, replaceSessionIdentity,
} from './support/session-lifecycle-fixture';

const UNKNOWN = 'Session action outcome is unknown';
const ORIGINAL_PATH = `/api/sessions/${LIFECYCLE_SESSION.id}`;
type Daemon = Awaited<ReturnType<typeof installSessionLifecycleDaemon>>;

async function openSession(page: Page) {
  await page.goto('/?view=work&tab=sessions');
  // Closed records must stay available when inspecting an interrupted close.
  await page.getByRole('combobox', { name: 'Show', exact: true }).click();
  await page.getByRole('option', { name: 'Active and finished', exact: true }).click();
  return openRow(page, LIFECYCLE_SESSION.title);
}

async function dismissSession(page: Page): Promise<void> {
  const name = test.info().project.name === 'phone' ? 'All work' : 'Close session detail';
  await page.getByRole('button', { name, exact: true }).click();
  await expect(detailPane(page)).toHaveCount(0);
}

async function askDelete(page: Page) {
  await detailPane(page).getByRole('button', { name: 'More session actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete permanently', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete this session?', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function confirmDelete(page: Page): Promise<void> {
  await (await askDelete(page)).getByRole('button', { name: 'Delete', exact: true }).click();
}

function expectWrites(daemon: Daemon, actions: ('close' | 'reopen' | 'delete')[]): void {
  expect(daemon.writes).toEqual(actions.map(action => ({
    method: action === 'delete' ? 'DELETE' : 'POST',
    path: action === 'delete' ? ORIGINAL_PATH : `${ORIGINAL_PATH}/${action}`,
    authorization: `Bearer ${LIFECYCLE_TOKEN}`,
  })));
}

async function screenshot(page: Page, name: string): Promise<void> {
  await expectNoHorizontalScroll(page);
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

test('session Close and Delete require explicit confirmation; Cancel and Escape send no writes', async ({ page }) => {
  const daemon = await installSessionLifecycleDaemon(page);
  const detail = await openSession(page);
  await detail.getByRole('button', { name: 'Close session', exact: true }).click();
  const close = page.getByRole('alertdialog', { name: 'Close this session?', exact: true });
  await expect(close).toContainText('It stays in history and can be reopened.');
  expectWrites(daemon, []);
  await close.getByRole('button', { name: 'Cancel', exact: true }).click();
  const deletion = await askDelete(page);
  await expect(deletion).toContainText(LIFECYCLE_SESSION.title);
  await expect(deletion).toContainText('The session record is removed for good and cannot be reopened.');
  await expect(deletion.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await screenshot(page, 'session-delete-confirmation');
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await askDelete(page);
  await page.keyboard.press('Escape');
  await expect(deletion).toHaveCount(0);
  await expect(detail).toContainText(LIFECYCLE_SESSION.title);
  await dismissSession(page);
  await nextFrames(page);
  expectWrites(daemon, []);
});

test('normal session delete closes once, deletes once and removes the old row despite duplicate confirmation clicks', async ({ page }) => {
  const daemon = await installSessionLifecycleDaemon(page, { hold: 'close' });
  try {
    await openSession(page);
    const dialog = await askDelete(page);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => daemon.pendingStages).toEqual(['close']);
    await expect(dialog).toHaveCount(0);
    expectWrites(daemon, ['close']);
    // A second action cannot start while the close→delete chain owns the session.
    await expect(detailPane(page).getByRole('button', { name: /^(?:Close session|Closing…)$/ })).toBeDisabled();
    await daemon.release();
    await expect(detailPane(page)).toHaveCount(0);
    await expect(listRow(page, LIFECYCLE_SESSION.title)).toHaveCount(0);
    await expect(listRow(page, REPLACEMENT_SESSION.title)).toBeVisible();
    expectWrites(daemon, ['close', 'delete']);
    const deletion = daemon.lifecycleRequests.findIndex(request => request.method === 'DELETE');
    expect(daemon.lifecycleRequests.slice(deletion + 1).some(request => request.method === 'GET' && request.path === '/api/sessions')).toBe(true);
    await screenshot(page, 'session-delete-complete');
  } finally { await daemon.release(); }
});

test('session close and reopen each execute once and keep the selected detail', async ({ page }) => {
  const daemon = await installSessionLifecycleDaemon(page, { hold: 'close' });
  try {
    const detail = await openSession(page);
    await detail.getByRole('button', { name: 'Close session', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Close session', exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect.poll(() => daemon.pendingStages).toEqual(['close']);
    expectWrites(daemon, ['close']);
    await daemon.release();
    const reopen = detail.getByRole('button', { name: 'Reopen', exact: true });
    await expect(reopen).toBeEnabled();
    await reopen.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(detail.getByRole('button', { name: 'Close session', exact: true })).toBeEnabled();
    expectWrites(daemon, ['close', 'reopen']);
    await expect(detail).toContainText(LIFECYCLE_SESSION.title);
  } finally { await daemon.release(); }
});

for (const replacement of [false, true]) {
  test(`dismissing during buffered session close stops DELETE${replacement ? ' and preserves a newly selected session' : ' and leaves detail dismissed'}`, async ({ page }) => {
    const daemon = await installSessionLifecycleDaemon(page, { hold: 'close' });
    try {
      await openSession(page);
      await confirmDelete(page);
      await expect.poll(() => daemon.pendingStages).toEqual(['close']);
      await dismissSession(page);
      if (replacement) await openRow(page, REPLACEMENT_SESSION.title);
      await daemon.release();
      await nextFrames(page);
      expectWrites(daemon, ['close']);
      if (replacement) await expect(detailPane(page)).toContainText(REPLACEMENT_SESSION.title);
      else await expect(detailPane(page)).toHaveCount(0);
    } finally { await daemon.release(); }
  });
}

for (const stage of ['delete', 'list'] as const) {
  test(`a late session ${stage.toUpperCase()} reply cannot close a newer selected session`, async ({ page }) => {
    const daemon = await installSessionLifecycleDaemon(page, { hold: stage });
    try {
      await openSession(page);
      await confirmDelete(page);
      await expect.poll(() => daemon.pendingStages).toEqual([stage]);
      expectWrites(daemon, ['close', 'delete']);
      await dismissSession(page);
      const replacement = await openRow(page, REPLACEMENT_SESSION.title);
      await daemon.release();
      await nextFrames(page);
      await expect(replacement).toContainText(REPLACEMENT_SESSION.title);
      await expect(replacement.getByRole('button', { name: 'Close session', exact: true })).toBeEnabled();
      expectWrites(daemon, ['close', 'delete']);
      await screenshot(page, `session-new-selection-after-late-${stage}`);
    } finally { await daemon.release(); }
  });
}

for (const restoreOriginal of [false, true]) {
  test(`identity ${restoreOriginal ? 'A→B→A' : 'A→B'} during buffered close never continues DELETE under the replacement lifetime`, async ({ page }) => {
    const daemon = await installSessionLifecycleDaemon(page, { hold: 'close' });
    try {
      await openSession(page);
      await confirmDelete(page);
      await expect.poll(() => daemon.pendingStages).toEqual(['close']);
      await replaceSessionIdentity(page, restoreOriginal);
      await expect(detailPane(page)).toHaveCount(0);
      await openRow(page, REPLACEMENT_SESSION.title);
      await daemon.release();
      await nextFrames(page);
      await expect(detailPane(page)).toContainText(REPLACEMENT_SESSION.title);
      expectWrites(daemon, ['close']);
    } finally { await daemon.release(); }
  });
}

for (const response of ['disconnected', 'server-error'] as const) {
  test(`${response} session action stays unknown until a read-only refresh and a new explicit intent`, async ({ page }) => {
    const daemon = await installSessionLifecycleDaemon(page, { fail: { stage: 'close', response } });
    const detail = await openSession(page);
    await confirmDelete(page);
    await expect(detail.getByRole('alert').filter({ hasText: UNKNOWN })).toBeVisible();
    expectWrites(daemon, ['close']);
    await detail.getByRole('button', { name: 'More session actions', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Delete permanently', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await screenshot(page, `session-unknown-${response}`);
    // Unmount/remount must not silently make another destructive attempt safe.
    await dismissSession(page);
    await openRow(page, LIFECYCLE_SESSION.title);
    await expect(detail.getByRole('alert').filter({ hasText: UNKNOWN })).toBeVisible();
    const before = daemon.lifecycleRequests.filter(request => request.method === 'GET').length;
    await detail.getByRole('button', { name: 'Refresh session state', exact: true }).click();
    await expect.poll(() => daemon.lifecycleRequests.filter(request => request.method === 'GET').length).toBeGreaterThan(before);
    await expect(detail.getByRole('button', { name: 'Reopen', exact: true })).toBeEnabled();
    expectWrites(daemon, ['close']);
    const dialog = await askDelete(page);
    // Refreshing and reopening confirmation are reads/local UI, never a retry.
    expectWrites(daemon, ['close']);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await nextFrames(page);
    expectWrites(daemon, ['close']);
    // Only another explicitly accepted confirmation may submit a new write.
    await confirmDelete(page);
    await expect(detail).toHaveCount(0);
    await expect(listRow(page, LIFECYCLE_SESSION.title)).toHaveCount(0);
    expectWrites(daemon, ['close', 'close', 'delete']);
  });
}
