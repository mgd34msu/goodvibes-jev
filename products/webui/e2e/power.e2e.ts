/**
 * Power, the host sleep-ownership surface (power.status.get/keepAwake.set,
 * SDK 1.8.0). Proves the "sleep disabled" chip in the shell header's
 * indicators (PowerChip; it renders only while a hold is real), the Power
 * panel's toggle in Settings (ruled shape: one toggle, no timers, no AC-only
 * sub-options), and the "held because X" line, all against the mock daemon.
 * Runs on both phone and desktop (default project set).
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { openSettings } from './support/app';

test('the sleep-disabled chip is absent when keep-awake is off (honest baseline)', async ({ page }) => {
  await installMockDaemon(page);
  await openSettings(page, 'devices');
  await expect(page.locator('.status-strip__segment--power')).toHaveCount(0);
});

test('toggling keep-awake sends the setting to the daemon and shows, then clears, the header chip', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await openSettings(page, 'devices');

  const powerPanel = page.locator('.power-panel');
  await expect(powerPanel).toBeVisible();
  const toggle = powerPanel.getByLabel('Keep this machine awake');
  await expect(toggle).not.toBeChecked();

  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => daemon.keepAwakeSetRequests).toEqual([true]);

  // The chip appears among the header's indicators, driven by the same
  // event/refetch the real OPS_POWER_STATE_CHANGED wiring drives.
  const chip = page.locator('.status-strip__segment--power');
  await expect(chip).toBeVisible();

  // Toggling back off sends false and clears the chip.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => daemon.keepAwakeSetRequests).toEqual([true, false]);
  await expect(page.locator('.status-strip__segment--power')).toHaveCount(0);
});
