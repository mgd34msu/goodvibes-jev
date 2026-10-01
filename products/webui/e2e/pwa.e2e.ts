/**
 * PWA packaging, installability signals, the service worker, honest offline,
 * and the Web Push subscribe/unsubscribe client.
 *
 * Hermetic by construction: the manifest + SW are static assets; the push flow
 * uses a MOCKED PushManager (Playwright cannot reach a real push service), and
 * every push.* call is answered by the in-page mock daemon. No real push is
 * ever sent, the STATES are asserted, not deliveries.
 *
 * KNOWN RESIDUAL: while the REAL service worker controls the page, Playwright's
 * page routing cannot intercept its requests, those flow through the vite
 * proxy to the e2e daemon stub (scripts/e2e-daemon-stub.ts) and get a
 * deliberate 503 { code: 'E2E_STUB' }. Assertions in this spec therefore never
 * depend on daemon data while the real worker is in control; they prove the
 * install/offline/push honesty states.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { expectNoHorizontalScroll, openSettings } from './support/app';
import { mockPushApis } from './support/push-mocks';

// ── Manifest + installability ─────────────────────────────────────────────

test('the browser judges the app installable', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
  // Chromium's own installability verdict (manifest, icons, service worker), not a
  // reading of the manifest's fields.
  const cdp = await page.context().newCDPSession(page);
  await expect.poll(async () => {
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    return installabilityErrors.map((e) => e.errorId);
  }).toEqual([]);
});

// ── Service worker registers (offline behavior: pwa-offline.e2e.ts) ─────────

test('the service worker registers in the browser', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/');
  const registered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg && reg.active);
  });
  expect(registered).toBe(true);
});

// ── Web Push: mocked PushManager, states asserted (no real pushes) ──────────
// mockPushApis lives in ./support/push-mocks (shared with pairing-handoff.e2e.ts).

async function openNotificationSettings(page: Page): Promise<void> {
  await openSettings(page, 'notifications');
  await expect(page.locator('.notifications-panel')).toBeVisible();
}

test('subscribe → the client fetches the VAPID key and registers the subscription with the daemon', async ({ page }) => {
  await mockPushApis(page, 'granted');
  await installMockDaemon(page);

  const invokeCalls: string[] = [];
  page.on('request', (req) => {
    const m = req.url().match(/\/api\/control-plane\/methods\/(push\.[^/]+)\/invoke$/);
    if (m) invokeCalls.push(m[1]);
  });

  await openNotificationSettings(page);
  await page.getByRole('button', { name: /Turn on notifications/ }).click();

  // The UI flips to the subscribed state (turn-off + test-push controls appear).
  await expect(page.getByRole('button', { name: /Turn off notifications/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Send a test push/ })).toBeVisible();

  // The honest wire sequence: read the VAPID key, then register the subscription.
  expect(invokeCalls).toContain('push.vapid.get');
  expect(invokeCalls).toContain('push.subscriptions.create');

  // Unsubscribe removes the daemon-side record and returns to the off state.
  await page.getByRole('button', { name: /Turn off notifications/ }).click();
  await expect(page.getByRole('button', { name: /Turn on notifications/ })).toBeVisible();
  expect(invokeCalls).toContain('push.subscriptions.delete');
});

test('reconcile-on-open heals a drifted push record when the app opens already-subscribed', async ({ page }) => {
  // Seed the device identity BEFORE any app script runs, so ensureDeviceId()
  // reads this fixed id instead of minting a fresh uuid, the mock daemon's
  // pushSeed record below is keyed on the SAME id.
  const deviceId = 'device-e2e-reconcile';
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, 'device-e2e-reconcile');
  }, 'goodvibes.webui.push.deviceId');
  await mockPushApis(page, 'granted', { preSubscribed: true, endpoint: 'https://push.example.test/rotated-endpoint' });
  await installMockDaemon(page, {
    pushSeed: [
      {
        id: 'push_e2e_seed',
        deviceId,
        endpointOrigin: 'https://push.example.test',
        // A placeholder hash that can never equal the real sha256 the client
        // computes over its live endpoint, the daemon's record is stale.
        endpointHash: 'stale-hash-from-a-prior-session',
        createdAt: 1_700_000_000_000,
      },
    ],
  });

  const invokeCalls: string[] = [];
  page.on('request', (req) => {
    const m = req.url().match(/\/api\/control-plane\/methods\/(push\.[^/]+)\/invoke$/);
    if (m) invokeCalls.push(m[1]);
  });

  // App open, already signed in and already subscribed at the browser level,
  // reconcile-on-open should fire without the operator touching any control.
  await page.goto('/?view=chat');
  await expect.poll(() => invokeCalls).toContain('push.subscriptions.list');
  await expect.poll(() => invokeCalls).toContain('push.subscriptions.reconcile');
});

test('blocked notifications disable the turn-on control', async ({ page }) => {
  await mockPushApis(page, 'denied');
  await installMockDaemon(page);
  await openNotificationSettings(page);
  await expect(page.getByRole('button', { name: /Turn on notifications/ })).toBeDisabled();
});

test('an insecure (plain-HTTP) context offers no turn-on control', async ({ page }) => {
  // Force the insecure-context branch even though 127.0.0.1 is really secure.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  });
  await installMockDaemon(page);
  await openNotificationSettings(page);
  await expect(page.getByRole('button', { name: /Turn on notifications/ })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
