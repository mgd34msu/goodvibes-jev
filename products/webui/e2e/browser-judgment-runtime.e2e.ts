/** Built App against real runtime-generated wires; owned synthetic System One, never live AI. */
import { expect, test, type Page } from '@playwright/test';
import { nextFrames, openNavigation } from './support/app';
import { installBrowserJudgmentRuntimeDaemon } from './support/browser-judgment-runtime-fixture';
import { installMockDaemon } from './support/mock-daemon';

async function openPalette(page: Page) {
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  // 27 host-owned built-ins plus the one genuinely created companion chat.
  await expect(palette.getByRole('option')).toHaveCount(28);
  return palette;
}
async function deleteChat(page: Page, title: string) {
  await openNavigation(page);
  const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
  if (await sidebar.count()) {
    // Work opens a detail panel and auto-collapses the desktop sidebar. Reveal
    // Recent through the real controls; pin it so moving to the confirmation
    // cannot dismiss the hover peek and hide the later restore/delete proof.
    // Deliberately enter the hover peek before pinning. Clicking Expand races
    // the same hover transition, which replaces that button under the pointer.
    await sidebar.hover();
    await sidebar.getByRole('button', { name: 'Pin sidebar open', exact: true }).click();
    await expect(sidebar).toHaveAttribute('data-form', 'expanded');
    await sidebar.getByRole('button', { name: title, exact: true }).hover();
  }
  await page.getByRole('button', { name: `Delete ${title} permanently`, exact: true }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Delete this chat?', exact: true });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect(confirmation).toHaveCount(0);
}

test('runtime-issued unknown-method reading lets the real App finish its confirmed close/delete/reconcile chain', async ({ page }) => {
  const daemon = await installBrowserJudgmentRuntimeDaemon(page);
  await page.goto('/?view=work');
  await deleteChat(page, daemon.capture.title);
  await expect.poll(() => daemon.writes.map(request => request.method)).toEqual(['POST', 'DELETE']);
  await expect(page.getByRole('button', { name: `Delete ${daemon.capture.title} permanently`, exact: true })).toHaveCount(0);
  expect(daemon.judgments).toHaveLength(1);
  expect(daemon.judgments[0]).toMatchObject({ battery: 'webui.errors.daemon-refusal', input: daemon.capture.errorSettled.requestBody.input });
  const deletion = daemon.requests.findIndex(request => request.method === 'DELETE');
  await expect.poll(() => daemon.requests.slice(deletion + 1).some(request => request.method === 'GET' && request.path === '/api/companion/chat/sessions')).toBe(true);
  expect(daemon.requests.filter(request => request.method !== 'GET').every(request => request.authorization === 'Bearer e2e-operator-token')).toBe(true);
});

for (const refusal of ['held', 'missing-reference'] as const) {
  test(`${refusal} unknown close remains unusable and the real App restores the chat without DELETE`, async ({ page }) => {
    const daemon = await installBrowserJudgmentRuntimeDaemon(page, { refusal });
    await page.goto('/?view=work');
    await deleteChat(page, daemon.capture.title);
    await expect.poll(() => daemon.writes.length).toBe(1);
    await expect(page.getByRole('button', { name: `Delete ${daemon.capture.title} permanently`, exact: true })).toBeEnabled();
    await nextFrames(page);
    expect(daemon.writes.map(request => request.method)).toEqual(['POST']);
    expect(daemon.judgments).toHaveLength(refusal === 'held' ? 1 : 0);
  });
}

test('an in-flight runtime refusal cannot continue DELETE after real sign-out in another tab', async ({ page, context }) => {
  const daemon = await installBrowserJudgmentRuntimeDaemon(page, { holdRefusal: true });
  const account = await context.newPage();
  await installMockDaemon(account);
  try {
    await page.goto('/?view=work');
    await account.goto('/?view=work');
    await deleteChat(page, daemon.capture.title);
    await expect.poll(() => daemon.pendingCount).toBe(1);
    await openNavigation(account);
    await account.getByRole('button', { name: /^Account:/ }).click();
    await account.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('goodvibes.webui.token'))).toBeNull();
    await nextFrames(page);
    await daemon.release();
    await nextFrames(page);
    expect(daemon.writes.map(request => request.method)).toEqual(['POST']);
  } finally { await daemon.release(); await account.close(); }
});

