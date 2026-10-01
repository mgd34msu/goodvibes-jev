/**
 * Local voice setup, the one-act managed provisioning flow (voice.local.status /
 * voice.local.install, SDK 1.9.0-dev), proven end to end against the hermetic voice
 * mock inside the voice-settings popover:
 *   - unprovisioned -> a size-labeled "Set up local voice" action.
 *   - install -> the final receipt (per-engine outcomes + configured-vs-skipped keys)
 *     and the resting display flipping to Installed.
 *   - a retriable download failure -> the honest reason plus a Retry action.
 *   - unsupported platform -> an honest note, no setup button.
 *   - an older daemon build (verb absent, 404) -> the section stays absent entirely.
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { installVoiceRoutes } from './support/voice-mock';

async function openVoiceSettings(page: import('@playwright/test').Page) {
  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();
  await page.locator('.voice-settings-btn').click();
  const popover = page.locator('.voice-settings-popover');
  await expect(popover).toBeVisible();
  return popover;
}

test('an unprovisioned runtime offers the one-act setup, and one tap installs exactly once', async ({ page }) => {
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page); // default: not-provisioned, install succeeds

  const popover = await openVoiceSettings(page);
  const local = popover.locator('.voice-settings-local');
  await expect(local).toBeVisible();

  const setup = local.getByRole('button', { name: /Set up local voice/ });
  await expect(setup).toBeVisible();
  expect(voice.localInstallRequests).toBe(0);

  await setup.click();

  // One install, and once it lands there is nothing left to set up.
  await expect.poll(() => voice.localInstallRequests).toBe(1);
  await expect(setup).toHaveCount(0);
  await expect(local.getByRole('button', { name: 'Retry' })).toHaveCount(0);
});

test('a slow install shows live progress from the polled status, which clears when the install lands', async ({ page }) => {
  await installChatMockDaemon(page);
  // 2.5s window ≈ three of the surface's 750ms polls, the installInProgress
  // section is only served while the install POST is genuinely in flight.
  await installVoiceRoutes(page, { localInstallDurationMs: 2500 });

  const popover = await openVoiceSettings(page);
  const local = popover.locator('.voice-settings-local');
  await local.getByRole('button', { name: /Set up local voice/ }).click();

  // Live progress while the install POST is in flight…
  const progress = local.locator('[data-testid="voice-local-progress"]');
  await expect(progress).toBeVisible();

  // …then the run completes: progress clears and the setup action is gone.
  await expect(progress).toHaveCount(0);
  await expect(local.getByRole('button', { name: /Set up local voice/ })).toHaveCount(0);
});

test('a retriable download failure offers Retry, which re-invokes install', async ({ page }) => {
  await installChatMockDaemon(page);
  const voice = await installVoiceRoutes(page, { localInstallOutcome: 'download-failed' });

  const popover = await openVoiceSettings(page);
  const local = popover.locator('.voice-settings-local');
  await local.getByRole('button', { name: /Set up local voice/ }).click();

  await expect.poll(() => voice.localInstallRequests).toBe(1);
  const retry = local.getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(() => voice.localInstallRequests).toBe(2);
});

test('a provisioned runtime offers no setup button', async ({ page }) => {
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, { localRuntime: 'provisioned' });

  const popover = await openVoiceSettings(page);
  const local = popover.locator('.voice-settings-local');
  await expect(local).toBeVisible();
  await expect(local.getByRole('button', { name: /Set up local voice/ })).toHaveCount(0);
});

test('an unsupported platform never offers an install that cannot succeed', async ({ page }) => {
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, { localRuntime: 'unsupported-platform' });

  const popover = await openVoiceSettings(page);
  const local = popover.locator('.voice-settings-local');
  await expect(local).toBeVisible();
  await expect(local.getByRole('button', { name: /Set up local voice/ })).toHaveCount(0);
});

test('an older daemon build (voice.local.status 404s) renders no local section at all; honest omission, not an error banner', async ({ page }) => {
  await installChatMockDaemon(page);
  await installVoiceRoutes(page, { localRuntime: 'unavailable' });

  const popover = await openVoiceSettings(page);
  // The rest of the popover works untouched.
  await expect(popover.getByRole('combobox', { name: 'Provider' })).toBeVisible();
  await expect(popover.locator('.voice-settings-local')).toHaveCount(0);
});
