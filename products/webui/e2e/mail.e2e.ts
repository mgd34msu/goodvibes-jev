/**
 * Mail tab of Personal, proven against a real HTTP round-trip through the mock
 * daemon (not a unit-mocked module), mirroring calendar.e2e.ts's shape for the
 * sibling surface. Covers all three honest refusal states plus the populated
 * inbox / message / compose happy path, the HTML-suppression restraint, and the
 * mobile no-horizontal-scroll sweep.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { expectNoHorizontalScroll, only, PHONE } from './support/app';

const MAIL = '/?view=personal&tab=mail';

test('default options (email not-available): one empty state with one action, and no compose form at all', async ({ page }) => {
  await installMockDaemon(page); // default email: 'not-available'
  await page.goto(MAIL);
  const note = page.getByTestId('mail-note-not-available');
  await expect(note).toBeVisible();
  await expect(note.getByRole('button')).toHaveCount(1);
  await expect(note.getByRole('button', { name: 'Update daemon' })).toBeVisible();
  await expect(page.getByTestId('mail-list')).toHaveCount(0);

  // Nothing disabled, nothing to fill in: no Compose, no form, no fields.
  await expect(page.getByRole('button', { name: 'Compose' })).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Send$/ })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('the empty state action opens the About section of settings', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto(MAIL);
  await page.getByRole('button', { name: 'Update daemon' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page).toHaveURL(/settings=about/);
});

test('configured: the inbox lists both seeded messages', async ({ page }) => {
  await installMockDaemon(page, { email: 'configured' });
  await page.goto(MAIL);
  const list = page.getByTestId('mail-list');
  await expect(list).toBeVisible();
  const rows = list.locator('.mail-row');
  await expect(rows).toHaveCount(2);
  await expectNoHorizontalScroll(page);
});

test('configured: opening a row reads that message and shows its detail', async ({ page }) => {
  const daemon = await installMockDaemon(page, { email: 'configured' });
  await page.goto(MAIL);
  await page.getByTestId('mail-list').locator('.mail-row').filter({ hasText: 'Nightly build finished' }).locator('.gv-row__main').click();
  await expect(page.getByTestId('mail-message-detail')).toBeVisible();
  await expect.poll(() => daemon.requests.some((r) => r.method === 'GET' && r.path === '/api/email/inbox/1002')).toBe(true);
  await expectNoHorizontalScroll(page);
});

test('configured: the message for uid 1002 never renders the HTML alternative as markup', async ({ page }) => {
  await installMockDaemon(page, { email: 'configured' });
  await page.goto(MAIL);
  // uid 1002 ("Nightly build finished") is seeded first (most recent date) and is the
  // one row carrying bodyHtml + an attachment.
  await page.getByTestId('mail-list').locator('.mail-row').filter({ hasText: 'Nightly build finished' }).locator('.gv-row__main').click();
  const detail = page.getByTestId('mail-message-detail');
  await expect(detail).toBeVisible();
  // The literal HTML source string must not appear turned into markup, no <b>
  // element inside the message body, even though the fixture's bodyHtml contains one.
  await expect(detail.locator('b')).toHaveCount(0);
});

test('configured: Compose opens a panel at the lower right, Send enables once filled in, and confirming sends it', async ({ page }) => {
  const daemon = await installMockDaemon(page, { email: 'configured' });
  await page.goto(MAIL);
  await expect(page.getByTestId('mail-list')).toBeVisible();
  await page.getByRole('button', { name: 'Compose' }).click();
  const compose = page.getByTestId('mail-compose');
  await expect(compose).toBeVisible();

  const viewport = page.viewportSize();
  const box = await compose.boundingBox();
  expect(box).not.toBeNull();
  if (box && viewport) {
    // Inside the window, hugging the bottom; never wider than 480.
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
    expect(box.width).toBeLessThanOrEqual(481);
  }

  const send = compose.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeDisabled();
  await compose.getByLabel('To', { exact: true }).fill('someone@example.com');
  await compose.getByLabel('Subject').fill('Hello');
  await compose.getByLabel('Message').fill('A short note.');
  await expect(send).toBeEnabled();
  await expectNoHorizontalScroll(page);

  await send.click();
  await expect(page.locator('.gv-confirm')).toBeVisible();
  // Nothing goes out before the confirmation.
  expect(daemon.requests.filter((r) => r.path === '/api/email/send')).toHaveLength(0);
  await page.locator('.gv-confirm__confirm').click();
  await expect.poll(() => daemon.requests.filter((r) => r.method === 'POST' && r.path === '/api/email/send').length).toBe(1);
  const sent = JSON.stringify(daemon.requests.find((r) => r.path === '/api/email/send')?.body);
  for (const value of ['someone@example.com', 'Hello', 'A short note.']) expect(sent).toContain(value);
  await expect(compose).toHaveCount(0);
});

test('configured: Reply opens the compose panel prefilled with the sender and a Re: subject', async ({ page }) => {
  await installMockDaemon(page, { email: 'configured' });
  await page.goto(MAIL);
  await page.getByTestId('mail-list').locator('.mail-row').filter({ hasText: 'Nightly build finished' }).locator('.gv-row__main').click();
  await expect(page.getByTestId('mail-message-detail')).toBeVisible();
  await page.getByRole('button', { name: 'Reply' }).click();
  const compose = page.getByTestId('mail-compose');
  await expect(compose).toBeVisible();
  await expect(compose.getByLabel('To', { exact: true })).toHaveValue('ops@example.com');
  await expect(compose.getByLabel('Subject')).toHaveValue('Re: Nightly build finished');
});

test('unconfigured: the needs-setup empty state appears with an Open settings action', async ({ page }) => {
  await installMockDaemon(page, { email: 'unconfigured' });
  await page.goto(MAIL);
  const note = page.getByTestId('mail-note-needs-setup');
  await expect(note).toBeVisible();
  await expect(note.getByRole('button', { name: 'Open settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Compose' })).toHaveCount(0);
});

test.describe('phone: the mail tab never forces the page wider', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('no horizontal scroll on the configured inbox', async ({ page }) => {
    await installMockDaemon(page, { email: 'configured' });
    await page.goto(MAIL);
    await expect(page.getByTestId('mail-list')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the compose panel is a full-width bottom sheet', async ({ page }) => {
    await installMockDaemon(page, { email: 'configured' });
    await page.goto(MAIL);
    await expect(page.getByTestId('mail-list')).toBeVisible();
    await page.getByRole('button', { name: 'Compose' }).click();
    const box = await page.getByTestId('mail-compose').boundingBox();
    expect(box?.x ?? -1).toBeLessThanOrEqual(1);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(388);
    await expectNoHorizontalScroll(page);
  });
});
