/**
 * Queued messages (SDK 1.8.0's interaction-wins round), a message posted
 * while another turn is running sits queued until that turn ends. This
 * proves QueuedMessagesPanel end to end against the stateful chat mock:
 * listing, inline edit, and delete, all reaching the real wire verbs
 * (sessions.queuedMessages.list/edit/delete). Runs on both phone and desktop.
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { expectTappable, only, PHONE } from './support/app';

const COMPOSER = 'textarea[aria-label="Message GoodVibes"]';
// The chat mock assigns session ids sequentially per fresh daemon instance,
// the FIRST session created in a test is always 'sess-1'.
const FIRST_SESSION_ID = 'sess-1';

test('a queued message can be edited in place and the edit reaches the daemon', async ({ page }) => {
  const daemon = await installChatMockDaemon(page, {
    queuedMessages: { [FIRST_SESSION_ID]: [{ id: 'q-1', queuedAt: 1000, text: 'Original queued text' }] },
  });
  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const composer = page.locator(COMPOSER);
  await composer.fill('start a chat');
  await composer.press('Enter');
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });

  const panel = page.locator('.queued-messages-panel');
  await expect(panel).toBeVisible();

  await panel.locator('.queued-message__edit').click();
  const textarea = panel.locator('.queued-message__edit-form textarea');
  await textarea.fill('Edited queued text');
  await panel.locator('.queued-message__save').click();

  await expect(textarea).toHaveCount(0);
  await expect.poll(() => daemon.queuedMessagesOf(FIRST_SESSION_ID)).toEqual([
    { id: 'q-1', queuedAt: 1000, text: 'Edited queued text' },
  ]);
});

test('a queued message can be deleted (with confirmation) before it is ever sent', async ({ page }) => {
  const daemon = await installChatMockDaemon(page, {
    queuedMessages: { [FIRST_SESSION_ID]: [{ id: 'q-1', queuedAt: 1000, text: 'Drop this one' }] },
  });
  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const composer = page.locator(COMPOSER);
  await composer.fill('start a chat');
  await composer.press('Enter');
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });

  const panel = page.locator('.queued-messages-panel');
  await expect(panel).toBeVisible();
  await panel.locator('.queued-message__delete').click();
  // The kit confirm dialog asks first; nothing is dropped until the answer.
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  expect(daemon.queuedMessagesOf(FIRST_SESSION_ID)).toHaveLength(1);
  await confirm.getByRole('button', { name: 'Drop message' }).click();

  await expect(page.locator('.queued-messages-panel')).toHaveCount(0);
  await expect.poll(() => daemon.queuedMessagesOf(FIRST_SESSION_ID)).toEqual([]);
});

test('no queued-messages panel renders when nothing is queued (honest absence)', async ({ page }) => {
  await installChatMockDaemon(page);
  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const composer = page.locator(COMPOSER);
  await composer.fill('a plain question');
  await composer.press('Enter');
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });

  await expect(page.locator('.queued-messages-panel')).toHaveCount(0);
});

test.describe('phone: the queued-message edit/delete controls clear the 44px tap-target floor', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('edit and delete buttons are both tappable', async ({ page }) => {
    await installChatMockDaemon(page, {
      queuedMessages: { [FIRST_SESSION_ID]: [{ id: 'q-1', queuedAt: 1000, text: 'Tap target check' }] },
    });
    await page.goto('/?view=chat');
    await expect(page.locator('.app-shell')).toBeVisible();
    const composer = page.locator(COMPOSER);
    await composer.fill('start a chat');
    await composer.press('Enter');
    await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });

    await expect(page.locator('.queued-messages-panel')).toBeVisible();
    await expectTappable(page, '.queued-message__edit', 'queued message edit button');
    await expectTappable(page, '.queued-message__delete', 'queued message delete button');
  });
});
