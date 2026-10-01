/**
 * THE HERO, steer from your phone.
 *
 * The flagship journey at 390x844: boot signed-in with the workspace visible (drawer
 * collapsed), find a session, read its transcript, STEER it from the soft keyboard
 * (plain Enter), and see the steer land over the wire. Every step is an assertion.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon, type MockDaemon } from './support/mock-daemon';
import { STEERABLE_SESSION, FOLLOWUP_SESSION } from './support/seed';
import { only, PHONE, closeNavigation, detailPane, expectNoHorizontalScroll, openNavigation } from './support/app';

let daemon: MockDaemon;

test.beforeEach(async ({ page }, testInfo) => {
  only(testInfo, PHONE);
  daemon = await installMockDaemon(page);
});

test('the workspace loads signed-in with the drawer closed; open + scrim close it', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');

  // Signed in: the shell, not the sign-in gate.
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.signed-out-gate, .auth-gate')).toHaveCount(0);

  // Drawer CLOSED on load and no permanent rail: the workspace is visible first, full width.
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toHaveCount(0);
  await expect(page.locator('.shell-sidebar')).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Open the drawer from the header's menu button, then tap the scrim beside it.
  await openNavigation(page);
  await closeNavigation(page);
});

test('find → read → STEER via plain Enter → the steer lands over the wire', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');
  await expect(page.locator('.app-shell')).toBeVisible();

  // ── FIND: the union list is usable on a phone, the session is right there. ──
  const row = page.getByRole('button', { name: new RegExp(STEERABLE_SESSION.title) });
  await expect(row).toBeVisible();
  await expectNoHorizontalScroll(page);

  // ── READ: open the transcript. Master-detail flips list → detail. ──
  await row.click();
  await expect(detailPane(page).getByRole('list', { name: 'Transcript' }).getByRole('listitem').first()).toBeVisible();
  // The wrapped transcript does not push the page sideways.
  await expectNoHorizontalScroll(page);
  // A back affordance exists (not a dead-end stack).
  await expect(page.getByRole('button', { name: 'All work' })).toBeVisible();

  // ── STEER: type into the composer and send with PLAIN ENTER (soft-keyboard path). ──
  const steerText = 'Prioritize the failing spine test before anything else';
  const input = page.locator('.steer-composer__input');
  await input.click();
  await input.fill(steerText);
  await input.press('Enter');

  // ── LAND (over the wire): the steer POST fired to /api/sessions/{id}/steer with the
  //     canonical { body } shape, and the composer reflects delivery. ──
  await expect.poll(() => daemon.steerRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
  const sent = daemon.steerRequests[0];
  expect(sent.sessionId).toBe(STEERABLE_SESSION.id);
  expect(sent.body).toMatchObject({ body: steerText });

  // The textarea cleared after send.
  await expect(input).toHaveValue('');
});

test('back affordance returns from a session detail to the list', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');
  const row = page.getByRole('button', { name: new RegExp(STEERABLE_SESSION.title) });
  await row.click();
  await expect(detailPane(page).getByRole('list', { name: 'Transcript' })).toBeVisible();
  // The list is swapped out on the phone while a session is open.
  await expect(page.locator('.dv-list')).toHaveCount(0);

  await page.getByRole('button', { name: 'All work' }).click();
  await expect(page.locator('.dv-list')).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(STEERABLE_SESSION.title) })).toBeVisible();
});

test('a non-steerable session sends a follow-up, never a steer', async ({ page }) => {
  await page.goto('/?view=work&tab=sessions');
  const row = page.getByRole('button', { name: new RegExp(FOLLOWUP_SESSION.title) });
  await row.click();
  await expect(detailPane(page).getByRole('list', { name: 'Transcript' })).toBeVisible();

  const input = page.locator('.steer-composer__input');
  await input.fill('Queue a cleanup pass for later');
  await input.press('Enter');

  await expect.poll(() => daemon.followUpRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(daemon.followUpRequests[0].sessionId).toBe(FOLLOWUP_SESSION.id);
  expect(daemon.steerRequests).toHaveLength(0);
});
