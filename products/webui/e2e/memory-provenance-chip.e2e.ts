/**
 * The memory-provenance chip proof, end to end: the SDK's TURN_COMPLETED wire field
 * (`metadata.memory.recordIds`, packages/sdk/src/events/turn.ts's TurnCompletedMetadata,
 * stamped by the orchestrator turn loop, SDK commit 89690d07) is read by
 * lib/memory-provenance.ts's honest-absence convention and rendered by
 * MemoryProvenanceChip.tsx, gated on the owner-ruled default-OFF
 * memoryProvenanceChipEnabled preference (lib/ui-preferences.ts).
 *
 * The mock daemon (e2e/support/chat-mock.ts) has stamped `assistantReplyMemoryRecordIds`
 * onto assistant replies since the interaction-wins round, but no spec ever exercised it,
 * this closes that gap with the real message-fetch -> chip-render path, not just the
 * chip's own unit/component tests (which only ever pass `recordIds` as a prop directly).
 */
import { test, expect } from '@playwright/test';
import { installChatMockDaemon } from './support/chat-mock';
import { WEBUI_PREFERENCES_KEY } from '../src/lib/ui-preferences';

const MESSAGE = 'What did we decide about the release train?';

test('a turn carrying metadata.memory.recordIds lights up the chip when the setting is on', async ({ page }) => {
  await page.addInitScript(([key]) => {
    window.localStorage.setItem(key, JSON.stringify({ memoryProvenanceChipEnabled: true }));
  }, [WEBUI_PREFERENCES_KEY] as const);
  await installChatMockDaemon(page, { assistantReplyMemoryRecordIds: ['mem-rel-1', 'mem-rel-2'] });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toBeVisible();
  await composer.fill(MESSAGE);
  await page.locator('.send-button').click();

  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });

  const chip = page.locator('.memory-provenance-chip__toggle');
  await expect(chip).toHaveAttribute('aria-expanded', 'false');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-expanded', 'true');
  // One entry per record id the turn carried.
  await expect(page.locator('.memory-provenance-chip__list > li')).toHaveCount(2);
});

test('the same metadata.memory.recordIds stays absent with the setting off (default)', async ({ page }) => {
  // No preference written, DEFAULT_WEBUI_PREFERENCES.memoryProvenanceChipEnabled is false.
  await installChatMockDaemon(page, { assistantReplyMemoryRecordIds: ['mem-rel-1', 'mem-rel-2'] });

  await page.goto('/?view=chat');
  await expect(page.locator('.app-shell')).toBeVisible();

  const composer = page.locator('textarea[aria-label="Message GoodVibes"]');
  await expect(composer).toBeVisible();
  await composer.fill(MESSAGE);
  await page.locator('.send-button').click();

  await expect(page.locator('.message.assistant')).toHaveCount(1, { timeout: 15_000 });

  // The reply's metadata carries the same real recordIds, the setting is the only
  // reason the chip is absent, never a lack of data.
  await expect(page.locator('.memory-provenance-chip__toggle')).toHaveCount(0);
});
