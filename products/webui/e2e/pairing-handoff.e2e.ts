/**
 * Pairing hand-off bundle (pairing.handoff.*, SDK 1.8.0): a `#pair=<token>
 * &offers=…` link signs the device in (usePairingHandoff, already covered
 * elsewhere) AND surfaces its offer set for a one-pass accept/decline
 * (PairingHandoffOffers → pairing.handoff.complete). Both paths, at phone width:
 *   - accept: notifications + relay are gathered/acknowledged and complete
 *     honestly as Completed.
 *   - decline: every offer is unchecked before continuing, nothing is sent to
 *     the daemon, and each renders as Declined, never silently half-applied.
 *
 * Passkey is left out of both e2e paths (its ceremony needs a real WebAuthn
 * authenticator, not a Playwright-mockable browser API the way Push is); the
 * client-side ceremony-failure honesty for passkey is covered by
 * PairingHandoffOffers.test.tsx instead.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { mockPushApis } from './support/push-mocks';
import { only, PHONE } from './support/app';

// eslint-disable-next-line no-empty-pattern -- Playwright requires the object-destructuring form even with no fixtures used
test.beforeEach(({}, testInfo) => {
  only(testInfo, PHONE);
});

test('accepting notifications + relay completes both honestly', async ({ page }) => {
  await mockPushApis(page, 'granted');
  await installMockDaemon(page, { signedIn: false });

  await page.goto('/?view=chat#pair=e2e-handoff-token&offers=notifications,relay');

  // The offer-decision modal appears once the token has signed this device in.
  await expect(page.locator('.pairing-handoff')).toBeVisible();
  // One checkbox per offer, both default to accepted.
  const checkboxes = page.locator('.pairing-handoff-offer input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(2);
  for (let i = 0; i < 2; i += 1) await expect(checkboxes.nth(i)).toBeChecked();

  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.locator('.pairing-handoff-result--completed')).toHaveCount(2);

  // The fragment never lingers.
  await expect.poll(() => new URL(page.url()).hash).not.toContain('pair=');

  await page.getByRole('button', { name: 'Continue to the app' }).click();
  await expect(page.locator('.pairing-handoff')).toHaveCount(0);
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('declining every offer never contacts the ceremony or sends anything to the daemon', async ({ page }) => {
  await installMockDaemon(page, { signedIn: false });

  const completeCalls: unknown[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/control-plane/methods/pairing.handoff.complete/invoke')) {
      completeCalls.push(req.postDataJSON());
    }
  });

  await page.goto('/?view=chat#pair=e2e-handoff-token-2&offers=notifications,relay');
  await expect(page.locator('.pairing-handoff')).toBeVisible();

  const checkboxes = page.locator('.pairing-handoff-offer input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(2);
  await checkboxes.nth(0).uncheck();
  await checkboxes.nth(1).uncheck();

  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.locator('.pairing-handoff-result--declined')).toHaveCount(2);
  await expect(page.locator('.pairing-handoff-result--completed')).toHaveCount(0);

  expect(completeCalls).toHaveLength(1);
  expect((completeCalls[0] as { body?: { accept?: unknown } }).body?.accept).toEqual({});

  await page.getByRole('button', { name: 'Continue to the app' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
});
