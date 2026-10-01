/**
 * Turn control, server-side stop, steer, and queue-when-busy (SDK 1.4).
 *
 * Hermetic against the stateful chat mock in holdReplies mode: a send leaves
 * the turn visibly active so Stop / steer / queued markers are exercisable.
 * Runs on desktop (Ctrl+Enter steer) and phone (hold-to-steer) projects.
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { nextFrames } from './support/app';

const COMPOSER = 'textarea[aria-label="Message GoodVibes"]';

test('Stop requests the server-side cancel; the stopped partial is kept and marked cancelled', async ({ page }) => {
  const daemon = await installChatMockDaemon(page, { holdReplies: true });
  await page.goto('/?view=chat');
  const composer = page.locator(COMPOSER);
  await composer.fill('long question');
  await composer.press('Enter');

  // The turn is held open, the Stop affordance appears.
  const stopButton = page.getByRole('button', { name: 'Stop generating' });
  await expect(stopButton).toBeVisible();
  await stopButton.click();

  // The wire cancel was issued (not just a local render stop)…
  await expect.poll(() => daemon.cancelCalls.length).toBe(1);
  // …the daemon persisted the partial as cancelled, and it renders with its stopped marker.
  const [sessionId] = daemon.sessionIds();
  expect(daemon.messagesOf(sessionId ?? '').filter((m) => m.role === 'assistant').map((m) => m.deliveryState)).toEqual(['cancelled']);
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect(page.locator('.delivery-indicator.cancelled')).toHaveCount(1);
});

test('a send during an active turn is added to the transcript with the queued marker', async ({ page }) => {
  await installChatMockDaemon(page, { holdReplies: true });
  await page.goto('/?view=chat');
  const composer = page.locator(COMPOSER);
  await composer.fill('first question');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();

  await composer.fill('second question');
  await composer.press('Enter');

  await expect(page.locator('.message.user')).toHaveCount(2);
  await expect(page.locator('.delivery-indicator.queued')).toHaveCount(1);
});

test('Ctrl+Enter steers: the wire steer lands, the interrupted partial is kept, the steered reply answers', async ({ page }) => {
  const daemon = await installChatMockDaemon(page, { holdReplies: true });
  await page.goto('/?view=chat');
  const composer = page.locator(COMPOSER);
  await composer.fill('doomed question');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();

  await composer.fill('urgent correction');
  await composer.press('Control+Enter');

  await expect.poll(() => daemon.steerCalls.length).toBe(1);
  expect(daemon.steerCalls[0]!.body).toBe('urgent correction');
  // The interrupted turn's partial is retained and badged; the steer is answered.
  const [sessionId] = daemon.sessionIds();
  await expect.poll(() => daemon.messagesOf(sessionId ?? '').filter((m) => m.role === 'assistant').map((m) => m.deliveryState ?? 'answered'))
    .toEqual(['cancelled', 'answered']);
  await expect(page.locator('.message.assistant')).toHaveCount(2);
  await expect(page.locator('.delivery-indicator.cancelled')).toHaveCount(1);
});

test('press-and-hold on the send button steers (the touch counterpart of Ctrl+Enter)', async ({ page }) => {
  const daemon = await installChatMockDaemon(page, { holdReplies: true });
  await page.goto('/?view=chat');
  const composer = page.locator(COMPOSER);
  await composer.fill('hands-free steer');

  const send = page.locator('.send-button');
  const box = await send.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  // The hold fires the steer while the button is still pressed.
  await expect.poll(() => daemon.steerCalls.length).toBe(1);
  await page.mouse.up();

  expect(daemon.steerCalls[0]!.body).toBe('hands-free steer');
  // Releasing after the hold fired does not also submit the draft as a send.
  await nextFrames(page);
  expect(daemon.steerCalls).toHaveLength(1);
});
