/**
 * Two chats, switched between: each shows only its own messages, and the composer
 * sends to whichever chat is selected. Proven against the stateful chat mock, whose
 * per-session message store is the record of where each send actually landed.
 */
import { test, expect, type Page } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { closeNavigation, openNavigation } from './support/app';

const COMPOSER = 'textarea[aria-label="Message GoodVibes"]';

/** The chat list ("Recent") lives in the sidebar, a drawer on a phone: open it when it is hidden. */
async function showChatList(page: Page): Promise<void> {
  await openNavigation(page);
  await expect(page.locator('.shell-recent').first()).toBeVisible();
}

/** On a phone, picking from the drawer closes it; make sure it is gone before typing. */
async function hideDrawerIfCovering(page: Page): Promise<void> {
  await closeNavigation(page);
}

/** Activate a sidebar control from the keyboard, the way a keyboard user reaches it. */
async function activate(page: Page, control: ReturnType<Page['locator']>): Promise<void> {
  await control.focus();
  await page.keyboard.press('Enter');
}

/** The visible navigation: the phone drawer when open, else the desktop sidebar. */
function nav(page: Page): ReturnType<Page['locator']> {
  return page.locator('.shell-drawer, .shell-sidebar').first();
}

async function openChat(page: Page, titleFragment: string): Promise<void> {
  await showChatList(page);
  await activate(page, nav(page).locator('.shell-recent__open', { hasText: titleFragment }));
  await hideDrawerIfCovering(page);
}

async function newChat(page: Page): Promise<void> {
  await showChatList(page);
  await activate(page, nav(page).getByRole('button', { name: 'New chat' }));
  await hideDrawerIfCovering(page);
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator(COMPOSER);
  await composer.fill(text);
  await page.locator('.send-button').click();
  await expect(page.locator('.message.user', { hasText: text })).toBeVisible();
}

async function expectTranscript(page: Page, userTexts: string[]): Promise<void> {
  const users = page.locator('.message.user');
  await expect(users).toHaveCount(userTexts.length);
  for (const [index, text] of userTexts.entries()) await expect(users.nth(index)).toContainText(text);
}

test('two chats keep their own messages, and the composer sends to the selected chat', async ({ page }) => {
  const daemon = await installChatMockDaemon(page);
  await page.goto('/?view=chat');
  await expect(page.locator(COMPOSER)).toBeVisible();

  // Chat A.
  await send(page, 'alpha: first question');
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect.poll(() => daemon.sessionIds().length).toBe(1);
  const [alpha] = daemon.sessionIds();

  // Chat B, from "New chat".
  await newChat(page);
  await send(page, 'beta: first question');
  await expect.poll(() => daemon.sessionIds().length).toBe(2);
  const [, beta] = daemon.sessionIds();
  await expectTranscript(page, ['beta: first question']);

  // Back to A: only A's messages, and a send lands in A.
  await openChat(page, 'alpha');
  await expectTranscript(page, ['alpha: first question']);
  await send(page, 'alpha: follow-up');
  await expectTranscript(page, ['alpha: first question', 'alpha: follow-up']);

  // To B again: only B's messages, and a send lands in B.
  await openChat(page, 'beta');
  await expectTranscript(page, ['beta: first question']);
  await send(page, 'beta: follow-up');
  await expectTranscript(page, ['beta: first question', 'beta: follow-up']);

  // Where the daemon recorded each send.
  const userBodies = (id: string | undefined) => daemon.messagesOf(id ?? '').filter((m) => m.role === 'user').map((m) => m.content);
  expect(userBodies(alpha)).toEqual(['alpha: first question', 'alpha: follow-up']);
  expect(userBodies(beta)).toEqual(['beta: first question', 'beta: follow-up']);
});
