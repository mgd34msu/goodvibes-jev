/**
 * QR pairing hand-off: opening a `#pair=<token>` link (what the terminal's
 * `goodvibes pair` QR encodes) signs the device in and scrubs the token from the
 * URL, the fragment never lingers in the address bar or history.
 */
import { test, expect, type Route } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { nextFrames } from './support/app';

test('a pairing link signs in and strips the token from the URL', async ({ page }) => {
  // Boot signed OUT (no seeded token): the fragment is the only way in.
  await installMockDaemon(page, { signedIn: false });

  await page.goto('/#pair=paired-operator-token');

  // The shell reveals (the mock daemon reports the token as authenticated).
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.signed-out-gate')).toHaveCount(0);

  // The one-time token is gone from the URL fragment (history.replaceState).
  await expect
    .poll(() => new URL(page.url()).hash)
    .not.toContain('pair=');
});

test('signed out, the gate offers pairing and the manual token field instead of the shell', async ({ page }) => {
  await installMockDaemon(page, { signedIn: false });

  await page.goto('/');

  const gate = page.locator('.signed-out-gate');
  await expect(gate).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  await expect(page.locator('.signed-out-pair')).toBeVisible();
  // The manual token field is still present as the fallback.
  await expect(page.locator('.signed-out-card input[type="password"]').first()).toBeVisible();
});

test('pairing replaces pending anonymous auth probes and ignores their late rejection', async ({ page }) => {
  await installMockDaemon(page, { signedIn: false });
  const anonymous: Route[] = [];
  await page.route('**/api/control-plane/auth', async (route) => {
    const authorization = route.request().headers()['authorization'];
    if (!authorization) {
      // Hold the first-load response until AFTER the authenticated shell renders.
      // A mere invalidate joins this pending query and can never reveal the shell.
      anonymous.push(route);
      return;
    }
    expect(authorization).toBe('Bearer paired-operator-token');
    await route.fallback();
  });

  await page.goto('/#pair=paired-operator-token');
  await expect.poll(() => anonymous.length).toBeGreaterThan(0);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.signed-out-gate')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).hash).not.toContain('pair=');

  // The old transport is deliberately allowed to finish; cancelling its query
  // must prevent the result from replacing the newly authenticated query state.
  await Promise.all(anonymous.map(async (route) => {
    const response = route.request().response();
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unauthorized' }),
    });
    await (await response)?.finished();
  }));
  await nextFrames(page);
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.signed-out-gate')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('goodvibes.webui.token'))).toBe('paired-operator-token');
});
