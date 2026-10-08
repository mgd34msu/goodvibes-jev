/** Production session picker and SDK over the shared synthetic daemon, phone and desktop. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectBottomSheet, expectNoHorizontalScroll, nextFrames, openRow } from './support/app';
import { installMockDaemon, type MockDaemon } from './support/mock-daemon';
import { FOLLOWUP_SESSION, STEERABLE_SESSION } from './support/seed';

const MODE_PATH = `/api/sessions/${STEERABLE_SESSION.id}/permission-mode`;
// Public wire values and visible labels are asserted independently of the implementation.
const CHOICES = ['Plan', 'Normal', 'Accept edits', 'Auto'];

function permissionFact(detail: Locator): Locator {
  return detail.locator('.dv-facts__row').filter({
    has: detail.page().getByText('Permission mode', { exact: true }),
  }).locator('dd');
}

async function openSession(page: Page): Promise<Locator> {
  await page.goto('/?view=work&tab=sessions');
  return openRow(page, STEERABLE_SESSION.title);
}

async function openPicker(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Change permission mode', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Set permission mode', exact: true });
  await expect(sheet).toBeVisible();
  return sheet;
}

function modeWrites(daemon: MockDaemon) {
  return daemon.requests.filter(request => request.method === 'POST' && request.path.endsWith('/permission-mode'))
    .map(({ path, body }) => ({ path, body }));
}

function expectNoConfigWrites(daemon: MockDaemon): void {
  expect(daemon.requests.filter(request => request.method === 'POST'
    && (request.path === '/config' || request.methodId === 'config.set'))).toEqual([]);
}

/** Delay transport only; successful reads/writes still use the shared daemon's state. */
async function holdModeRequest(page: Page, method: 'GET' | 'POST') {
  let release!: () => void;
  let started = false;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**${MODE_PATH}`, async route => {
    if (route.request().method() === method) {
      started = true;
      await hold;
    }
    await route.fallback();
  });
  return { release, started: () => started };
}

function modeResponse(page: Page, method: 'GET' | 'POST', path = MODE_PATH) {
  return page.waitForResponse(response => new URL(response.url()).pathname === path
    && response.request().method() === method);
}

async function closeSessionDetail(page: Page): Promise<void> {
  const name = test.info().project.name === 'phone' ? 'All work' : 'Close session detail';
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.locator('.dv-detail')).toHaveCount(0);
}

test('each preset writes its session route, refetches the mode, and reopens with the current selection', async ({ page }, testInfo) => {
  const daemon = await installMockDaemon(page);
  const detail = await openSession(page);
  await expect(permissionFact(detail)).toContainText('Normal');
  let previousMode = 'normal';
  const expectedWrites: { path: string; body: { mode: string } }[] = [];

  for (const [mode, label] of [
    ['plan', 'Plan'], ['accept-edits', 'Accept edits'], ['auto', 'Auto'], ['normal', 'Normal'],
  ] as const) {
    const sheet = await openPicker(page);
    const choices = sheet.getByRole('group', { name: 'Permission modes', exact: true });
    await expect(choices.getByRole('button')).toHaveText(CHOICES);
    await expect(choices.locator('[aria-pressed="true"]')).toHaveCount(1);
    const write = modeResponse(page, 'POST');
    const read = modeResponse(page, 'GET');
    const requestStart = daemon.requests.length;
    await choices.getByRole('button', { name: label, exact: true }).click();
    const writeResponse = await write;
    expect(writeResponse.status()).toBe(200);
    expect(await writeResponse.json()).toEqual({ sessionId: STEERABLE_SESSION.id, mode, previousMode });
    const readResponse = await read;
    expect(readResponse.status()).toBe(200);
    expect(await readResponse.json()).toEqual({ sessionId: STEERABLE_SESSION.id, mode });
    expect(daemon.requests.slice(requestStart).filter(request => request.path === MODE_PATH)
      .map(request => request.method)).toEqual(['POST', 'GET']);
    await expect(sheet).toHaveCount(0);
    await expect(permissionFact(detail)).toContainText(label);
    expectedWrites.push({ path: MODE_PATH, body: { mode } });
    expect(modeWrites(daemon)).toEqual(expectedWrites);

    const reopened = await openPicker(page);
    await expect(reopened.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(reopened.locator('[aria-pressed="true"]')).toHaveCount(1);
    if (testInfo.project.name === 'phone') await expectBottomSheet(page, reopened);
    await expectNoHorizontalScroll(page);
    await reopened.locator('.gv-dialog__footer').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(reopened).toHaveCount(0);
    previousMode = mode;
  }
  expectNoConfigWrites(daemon);
});

test('custom is displayed but never offered as a settable preset', async ({ page }) => {
  const daemon = await installMockDaemon(page, { initialPermissionMode: 'custom' });
  const detail = await openSession(page);
  await expect(permissionFact(detail)).toContainText('Custom');
  const sheet = await openPicker(page);
  const choices = sheet.getByRole('group', { name: 'Permission modes', exact: true });
  await expect(choices.getByRole('button')).toHaveText(CHOICES);
  await expect(choices.getByRole('button', { name: 'Custom', exact: true })).toHaveCount(0);
  await expect(choices.locator('[aria-pressed="true"]')).toHaveCount(0);
  expect(modeWrites(daemon)).toEqual([]);
  const write = modeResponse(page, 'POST');
  const read = modeResponse(page, 'GET');
  await choices.getByRole('button', { name: 'Normal', exact: true }).click();
  expect(await (await write).json()).toEqual({ sessionId: STEERABLE_SESSION.id, mode: 'normal', previousMode: 'custom' });
  expect(await (await read).json()).toEqual({ sessionId: STEERABLE_SESSION.id, mode: 'normal' });
  await expect(sheet).toHaveCount(0);
  await expect(permissionFact(detail)).toContainText('Normal');
  expect(modeWrites(daemon)).toEqual([{ path: MODE_PATH, body: { mode: 'normal' } }]);
  expectNoConfigWrites(daemon);
});

test('a nonlocal session shows the SESSION_NOT_LOCAL refusal without inheriting the local picker', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  const local = await openSession(page);
  await expect(permissionFact(local)).toContainText('Normal');
  await closeSessionDetail(page);
  const response = modeResponse(page, 'GET', `/api/sessions/${FOLLOWUP_SESSION.id}/permission-mode`);
  const remote = await openRow(page, FOLLOWUP_SESSION.title);
  const refusal = await response;
  expect(refusal.status()).toBe(404);
  expect(await refusal.json()).toMatchObject({ code: 'SESSION_NOT_LOCAL' });
  await expect(permissionFact(remote)).toHaveText('Unavailable here');
  await expect(remote.getByRole('button', { name: 'Change permission mode', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Set permission mode', exact: true })).toHaveCount(0);
  await closeSessionDetail(page);
  const returned = await openRow(page, STEERABLE_SESSION.title);
  await expect(permissionFact(returned)).toContainText('Normal');
  await expect(returned.getByRole('button', { name: 'Change permission mode', exact: true })).toBeEnabled();
  expect(modeWrites(daemon)).toEqual([]);
  expectNoConfigWrites(daemon);
  await expectNoHorizontalScroll(page);
});

test('the picker stays disabled until the initial session mode has been read', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  const pending = await holdModeRequest(page, 'GET');
  try {
    const detail = await openSession(page);
    await expect.poll(pending.started).toBe(true);
    await expect(permissionFact(detail)).toContainText('Loading…');
    await expect(detail.getByRole('button', { name: 'Change permission mode', exact: true })).toBeDisabled();
    expect(modeWrites(daemon)).toEqual([]);
    pending.release();
    await expect(permissionFact(detail)).toContainText('Normal');
    await expect(detail.getByRole('button', { name: 'Change permission mode', exact: true })).toBeEnabled();
    await openPicker(page);
  } finally { pending.release(); }
});

test('a pending write disables repeated selections and cannot be dismissed before the response', async ({ page }, testInfo) => {
  const daemon = await installMockDaemon(page);
  const pending = await holdModeRequest(page, 'POST');
  try {
    const detail = await openSession(page);
    await expect(permissionFact(detail)).toContainText('Normal');
    const sheet = await openPicker(page);
    const choices = sheet.getByRole('group', { name: 'Permission modes', exact: true });
    await choices.getByRole('button', { name: 'Auto', exact: true }).click();
    await expect.poll(pending.started).toBe(true);
    await expect(choices.getByRole('button', { name: 'Auto…', exact: true })).toBeDisabled();
    for (const choice of await choices.getByRole('button').all()) await expect(choice).toBeDisabled();
    const footerClose = sheet.locator('.gv-dialog__footer').getByRole('button', { name: 'Close', exact: true });
    await expect(footerClose).toBeDisabled();
    // Native disabled controls must ignore repeated activation while the real SDK write is pending.
    await choices.getByRole('button').evaluateAll(buttons => {
      for (const button of buttons) (button as HTMLButtonElement).click();
    });
    await footerClose.evaluate((button: HTMLButtonElement) => button.click());
    await sheet.locator('.gv-dialog__header').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeVisible();
    await page.locator('.gv-overlay > .scrim').click({ position: { x: 8, y: 8 } });
    await nextFrames(page);
    await expect(sheet).toBeVisible();
    await expect(permissionFact(detail)).toContainText('Normal');
    expect(modeWrites(daemon)).toEqual([{ path: MODE_PATH, body: { mode: 'auto' } }]);
    await expectNoHorizontalScroll(page);
    await testInfo.attach('session-mode-pending', { body: await page.screenshot(), contentType: 'image/png' });
    const read = modeResponse(page, 'GET');
    pending.release();
    expect(await (await read).json()).toEqual({ sessionId: STEERABLE_SESSION.id, mode: 'auto' });
    await expect(sheet).toHaveCount(0);
    await expect(permissionFact(detail)).toContainText('Auto');
    expect(modeWrites(daemon)).toEqual([{ path: MODE_PATH, body: { mode: 'auto' } }]);
    expectNoConfigWrites(daemon);
  } finally { pending.release(); }
});

test('a rejected write preserves the current selection and a deliberate retry refreshes and closes', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  let rejected = false;
  await page.route(`**${MODE_PATH}`, async route => {
    if (route.request().method() === 'POST' && !rejected) {
      rejected = true;
      return route.fulfill({ status: 409, json: { code: 'CONFLICT', error: 'Session preset could not be changed. Try again.' } });
    }
    return route.fallback();
  });
  const detail = await openSession(page);
  await expect(permissionFact(detail)).toContainText('Normal');
  const sheet = await openPicker(page);
  const plan = sheet.getByRole('button', { name: 'Plan', exact: true });
  const failure = modeResponse(page, 'POST');
  await plan.click();
  expect((await failure).status()).toBe(409);
  await expect(permissionFact(detail).getByRole('alert')).toContainText('Session preset could not be changed. Try again.');
  await expect(sheet).toBeVisible();
  await expect(plan).toBeEnabled();
  await expect(plan).toHaveAttribute('aria-pressed', 'false');
  await expect(sheet.getByRole('button', { name: 'Normal', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sheet.locator('.gv-dialog__footer').getByRole('button', { name: 'Close', exact: true })).toBeEnabled();
  await nextFrames(page);
  expect(modeWrites(daemon)).toEqual([{ path: MODE_PATH, body: { mode: 'plan' } }]);
  const write = modeResponse(page, 'POST');
  const read = modeResponse(page, 'GET');
  await plan.click();
  expect(await (await write).json()).toEqual({ sessionId: STEERABLE_SESSION.id, mode: 'plan', previousMode: 'normal' });
  expect(await (await read).json()).toEqual({ sessionId: STEERABLE_SESSION.id, mode: 'plan' });
  await expect(sheet).toHaveCount(0);
  await expect(permissionFact(detail)).toContainText('Plan');
  await expect(permissionFact(detail).getByRole('alert')).toHaveCount(0);
  expect(modeWrites(daemon)).toEqual([
    { path: MODE_PATH, body: { mode: 'plan' } }, { path: MODE_PATH, body: { mode: 'plan' } },
  ]);
  expectNoConfigWrites(daemon);
});

test('Close, header close, Escape and scrim preserve the session, focus and history without writes', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  const detail = await openSession(page);
  const trigger = detail.getByRole('button', { name: 'Change permission mode', exact: true });
  await expect(trigger).toBeEnabled();
  const sessionUrl = page.url();
  for (const dismissal of ['footer', 'header', 'escape', 'scrim']) {
    const sheet = await openPicker(page);
    await expect(sheet.getByRole('button', { name: 'Normal', exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (dismissal === 'footer' || dismissal === 'header') {
      await sheet.locator(`.gv-dialog__${dismissal}`).getByRole('button', { name: 'Close', exact: true }).click();
    } else if (dismissal === 'escape') {
      await page.keyboard.press('Escape');
    } else {
      await page.locator('.gv-overlay > .scrim').click({ position: { x: 8, y: 8 } });
    }
    await expect(sheet).toHaveCount(0);
    await expect(detail).toContainText(STEERABLE_SESSION.title);
    await expect(trigger).toBeFocused();
    await expect(page).toHaveURL(sessionUrl);
    await nextFrames(page);
    expect(modeWrites(daemon)).toEqual([]);
  }
  expectNoConfigWrites(daemon);
  await expectNoHorizontalScroll(page);
});
