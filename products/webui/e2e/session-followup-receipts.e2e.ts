/** Real daemon route bytes, real browser SDK/composer, phone and desktop. */
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, expectTappable } from './support/app';
import { installFollowUpDaemon } from './support/session-followup-fixture';

type Fixture = Awaited<ReturnType<typeof installFollowUpDaemon>>;
const receipt = (page: Page) => page.getByRole('list', { name: 'Recent dispatches' }).getByRole('listitem');
const state = (page: Page) => receipt(page).locator('.steer-dispatch__state');

async function openSession(page: Page, fixture: Fixture) {
  await page.clock.install();
  await page.goto('/?view=work&tab=sessions');
  await page.getByRole('button', { name: new RegExp(fixture.capture.session.title) }).click();
  await expect(page.getByRole('textbox', { name: 'Follow-up message' })).toBeVisible();
  await expect(page.getByText('Follow-up: no agent is working, this queues a turn')).toBeVisible();
}

async function sendFollowUp(page: Page, fixture: Fixture) {
  const input = page.getByRole('textbox', { name: 'Follow-up message' });
  await input.fill(fixture.capture.input.body);
  await input.press('Enter');
  await expect(state(page)).toHaveText('follow-up · queued');
  await expect(input).toHaveValue('');
  await expect.poll(() => fixture.reads.length).toBeGreaterThan(0);
  expect(fixture.writes).toEqual([{ method: 'POST', path: fixture.capture.post.path, body: fixture.capture.post.requestBody }]);
}

async function pollInputs(page: Page, fixture: Fixture) {
  const before = fixture.reads.length;
  const nextRead = page.waitForResponse(response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === fixture.capture.queued.path);
  // Advance the actual React Query timer, without an invented session event or
  // reload. Both the 15s connected and 5s reconnecting fallbacks fit this tick.
  await page.clock.fastForward(16_000);
  await (await nextRead).finished();
  await expect.poll(() => fixture.reads.length).toBeGreaterThan(before);
}

test('202 is queued, collection is delivered, consumption is completed without resend', async ({ page }, testInfo) => {
  const fixture = await installFollowUpDaemon(page);
  await openSession(page, fixture);
  await sendFollowUp(page, fixture);
  await pollInputs(page, fixture);
  await expect(state(page)).toHaveText('follow-up · queued');
  fixture.setPhase('delivered');
  await pollInputs(page, fixture);
  await expect(state(page)).toHaveText('follow-up · delivered');
  fixture.setPhase('terminal');
  await pollInputs(page, fixture);
  await expect(state(page)).toHaveText('follow-up · completed');
  await expect(receipt(page)).toHaveCount(1);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.steerRequests).toHaveLength(0);
  await expectNoHorizontalScroll(page);
  await receipt(page).scrollIntoViewIfNeeded();
  await expect(receipt(page)).toBeVisible();
  await testInfo.attach('completed follow-up receipt', { body: await page.screenshot(), contentType: 'image/png' });
});

for (const outcome of ['failed', 'cancelled'] as const) {
  test(`polling displays actual ${outcome} input state without retrying the follow-up`, async ({ page }) => {
    const fixture = await installFollowUpDaemon(page, outcome);
    await openSession(page, fixture);
    await sendFollowUp(page, fixture);
    fixture.setPhase('terminal');
    await pollInputs(page, fixture);
    await expect(state(page)).toHaveText(`follow-up · ${outcome}`);
    if (outcome === 'failed') {
      const reason = fixture.capture.terminalInput.error;
      if (!reason) throw new Error('The real failed-input capture is missing its reason');
      await expect(receipt(page)).toContainText(reason);
    }
    await page.clock.fastForward(31_000);
    await expect(state(page)).toHaveText(`follow-up · ${outcome}`);
    expect(fixture.writes).toHaveLength(1);
  });
}

test('Shift+Enter and IME keep the draft; plain Enter and the send button safely send once', async ({ page }, testInfo) => {
  const fixture = await installFollowUpDaemon(page);
  await openSession(page, fixture);
  const input = page.getByRole('textbox', { name: 'Follow-up message' });
  const send = page.getByRole('button', { name: 'Queue follow-up' });
  await expect(send).toBeDisabled();
  await input.fill('   ');
  await input.press('Enter');
  await expect(send).toBeDisabled();
  expect(fixture.writes).toHaveLength(0);
  await input.fill('First line');
  await input.press('End');
  await input.press('Shift+Enter');
  await input.pressSequentially('Second line');
  await expect(input).toHaveValue('First line\nSecond line');
  expect(fixture.writes).toHaveLength(0);
  await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true,
  })));
  await expect(input).toHaveValue('First line\nSecond line');
  expect(fixture.writes).toHaveLength(0);
  await expect(send).toBeVisible();
  await expect(send).toBeEnabled();
  // The shared UI kit applies the 44px target to coarse pointers; desktop uses
  // the intentionally compact 34px control, as in the existing touch audit.
  if (testInfo.project.name === 'phone') await expectTappable(page, '.steer-composer__send');
  await input.fill(fixture.capture.input.body);
  await send.click();
  await expect(state(page)).toHaveText('follow-up · queued');
  await input.press('Enter');
  await expect(send).toBeDisabled();
  expect(fixture.writes).toHaveLength(1);
  await expectNoHorizontalScroll(page);
});

test('failed receipt refresh preserves the last confirmed state and recovers by polling', async ({ page }) => {
  const fixture = await installFollowUpDaemon(page);
  await openSession(page, fixture);
  await sendFollowUp(page, fixture);
  fixture.setReadFailure(true);
  await pollInputs(page, fixture);
  await expect(page.getByText('Delivery status could not be refreshed.', { exact: false })).toBeVisible();
  await expect(state(page)).toHaveText('follow-up · queued');
  fixture.setReadFailure(false);
  fixture.setPhase('terminal');
  await pollInputs(page, fixture);
  await expect(state(page)).toHaveText('follow-up · completed');
  await expect(page.getByText('Delivery status could not be refreshed.', { exact: false })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
});

test('lost POST response is unknown and never automatically resent', async ({ page }) => {
  const fixture = await installFollowUpDaemon(page, 'completed', { postResponse: 'disconnected' });
  await openSession(page, fixture);
  const input = page.getByRole('textbox', { name: 'Follow-up message' });
  await input.fill(fixture.capture.input.body);
  await input.press('Enter');
  await expect(state(page)).toHaveText('follow-up · unknown');
  await expect(receipt(page)).toContainText('Check the transcript before sending again');
  await page.clock.fastForward(61_000);
  await expect(state(page)).toHaveText('follow-up · unknown');
  expect(fixture.writes).toHaveLength(1);
});
