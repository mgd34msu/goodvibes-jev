/**
 * QR pairing hand-off: opening a `#pair=<token>` link (what the terminal's
 * `goodvibes pair` QR encodes) signs the device in and scrubs the token from the
 * URL, the fragment never lingers in the address bar or history.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';

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
