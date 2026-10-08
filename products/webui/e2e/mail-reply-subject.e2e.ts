import { expect, test, type Page } from '@playwright/test';
import { installMailReplySubjectDaemon } from './support/mail-reply-subject-fixture';
import { installMockDaemon } from './support/mock-daemon';
import { expectNoHorizontalScroll, nextFrames, openNavigation } from './support/app';
const MAIL = '/?view=personal&tab=mail';
async function openReply(page: Page) {
  await page.goto(MAIL);
  await page.getByTestId('mail-list').locator('.mail-row').filter({ hasText: 'Nightly build finished' }).locator('.gv-row__main').click();
  await expect(page.getByTestId('mail-message-detail')).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  const compose = page.getByTestId('mail-compose');
  await expect(compose).toBeVisible();
  return compose;
}
for (const subject of ['RE: Synthetic lunch', 'Re[2]: Synthetic lunch', 'AW: Synthetic lunch', 'SV: Synthetic lunch']) {
  test(`recorded boolean keeps the complete ${subject} subject in the actual Mail flow`, async ({ page }, testInfo) => {
    const daemon = await installMailReplySubjectDaemon(page, { subject });
    const compose = await openReply(page);
    await expect(compose.getByLabel('Subject')).toHaveValue(subject);
    expect(daemon.judgments).toHaveLength(1);
    expect(daemon.judgments[0]?.input).toEqual({ subjectRef: daemon.capture.message.replySubjectRef });
    expect(daemon.requests.filter(item => item.path === '/api/email/send' || item.path === '/api/email/drafts')).toHaveLength(0);
    await expectNoHorizontalScroll(page);
    if (subject === 'RE: Synthetic lunch') await testInfo.attach('Mail reply composer', { body: await page.screenshot(), contentType: 'image/png' });
  });
}
for (const mode of ['uncertain', 'missing-reference', 'unavailable'] as const) {
  test(`${mode} offers explicit manual editing without a guessed subject`, async ({ page }) => {
    const daemon = await installMailReplySubjectDaemon(page, { ...(mode === 'uncertain' ? { subject: 'Synthetic uncertain' } : {}), missingReference: mode === 'missing-reference', fail: mode === 'unavailable' });
    const compose = await openReply(page);
    await expect(compose.getByTestId('mail-reply-subject-status')).toContainText('could not be prepared');
    await expect(compose.getByLabel('Subject')).toHaveValue('');
    await expect(compose.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await compose.getByLabel('Subject').fill('Owner-written subject');
    await compose.getByLabel('Message').fill('Owner-written body');
    await expect(compose.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expect(compose.getByRole('button', { name: 'Save draft to account' })).toBeEnabled();
    expect(daemon.judgments).toHaveLength(mode === 'missing-reference' ? 0 : 1);
    await compose.getByRole('button', { name: 'Save draft to account' }).click();
    await expect.poll(() => daemon.requests.filter(item => item.path === '/api/email/drafts').length).toBe(1);
    expect(daemon.requests.find(item => item.path === '/api/email/drafts')?.body).toMatchObject({ subject: 'Owner-written subject', body: 'Owner-written body', inReplyTo: daemon.capture.message.messageId });
    await expect(compose).toHaveCount(0);
  });
}
for (const action of ['edit', 'close', 'new-compose', 'navigate'] as const) {
  test(`${action} retires a pending subject and its late reading cannot overwrite the draft`, async ({ page }) => {
    const daemon = await installMailReplySubjectDaemon(page, { holdFirst: true });
    try {
      const compose = await openReply(page);
      await expect.poll(() => daemon.pendingCount).toBe(1);
      if (action === 'edit') await compose.getByLabel('Subject').fill('My draft subject');
      if (action === 'close') await compose.getByRole('button', { name: 'Close compose' }).click();
      if (action === 'new-compose') await page.getByRole('button', { name: 'Compose', exact: true }).click();
      if (action === 'navigate') { await page.goto('/?view=library'); await page.goBack(); }
      await daemon.release(); await nextFrames(page);
      if (action === 'close' || action === 'navigate') await expect(compose).toHaveCount(0);
      else await expect(compose.getByLabel('Subject')).toHaveValue(action === 'edit' ? 'My draft subject' : '');
    } finally { await daemon.release(); }
  });
}
test('repeated Reply adopts the newer recorded reading and ignores the cancelled older one', async ({ page }) => {
  const daemon = await installMailReplySubjectDaemon(page, { subject: 'AW: Synthetic lunch', holdFirst: true });
  try {
    const compose = await openReply(page); await expect.poll(() => daemon.pendingCount).toBe(1);
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(compose.getByLabel('Subject')).toHaveValue('AW: Synthetic lunch');
    await daemon.release(); await nextFrames(page);
    await expect(compose.getByLabel('Subject')).toHaveValue('AW: Synthetic lunch');
    expect(daemon.judgments).toHaveLength(2);
  } finally { await daemon.release(); }
});
test('real cross-tab sign-out cancels the pending reply and closes its account-bound draft', async ({ page, context }) => {
  const daemon = await installMailReplySubjectDaemon(page, { holdFirst: true });
  const account = await context.newPage(); await installMockDaemon(account);
  try {
    const compose = await openReply(page); await expect.poll(() => daemon.pendingCount).toBe(1);
    await account.goto('/?view=work'); await openNavigation(account);
    await account.getByRole('button', { name: /^Account:/ }).click();
    await account.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('goodvibes.webui.token'))).toBeNull();
    await daemon.release(); await nextFrames(page);
    await expect(compose).toHaveCount(0);
  } finally { await daemon.release(); await account.close(); }
});
