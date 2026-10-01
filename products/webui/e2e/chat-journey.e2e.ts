/**
 * Chat journey, the modern-chat-app core, proven end to end on BOTH the desktop and
 * phone projects against a stateful hermetic mock (no real daemon, no 3421/4444).
 *
 * Covers the honest-lineage centerpiece: send a message and get a reply, auto-title the
 * fresh chat, regenerate a response (the prior response is RETAINED and viewable, not
 * gone), and edit a message and branch (the original is RETAINED and viewable). The
 * lineage assertions are the point: superseded history must stay in the UI, never be
 * silently dropped.
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { expectNoHorizontalScroll } from './support/app';

// A multi-line first message so the derived auto-title (first line) differs visibly from
// the crude create-time slice, makes the auto-title observable.
const FIRST_MESSAGE = 'Promises in JavaScript\nExplain how they work, including the microtask queue and async/await.';
const DERIVED_TITLE = 'Promises in JavaScript';

test('send, auto-title, regenerate-with-retained-history, and edit-and-branch', async ({ page }) => {
  const daemon = await installChatMockDaemon(page);

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toBeVisible();

  // ── Send the first message ────────────────────────────────────────────────
  await composer.fill(FIRST_MESSAGE);
  await page.locator('.send-button').click();

  // The user bubble and the streamed-then-persisted assistant reply both land.
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });
  await expect.poll(() => daemon.sessionIds().length).toBe(1);
  const [sessionId = ''] = daemon.sessionIds();
  const stored = (role: 'user' | 'assistant') => daemon.messagesOf(sessionId).filter((m) => m.role === role);
  expect(stored('user').map((m) => m.content)).toEqual([FIRST_MESSAGE]);

  // ── Auto-title: the crude create-time title is replaced by the derived one ──
  await expect
    .poll(() => daemon.titleUpdates.map((u) => u.title), { timeout: 15_000 })
    .toContain(DERIVED_TITLE);

  // ── Regenerate: the prior response is superseded but RETAINED and viewable ──
  await page.locator('.message.assistant button[aria-label="Regenerate response"]').first().click();
  // The daemon keeps the prior response, superseded by the regeneration, beside the fresh one.
  await expect.poll(() => stored('assistant').map((m) => m.supersededReason ?? 'active'), { timeout: 15_000 })
    .toEqual(['regenerate', 'active']);
  // Exactly one active assistant bubble, the old one is not a second live bubble.
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  // The lineage toggle appears; the prior response is retained behind it.
  const regenToggle = page.locator('.message.assistant .message-lineage__toggle');
  await expect(page.locator('.retained-message')).toHaveCount(0);
  await regenToggle.click();
  await expect(page.locator('.retained-message')).toHaveCount(1);

  // ── Edit and branch: the original message is superseded but RETAINED ────────
  await page.locator('.message.user button[aria-label="Edit and resend message"]').first().click();
  const editArea = page.locator('textarea[aria-label="Edit message"]');
  await expect(editArea).toBeVisible();
  await editArea.fill('Explain JavaScript generators instead.');
  await page.locator('button[aria-label="Send edited message (Ctrl+Enter)"]').click();

  // The daemon holds the edited question as the active one and keeps the original, superseded by the edit.
  await expect.poll(() => stored('user').map((m) => [m.content, m.supersededReason ?? 'active']), { timeout: 15_000 }).toEqual([
    [FIRST_MESSAGE, 'edit'],
    ['Explain JavaScript generators instead.', 'active'],
  ]);
  // One live question, marked edited, with one live reply.
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message-meta__edited')).toHaveCount(1);
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });
  // The original question is retained and viewable behind the edited message's toggle.
  await page.locator('.message.user .message-lineage__toggle').first().click();
  await expect(page.locator('.message-lineage__retained')).toBeVisible();

  // The cardinal phone sin, no sideways scroll at any point.
  await expectNoHorizontalScroll(page);
});

test('a new-chat suggestion fills the composer without sending; the find bar opens from the header and Esc closes it', async ({ page }, testInfo) => {
  await installChatMockDaemon(page);
  await page.goto('/?view=chat');
  // A suggestion fills the composer; it does not send.
  await page.locator('.chat-suggestion', { hasText: 'Check my mail' }).click();
  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toHaveValue(/Check my mail/);
  await expect(page.locator('.message.user')).toHaveCount(0);

  await page.locator('.send-button').click();
  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });

  // The chat's own search band is gone; the header's find button (Ctrl F on desktop) opens a glass find bar.
  if (testInfo.project.name === 'desktop') {
    await composer.click();
    await page.keyboard.press('Control+f');
  } else {
    await page.getByRole('button', { name: 'Find in chats' }).click();
  }
  const field = page.locator('.chat-find input[type="search"]');
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.chat-find')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
