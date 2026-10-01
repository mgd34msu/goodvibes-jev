/**
 * The installed app opens offline.
 *
 * Runs against the production build every spec is served from (playwright.config.ts):
 * the service worker caches only built, hashed assets, so what an installed app does
 * with no network is exactly what this build does.
 *
 * The journey: open the app once online (the worker installs and caches the shell),
 * reload so the worker controls the page and caches the built chunks, then drop the
 * network and remove the in-page mock daemon, so nothing answers. Reloading must
 * still render the app from the cache, and say plainly that the daemon cannot be
 * reached, with the saved token kept, rather than show a blank page, the browser's
 * offline error, or the sign-in screen.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';

test('after one online visit, going offline still opens the app and shows the daemon as unreachable', async ({ page, context }) => {
  await installMockDaemon(page);
  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  // The worker is installed and active; a reload puts the page under its control,
  // which is when the built chunks pass through it and land in its cache.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.reload();

  // The React app itself rendered (so the cached shell AND its cached scripts ran):
  // its reconnect control is live, and the token is kept (no sign-in front door).
  await expect(page.getByRole('button', { name: /Retry now|Retrying/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
});