for (const selected of ['library', 'chat'] as const) {
  test(`runtime palette evidence selects the genuine ${selected} command and Enter executes it`, async ({ page }) => {
    const daemon = await installBrowserJudgmentRuntimeDaemon(page);
    await page.goto('/?view=work');
    await expect(page.locator('.app-shell')).toBeVisible();
    const palette = await openPalette(page);
    const request = daemon.capture[selected].requestBody;
    if (request.battery !== 'webui.palette.command-rank' || request.input.query.kind !== 'inline') throw new Error('Missing captured inline palette query');
    await palette.getByRole('textbox', { name: 'Search commands' }).fill(request.input.query.text);
    await expect(palette.getByRole('option')).toHaveCount(1);
    await expect(palette.getByRole('option', { name: selected === 'library' ? /Go to Library/ : daemon.capture.title, selected: true })).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(selected === 'library' ? /view=library/ : new RegExp(`session=${daemon.capture.sessionId}`));
    expect(daemon.judgments).toHaveLength(1);
  });
}

test('a genuinely held runtime palette has no executable guess and still offers manual browsing', async ({ page }) => {
  await installBrowserJudgmentRuntimeDaemon(page);
  await page.goto('/?view=work');
  const palette = await openPalette(page);
  await palette.getByRole('textbox', { name: 'Search commands' }).fill('uncertain synthetic command');
  await expect(palette.locator('[data-search-status="held"]')).toBeVisible();
  await expect(palette.getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/view=work/);
  await palette.getByRole('button', { name: 'Browse all commands' }).click();
  await expect(palette.getByRole('option')).toHaveCount(28);
});

test('a late old-query runtime response cannot replace or execute the new query result', async ({ page }) => {
  const daemon = await installBrowserJudgmentRuntimeDaemon(page, { holdFirstPalette: true });
  try {
    await page.goto('/?view=work');
    const palette = await openPalette(page);
    const input = palette.getByRole('textbox', { name: 'Search commands' });
    await input.fill('show saved material');
    await expect.poll(() => daemon.pendingCount).toBe(1);
    await input.fill('Find synthetic café plans');
    await expect(palette.getByRole('option', { name: daemon.capture.title, selected: true })).toHaveCount(1);
    await daemon.release();
    await nextFrames(page);
    await expect(palette.getByRole('option')).toHaveCount(1);
    await expect(palette.getByRole('option', { name: /Go to Library/ })).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`session=${daemon.capture.sessionId}`));
  } finally { await daemon.release(); }
});

test('closing a pending runtime palette discards its reply and reopening starts in manual browse', async ({ page }) => {
  const daemon = await installBrowserJudgmentRuntimeDaemon(page, { holdFirstPalette: true });
  try {
    await page.goto('/?view=work');
    const palette = await openPalette(page);
    await palette.getByRole('textbox', { name: 'Search commands' }).fill('show saved material');
    await expect.poll(() => daemon.pendingCount).toBe(1);
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await daemon.release();
    await nextFrames(page);
    await expect(page).toHaveURL(/view=work/);
    await openPalette(page);
    await expect(palette.getByRole('textbox', { name: 'Search commands' })).toHaveValue('');
  } finally { await daemon.release(); }
});

for (const pending of [true, false]) {
  test(`${pending ? 'pending' : 'settled'} genuine runtime palette becomes unusable after cross-tab sign-out`, async ({ page, context }) => {
    const daemon = await installBrowserJudgmentRuntimeDaemon(page, { holdFirstPalette: pending });
    const account = await context.newPage();
    await installMockDaemon(account);
    try {
      await page.goto('/?view=work');
      await account.goto('/?view=work');
      const palette = await openPalette(page);
      await palette.getByRole('textbox', { name: 'Search commands' }).fill('show saved material');
      if (pending) await expect.poll(() => daemon.pendingCount).toBe(1);
      else await expect(palette.getByRole('option')).toHaveCount(1);
      await openNavigation(account);
      await account.getByRole('button', { name: /^Account:/ }).click();
      await account.getByRole('menuitem', { name: 'Sign out' }).click();
      await expect(palette.locator('[data-search-status="unavailable"]')).toBeVisible();
      await daemon.release();
      await expect(palette.getByRole('option')).toHaveCount(0);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/view=work/);
      await expect(palette).toBeVisible();
    } finally { await daemon.release(); await account.close(); }
  });
}
