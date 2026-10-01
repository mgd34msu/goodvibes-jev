/**
 * The memory journey on the Library page: search and browse, the recall-honesty degrade,
 * add (a dialog), review (a record's pane on the Review tab), delete-means-delete (a
 * confirmation dialog), and the persona group, on BOTH phone and desktop viewports (no
 * `only()` gate: this suite is not phone-exclusive). Every step runs against the hermetic
 * mock daemon (e2e/support/mock-daemon.ts); no real daemon is ever contacted.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { MEMORY_FACT, MEMORY_PERSONA, MEMORY_REVIEW_CANDIDATE } from './support/seed';
import { expectNoHorizontalScroll } from './support/app';

test('the library loads the seeded records', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=library&tab=memory');
  await expect(page.locator('.app-shell')).toBeVisible();

  const records = page.getByRole('list', { name: 'Records' }).getByRole('listitem');
  await expect(records.filter({ hasText: MEMORY_FACT.summary })).toHaveCount(1);
  await expect(records.filter({ hasText: MEMORY_REVIEW_CANDIDATE.summary })).toHaveCount(1);
  await expectNoHorizontalScroll(page);
});

test('a semantic search against an unavailable index raises the degraded banner, never a silent empty result', async ({ page }) => {
  await installMockDaemon(page, { memoryIndexUnavailable: true });
  await page.goto('/?view=library&tab=memory');
  await expect(page.getByRole('group', { name: 'Memory filters' })).toBeVisible();

  await page.getByRole('checkbox', { name: 'Semantic' }).setChecked(true, { force: true });
  await page.getByLabel('Search memory and knowledge').fill('daemon');

  const degraded = page.locator('.lib-honesty__banner--degraded');
  await expect(degraded).toBeVisible();
});

test('add a memory: the dialog saves it and it appears in the list without a full reload', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto('/?view=library&tab=memory');
  await expect(page.getByRole('group', { name: 'Memory filters' })).toBeVisible();

  const summary = 'Playwright proved the add-a-memory dialog round-trips';
  await page.getByRole('button', { name: 'Add memory' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add memory' });
  await dialog.getByLabel('Memory summary').fill(summary);
  await dialog.getByRole('button', { name: 'Add memory' }).click();

  await expect(dialog).toHaveCount(0);
  expect(daemon.requests.filter((r) => r.method === 'POST' && r.path === '/api/memory/records')
    .map((r) => (r.body as { summary?: string }).summary)).toEqual([summary]);
  const records = page.getByRole('list', { name: 'Records' }).getByRole('listitem');
  await expect(records.filter({ hasText: summary })).toHaveCount(1, { timeout: 10_000 });
  // The pre-existing seeded record is still there, add is additive, not a replace.
  await expect(records.filter({ hasText: MEMORY_FACT.summary })).toHaveCount(1);
});

test('review: saving a review state from the Review tab sends it for that record', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto('/?view=library&tab=review');
  const queue = page.getByRole('list', { name: 'Review queue' });
  await queue.getByRole('button', { name: new RegExp(MEMORY_REVIEW_CANDIDATE.summary) }).click();

  const pane = page.getByRole('region', { name: 'Review item' });
  await pane.getByRole('combobox', { name: `Review state for ${MEMORY_REVIEW_CANDIDATE.summary}` }).click();
  await page.getByRole('option', { name: 'Reviewed' }).click();
  expect(daemon.requests.filter((r) => r.path.endsWith('/review'))).toHaveLength(0);
  await pane.getByRole('button', { name: 'Save review' }).click();

  await expect.poll(() => daemon.requests
    .filter((r) => r.method === 'POST' && r.path === `/api/memory/records/${MEMORY_REVIEW_CANDIDATE.id}/review`)
    .map((r) => JSON.stringify(r.body))).toEqual([expect.stringContaining('reviewed')]);
});

test('delete means delete. The record is gone after a confirmation, not just hidden behind a client filter', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto('/?view=library&tab=memory');
  const records = page.getByRole('list', { name: 'Records' });
  await records.getByRole('button', { name: new RegExp(MEMORY_FACT.summary) }).click();

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  const deletes = () => daemon.requests.filter((r) => r.method === 'DELETE' && r.path === `/api/memory/records/${MEMORY_FACT.id}`);
  expect(deletes()).toHaveLength(0);
  await confirm.getByRole('button', { name: 'Delete memory' }).click();
  await expect.poll(() => deletes().length).toBe(1);

  // Gone from the list AND the Review tab (it was 'fresh'; deletion removes the
  // underlying record, not merely this list's view of it).
  await expect(records.getByRole('listitem').filter({ hasText: MEMORY_FACT.summary })).toHaveCount(0, { timeout: 10_000 });
  await page.getByRole('radio', { name: /^Review/ }).click();
  const queue = page.getByRole('list', { name: 'Review queue' }).getByRole('listitem');
  await expect(queue.first()).toBeVisible();
  await expect(queue.filter({ hasText: MEMORY_FACT.summary })).toHaveCount(0);
});

test('a vibe-tagged constraint record renders under Personas', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=library&tab=memory');
  await expect(page.getByRole('list', { name: 'Personas' }).getByRole('listitem').filter({ hasText: MEMORY_PERSONA.summary })).toHaveCount(1);
});

test('a daemon that does not serve memory leaves the shell working and shows no filters or records', async ({ page }) => {
  await installMockDaemon(page, { memoryAvailable: false });
  await page.goto('/?view=library&tab=memory');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Memory', checked: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Memory filters' })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Records' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('the old ?view=memory link still lands on the Library Memory tab', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=memory');
  await expect(page.getByRole('radio', { name: 'Memory', checked: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Records' }).getByRole('listitem').filter({ hasText: MEMORY_FACT.summary })).toHaveCount(1);
});
