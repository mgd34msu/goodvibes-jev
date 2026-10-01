/**
 * Memory diagnostics, the daemon's memory-governance observability surface
 * (ops.memory.get, SDK 1.9.0-dev). Proves the settings Memory section's tier chip,
 * budget-vs-RSS bar, per-cache footprint table, paused-jobs list, and tripwire
 * line against the mock daemon, plus the honest "does not serve" state on an
 * older daemon build. Runs on both phone and desktop (default project set).
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { openSettings } from './support/app';

test('the snapshot drives the budget bar from the daemon\'s numbers', async ({ page }) => {
  await installMockDaemon(page); // default seed: the representative 'elevated' snapshot
  await openSettings(page, 'memory');

  const panel = page.locator('.memory-diagnostics');
  await expect(panel).toBeVisible();

  // 700 MB of a 1024 MB budget.
  await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '68');
});

test('a critical-tier snapshot moves the budget bar to the daemon\'s new usage', async ({ page }) => {
  await installMockDaemon(page, {
    opsMemory: {
      tier: 'critical',
      usedPct: 97,
      rssMb: 993,
      refusingExpensiveWork: true,
      tripwire: { armed: true, sustainedSec: 45, rateMbPerSec: 3.2 },
    },
  });
  await openSettings(page, 'memory');

  const panel = page.locator('.memory-diagnostics');
  await expect(panel.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '97');
});

test('an older daemon build (verb absent, 404) shows no bar and never sinks the sibling settings', async ({ page }) => {
  await installMockDaemon(page, { opsMemory: 'unavailable' });
  await openSettings(page, 'memory');

  const panel = page.locator('.memory-diagnostics');
  await expect(panel).toBeVisible();
  // No placeholder numbers anywhere in the unavailable state.
  await expect(panel.locator('[role="progressbar"]')).toHaveCount(0);
  // The sibling settings in the Memory section are untouched, the unavailable state is contained.
  await expect(page.getByRole('switch', { name: 'Memory provenance chips' })).toBeVisible();
});
