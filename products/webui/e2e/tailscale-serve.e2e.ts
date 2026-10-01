/**
 * Tailscale one-action https (tailscale.get / tailscale.serve.run, SDK 1.8.0's
 * LAN-http posture work). Proves: absence is quiet (no panel, no nag, no dead
 * button); a usable tailscale environment offers "Serve over tailscale" behind
 * the shared ConfirmSheet idiom; the resulting receipt (success or failure)
 * renders honestly; the action clears the 44px touch-target floor on a phone
 * viewport. The panel lives in the settings dialog's Network section. Runs on
 * both phone and desktop (default project set).
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { expectTappable, only, PHONE, openSettings } from './support/app';

test('tailscale absent: the panel renders nothing, no nag, no dead button', async ({ page }) => {
  await installMockDaemon(page);
  await openSettings(page, 'network');
  await expect(page.locator('[data-testid="tailscale-settings"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Serve over tailscale' })).toHaveCount(0);
});

test('tailscale installed but not logged in: still quiet, no action offered', async ({ page }) => {
  await installMockDaemon(page, {
    tailscale: { available: true, loggedIn: false, detail: 'tailscale is installed but not connected (state: Stopped)' },
  });
  await openSettings(page, 'network');
  await expect(page.locator('[data-testid="tailscale-settings"]')).toHaveCount(0);
});

test('a usable tailscale environment offers the one action, gated by confirm', async ({ page }) => {
  const daemon = await installMockDaemon(page, {
    tailscale: { available: true, loggedIn: true, magicDnsName: 'my-host.tailnet.ts.net', httpsUrl: 'https://my-host.tailnet.ts.net', detail: 'tailscale is connected as my-host.tailnet.ts.net' },
  });
  await openSettings(page, 'network');
  const panel = page.locator('[data-testid="tailscale-settings"]');
  await expect(panel).toBeVisible();

  const serveButton = panel.getByRole('button', { name: 'Serve over tailscale' });
  await expect(serveButton).toBeVisible();
  await serveButton.click();

  // Gated by the shared confirm-sheet idiom, not applied on the raw click.
  await expect(page.locator('.gv-confirm')).toBeVisible();
  expect(daemon.invocations('tailscale.serve.run')).toHaveLength(0);
  await page.locator('.gv-confirm__confirm').click();
  await expect.poll(() => daemon.invocations('tailscale.serve.run').length).toBe(1);

  // The resulting receipt renders the real https MagicDNS URL, as a link.
  await expect(panel.locator('.tailscale-panel__receipt--ok')).toBeVisible();
  await expect(panel.locator('.tailscale-panel__receipt--ok a')).toHaveAttribute('href', /^https:\/\/.+\.ts\.net$/);
});

test('cancelling the confirm sheet never runs serve', async ({ page }) => {
  const daemon = await installMockDaemon(page, {
    tailscale: { available: true, loggedIn: true, magicDnsName: 'my-host.tailnet.ts.net', httpsUrl: 'https://my-host.tailnet.ts.net', detail: 'connected' },
  });
  await openSettings(page, 'network');
  const panel = page.locator('[data-testid="tailscale-settings"]');
  await panel.getByRole('button', { name: 'Serve over tailscale' }).click();
  await expect(page.locator('.gv-confirm')).toBeVisible();
  await page.locator('.gv-confirm__cancel').click();
  await expect(page.locator('.gv-confirm')).toHaveCount(0);
  await expect(panel.locator('.tailscale-panel__receipt--ok')).toHaveCount(0);
  expect(daemon.invocations('tailscale.serve.run')).toHaveLength(0);
});

test('no MagicDNS name resolved: still quiet, the same honest gating as full absence', async ({ page }) => {
  await installMockDaemon(page, {
    // No httpsUrl (available but no resolvable MagicDNS route), the "usable" gate
    // (available && loggedIn && httpsUrl) never opens, matching the daemon's own
    // affordance-gating contract.
    tailscale: { available: true, loggedIn: true, detail: 'tailscale is connected but reports no MagicDNS name' },
  });
  await openSettings(page, 'network');
  await expect(page.locator('[data-testid="tailscale-settings"]')).toHaveCount(0);
});

test('a failed serve (e.g. a permission error) renders a failure receipt, never a success link', async ({ page }) => {
  await installMockDaemon(page, {
    tailscale: {
      available: true, loggedIn: true, magicDnsName: 'my-host.tailnet.ts.net', httpsUrl: 'https://my-host.tailnet.ts.net',
      detail: 'connected', serveFailsWith: 'tailscale serve failed: permission denied',
    },
  });
  await openSettings(page, 'network');
  const panel = page.locator('[data-testid="tailscale-settings"]');
  await panel.getByRole('button', { name: 'Serve over tailscale' }).click();
  await page.locator('.gv-confirm__confirm').click();
  const failed = panel.locator('.tailscale-panel__receipt--danger');
  await expect(failed).toBeVisible();
  await expect(panel.locator('.tailscale-panel__receipt--ok')).toHaveCount(0);
});

test('phone: the Serve over tailscale button clears the 44px touch-target floor', async ({ page }, testInfo) => {
  only(testInfo, PHONE);
  await installMockDaemon(page, {
    tailscale: { available: true, loggedIn: true, magicDnsName: 'my-host.tailnet.ts.net', httpsUrl: 'https://my-host.tailnet.ts.net', detail: 'connected' },
  });
  await openSettings(page, 'network');
  const panel = page.locator('[data-testid="tailscale-settings"]');
  await expect(panel).toBeVisible();
  await expectTappable(page, '[data-testid="tailscale-settings"] >> text=Serve over tailscale', 'Serve over tailscale button');
});
