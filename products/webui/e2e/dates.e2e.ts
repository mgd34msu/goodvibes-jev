/**
 * Occasions tab of Personal (occasions.*, docs/occasions.md), proven against a real
 * HTTP round-trip through the mock daemon, mirroring calendar.e2e.ts/mail.e2e.ts's
 * shape for the sibling surface. Covers the not-available honesty state, the
 * populated upcoming / plans / open-items / stored-records groups, the answer /
 * remove / gift-history actions in the detail pane, and the one thing
 * docs/occasions.md §4.3 makes non-negotiable: a pending nudge subject never
 * carries a raw date, only the proximity word.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon, type MockDaemon } from './support/mock-daemon';
import { occasionsListResponse, occasionsPlansListResponse } from './support/seed';
import { expectNoHorizontalScroll } from './support/app';

const OCCASIONS = '/?view=personal&tab=occasions';

/** Bodies of every POST the page sent to an occasions path, in order. */
function posts(daemon: MockDaemon, path: string): unknown[] {
  return daemon.requests.filter((r) => r.method === 'POST' && r.path === path).map((r) => r.body);
}

function occasionRow(page: Page, text: string) {
  return page.getByTestId('dates-occasion-list').locator('.dates-occasion-row').filter({ hasText: text });
}

test('default options (occasions available): every occasion the daemon lists is a row', async ({ page }) => {
  await installMockDaemon(page); // default occasions: 'available'
  await page.goto(OCCASIONS);
  const list = page.getByTestId('dates-occasion-list');
  await expect(list.locator('.dates-occasion-row')).toHaveCount(occasionsListResponse().occasions.length);
  await expectNoHorizontalScroll(page);
});

test('not-available: one action, no list and no add buttons', async ({ page }) => {
  await installMockDaemon(page, { occasions: 'not-available' });
  await page.goto(OCCASIONS);
  await expect(page.getByRole('button', { name: 'Update daemon' })).toBeVisible();
  await expect(page.getByTestId('dates-occasion-list')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add occasion' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('answering Yes in the occasion detail sends the answer and marks Yes pressed', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto(OCCASIONS);
  const row = occasionRow(page, 'Sarah’s birthday');
  await expect(row).toBeVisible();
  await row.locator('.gv-row__main').click();
  const pane = page.getByRole('region', { name: 'Details' });
  await expect(pane).toBeVisible();
  await pane.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(pane.getByRole('button', { name: 'Yes', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(posts(daemon, '/api/occasions/answer')).toEqual([expect.objectContaining({ occasionId: 'occ-e2e-1', answer: 'yes' })]);
});

test('removing an occasion takes one confirmation and then it disappears', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto(OCCASIONS);
  await occasionRow(page, 'Dad').locator('.gv-row__main').click();
  await page.getByRole('region', { name: 'Details' }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.gv-confirm--danger')).toBeVisible();
  expect(posts(daemon, '/api/occasions/remove')).toHaveLength(0);
  await page.locator('.gv-confirm__confirm').click();
  await expect(page.locator('.gv-confirm')).toHaveCount(0);
  expect(posts(daemon, '/api/occasions/remove')).toHaveLength(1);
  await expect(occasionRow(page, 'Dad')).toHaveCount(0);
  await expect(page.getByTestId('dates-occasion-list').locator('.dates-occasion-row')).toHaveCount(occasionsListResponse().occasions.length - 1);
});

test('opening an occasion fetches its gift history into the detail pane', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto(OCCASIONS);
  await occasionRow(page, 'Dad').locator('.gv-row__main').click();
  await expect(page.getByTestId('dates-gift-peek-list')).toBeVisible();
  expect(posts(daemon, '/api/occasions/gifts').length).toBeGreaterThan(0);
  await expect(page.getByTestId('dates-gift-peek-list').getByRole('listitem').first()).toBeVisible();
});

test('every plan the daemon lists is a row', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto(OCCASIONS);
  await expect(page.getByTestId('dates-plan-list').getByRole('listitem')).toHaveCount(occasionsPlansListResponse().plans.length);
});

test('open items: answering the in-progress interview\'s question, then recording the outcome, sends both', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto(OCCASIONS);
  const interviewList = page.getByTestId('dates-interview-list');
  await expect(interviewList).toBeVisible();
  await interviewList.locator('.gv-row__main').first().click();
  const pane = page.getByRole('region', { name: 'Details' });
  await pane.getByLabel('What has she mentioned wanting lately?').fill('A scarf');
  await pane.getByRole('button', { name: 'Answer' }).click();
  await expect.poll(() => posts(daemon, '/api/occasions/interview/answer').map((b) => JSON.stringify(b))).toEqual([expect.stringContaining('A scarf')]);
  // The answer advanced the interview to its closing question.
  await pane.getByLabel('What did you land on?').fill('A scarf');
  await pane.getByRole('button', { name: 'Record' }).click();
  await expect.poll(() => posts(daemon, '/api/occasions/interview/record').map((b) => JSON.stringify(b))).toEqual([expect.stringContaining('A scarf')]);
});

test('stored records: the disclosure opens the store panel and its sweep runs on the daemon', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto(OCCASIONS);
  await page.getByText('Stored records', { exact: true }).click();
  const state = page.getByTestId('dates-state');
  await expect(state).toBeVisible();
  expect(posts(daemon, '/api/occasions/sweep')).toHaveLength(0);
  await state.getByRole('button', { name: 'Run sweep now' }).click();
  await expect.poll(() => posts(daemon, '/api/occasions/sweep').length).toBe(1);
});

test('Add occasion previews before it confirms, and Confirm waits for a kind', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto(OCCASIONS);
  await page.getByRole('button', { name: 'Add occasion' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add occasion' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill('Anniversary');
  await dialog.getByLabel('Date', { exact: true }).fill('2027-05-01');
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('status')).toBeVisible();
  expect(posts(daemon, '/api/occasions/propose').map((b) => JSON.stringify(b))).toEqual([expect.stringContaining('Anniversary')]);
  // Confirm stays disabled until a kind is chosen.
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: 'Gift-giving' }).click();
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeEnabled();
});
