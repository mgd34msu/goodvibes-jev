/**
 * LAN-http posture, at a REAL private-network origin (SDK 1.8.0).
 *
 * Runs on the "lan-origin" Playwright project only (playwright.config.ts), which serves
 * THIS app from the host's own real private-network interface address (10/8, 172.16/12,
 * 192.168/16) instead of loopback, so Chromium's OWN secure-context determination is
 * the genuine one for a LAN deployment (privateNetwork:true, secureContext:false), not a
 * mocked window.location. A host without that interface reports an unsupported
 * failure in the harness; requested LAN proof must never become a green skip.
 *
 * Proves:
 *   - the app LOADS here (no "needs HTTPS" wall, that wall now guards a genuinely
 *     public origin only, never a private-network one);
 *   - the microphone, unavailable here, explains itself on tap instead of acting dead;
 *   - a plain `#pair=<token>` hand-off (no offer set) shows the LAN notice once, and a
 *     dismissal sticks across a reload.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { openSettings } from './support/app';
import { installChatMockDaemon } from './support/chat-mock';

test.beforeEach(async ({ baseURL }, testInfo) => {
  const isRealLanOrigin = testInfo.project.name === 'lan-origin'
    && baseURL !== undefined
    && new URL(baseURL).hostname !== '127.0.0.1';
  expect(isRealLanOrigin, 'LAN proof requires the actual private-network HTTP origin').toBe(true);
});

test('the app loads at a real private-network http origin: no "needs HTTPS" wall', async ({ page, baseURL }) => {
  expect(new URL(baseURL ?? '').protocol).toBe('http:');
  await installMockDaemon(page);
  await openSettings(page, 'account');
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('MicButton: tapping the unavailable mic toggles its explanation', async ({ page }) => {
  await installChatMockDaemon(page);
  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const mic = page.locator('.voice-mic-btn');
  await expect(mic).toBeVisible();
  // The bubble is toggled by tapping the crossed mic (a permanent condition must not
  // park a bubble over the composer).
  await expect(page.locator('.voice-mic-note')).toHaveCount(0);
  await mic.click();
  await expect(page.locator('.voice-mic-note')).toBeVisible();
});

test('a plain #pair=<token> hand-off (no offers) shows the LAN notice until dismissed', async ({ page }) => {
  await installMockDaemon(page, { signedIn: false });
  await page.goto('/?view=chat#pair=e2e-lan-token');

  await expect(page.locator('.pairing-posture-notice')).toHaveCount(1);
  // The fragment never lingers.
  await expect.poll(() => new URL(page.url()).hash).not.toContain('pair=');

  // Dismiss, never reappears (the whole point of "never a nag").
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('.pairing-posture-notice')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.pairing-posture-notice')).toHaveCount(0);
});
