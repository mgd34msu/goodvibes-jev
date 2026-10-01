/**
 * Pairing tokens settings/security surface (pairing.tokens.*, SDK 1.8.0):
 * list/rename/revoke per device, the migrate-this-browser affordance, and the
 * revoke-shared-token action, each destructive step gated by the real
 * ConfirmSheet with a plain-language consequence, never a bare click-to-destroy.
 *
 * The cross-device revoke proof uses TWO Playwright contexts sharing one
 * MockPairingStore (support/mock-daemon.ts), standing in for the operator's
 * own browser and a second paired device, so revoking the device's token from
 * the operator's session is checked against a REAL 401 on the device's own
 * next authenticated request, not just a UI state change.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon, createMockPairingStore } from './support/mock-daemon';
import { only, PHONE, expectTappable, openSettings } from './support/app';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the object-destructuring form even with no fixtures used
test.beforeEach(({}, testInfo) => {
  only(testInfo, PHONE);
});

async function openPairingSettings(page: import('@playwright/test').Page): Promise<void> {
  await openSettings(page, 'devices');
  await expect(pairingPanel(page)).toBeVisible();
}

/**
 * The paired-devices panel itself. Device names are asserted inside it rather
 * than across the whole page: a device may be named after a thing the app also
 * names elsewhere, "Phone" is both a plausible device name and the navigation
 * entry for the phone node view, and a page-wide text match would then be
 * ambiguous, or worse, satisfied by the navigation while the list is empty.
 */
function pairingPanel(page: import('@playwright/test').Page) {
  return page.getByTestId('pairing-tokens');
}

test('lists one row per paired device, never a secret, and renames inline', async ({ page }) => {
  const pairingStore = createMockPairingStore([
    { id: 'tok-phone', name: 'Phone', token: 'e2e-phone-token', createdAt: 1_700_000_000_000, lastSeenAt: 1_700_100_000_000 },
    { id: 'tok-laptop', name: 'Laptop', token: 'e2e-laptop-token', createdAt: 1_700_000_500_000 },
  ]);
  await installMockDaemon(page, { pairingStore });
  await openPairingSettings(page);

  await expect(pairingPanel(page).locator('.pairing-token-row')).toHaveCount(2);
  // Never a secret in this list.
  await expect(pairingPanel(page).getByText('e2e-phone-token')).toHaveCount(0);

  await page.getByRole('button', { name: 'Rename Phone' }).click();
  const input = page.locator('#pairing-token-rename-tok-phone');
  await input.fill('My Phone');
  await input.press('Enter');
  await expect.poll(() => pairingStore.tokens.find((t) => t.id === 'tok-phone')?.name).toBe('My Phone');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rename My Phone' })).toBeVisible();
});

test('touch targets on the pairing tokens panel clear 44px at phone width', async ({ page }) => {
  const pairingStore = createMockPairingStore([
    { id: 'tok-phone', name: 'Phone', token: 'e2e-phone-token', createdAt: 1_700_000_000_000 },
  ]);
  await installMockDaemon(page, { pairingStore });
  await openPairingSettings(page);
  await expectTappable(page, '.pairing-token-row__revoke', 'revoke device');
  await expectTappable(page, '.pairing-tokens-legacy__actions button', 'give this browser its own token');
});

test('revoking one device 401s it while the current session (a different token) keeps working', async ({ page, browser }) => {
  const pairingStore = createMockPairingStore([
    { id: 'tok-phone', name: 'Phone', token: 'e2e-phone-token', createdAt: 1_700_000_000_000 },
  ]);
  // The operator's own browser: the default seeded session token, unrelated to
  // (and never affected by) anything that happens to the phone's token below.
  await installMockDaemon(page, { pairingStore });

  // A second, independent context/page stands in for the paired phone,
  // authenticated with the pairing token this test is about to revoke.
  const phoneContext = await browser.newContext();
  const phonePage = await phoneContext.newPage();
  await installMockDaemon(phonePage, { pairingStore, signedIn: false });
  await phonePage.addInitScript((token) => {
    window.localStorage.setItem('goodvibes.webui.token', token);
  }, 'e2e-phone-token');
  await phonePage.goto('/?view=chat');
  // Genuinely signed in, before the revoke.
  await expect(phonePage.locator('.app-shell')).toBeVisible();

  await openPairingSettings(page);
  const phoneRow = page.locator('.pairing-token-row', { hasText: 'Phone' });
  await phoneRow.getByRole('button', { name: /Revoke/ }).click();
  await expect(page.locator('.gv-confirm')).toBeVisible();
  expect(pairingStore.tokens).toHaveLength(1);
  await page.locator('.gv-confirm__confirm').click();
  await expect(pairingPanel(page).locator('.pairing-token-row')).toHaveCount(0);
  expect(pairingStore.revokedTokenValues.has('e2e-phone-token')).toBe(true);

  // The phone's own token is now revoked, its next authenticated call 401s.
  const status = await phonePage.evaluate(async () => {
    const res = await fetch('/api/control-plane/auth', { headers: { Authorization: 'Bearer e2e-phone-token' } });
    return res.status;
  });
  expect(status).toBe(401);

  // The operator's OWN session (a different token entirely) is unaffected: a
  // reload lands back in the signed-in shell with the settings dialog reopened
  // from its link, its data still loading.
  await page.reload();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(pairingPanel(page)).toBeVisible();

  await phoneContext.close();
});

test('migrate mints this browser its own token; revoke-shared runs only after its confirm', async ({ page }) => {
  const pairingStore = createMockPairingStore();
  const daemon = await installMockDaemon(page, { pairingStore });
  await openPairingSettings(page);
  const storedToken = () => page.evaluate(() => window.localStorage.getItem('goodvibes.webui.token'));
  const sharedToken = await storedToken();

  await page.getByRole('button', { name: 'Give this browser its own token' }).click();
  await expect(page.locator('.gv-confirm')).toBeVisible();
  expect(daemon.invocations('pairing.tokens.migrate')).toHaveLength(0);
  await page.locator('.gv-confirm__confirm').click();
  await expect.poll(() => daemon.invocations('pairing.tokens.migrate').length).toBe(1);
  // This browser now holds the newly minted token, not the shared one.
  await expect.poll(storedToken).not.toBe(sharedToken);
  expect(pairingStore.tokens.map((t) => t.token)).toContain(await storedToken());

  await page.getByRole('button', { name: 'Revoke the shared token' }).click();
  await expect(page.locator('.gv-confirm')).toBeVisible();
  expect(pairingStore.legacySharedRevoked).toBe(false);
  await page.locator('.gv-confirm__confirm').click();
  await expect.poll(() => pairingStore.legacySharedRevoked).toBe(true);
  await expect(page.getByRole('button', { name: 'Revoke the shared token' })).toHaveCount(0);
});
