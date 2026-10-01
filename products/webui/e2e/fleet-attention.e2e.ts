/**
 * Work: fleet attention + live subscription, proves the consumer-side attention work
 * against the hermetic mock daemon:
 *
 *   - a node the daemon flagged as needsAttention shows a distinct badge, floats to
 *     the top of its sibling group, and drives a count badge on the Fleet nav entry;
 *   - 'pick' and 'conflict' (SDK 1.8.0) are the SAME waiting-on-human class as
 *     approval/input, each shows its own reason-specific badge text and is counted
 *     by the exact same nav badge, with no separate code path;
 *   - a needs-input push deep link (?view=fleet#fleet-node=…&fleet-session=…) opens
 *     the Fleet view focused on that node;
 *   - a fleet event delivered over the multiplexed control-plane subscription adds
 *     the announced node to the tree (the subscription drives a live update, not a
 *     poll);
 *   - when the subscription is dropped, the tree still renders from the poll fallback.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import {
  FLEET_AGENT_NODE,
  FLEET_BLOCKED_NODE,
  FLEET_CONFLICT_NODE,
  FLEET_EVENT_NODE,
  FLEET_PICK_NODE,
  FLEET_WATCHER_NODE,
} from './support/seed';
import { detailPane, listRow, openNavigation } from './support/app';

test('the Work nav entry shows a needs-you count for every blocked node, any reason', async ({ page }) => {
  await installMockDaemon(page);
  // Start on another view, the badge is derived app-wide, not only on the Fleet view.
  await page.goto('/?view=work&tab=sessions');
  await expect(page.locator('.app-shell')).toBeVisible();
  // Three seeded nodes need attention (FLEET_BLOCKED_NODE 'input', FLEET_PICK_NODE
  // 'pick', FLEET_CONFLICT_NODE 'conflict') → count of 3, named in the Work entry's
  // accessible label and shown as a count chip beside it. The count is reason-
  // agnostic, it never special-cases which of the four reasons a node carries.
  // On a phone the count also rides the header's menu button, so it is visible
  // before the drawer opens.
  const menu = page.getByRole('button', { name: /^Open navigation/ });
  if (await menu.isVisible()) await expect(menu).toHaveAccessibleName(/\b3\b/);
  await openNavigation(page);
  await expect(page.getByRole('button', { name: /^Work\b.*\b3\b/ })).toBeVisible();
  await expect(page.locator('.shell-nav-item__count').first()).toHaveText('3');
});

test('the blocked node is listed under Needs you with its reason, separate from running work', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=fleet');
  await expect(page.locator('.app-shell')).toBeVisible();
  // The old ?view=fleet link lands on Work, All.
  await expect(page).toHaveURL(/view=work&tab=all/);

  const needs = page.getByRole('region', { name: 'Needs you' });
  const blocked = needs.locator('.gv-row', { hasText: FLEET_BLOCKED_NODE.label });
  await expect(blocked).toBeVisible();
  await expect(blocked.locator('[data-attention-reason="input"]')).toBeVisible();
  // The other seeded nodes still render, under Running; nothing is dropped.
  const running = page.getByRole('region', { name: 'Running' });
  await expect(running.locator('.gv-row', { hasText: FLEET_AGENT_NODE.label }).first()).toBeVisible();
  await expect(running.locator('.gv-row', { hasText: FLEET_WATCHER_NODE.label })).toBeVisible();
});

test('a pick-blocked workstream and a conflict-blocked item each show their own reason', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=work');
  await expect(page.locator('.app-shell')).toBeVisible();

  const pickRow = listRow(page, FLEET_PICK_NODE.label);
  await expect(pickRow.locator('[data-attention-reason="pick"]')).toBeVisible();

  const conflictRow = listRow(page, FLEET_CONFLICT_NODE.label);
  await expect(conflictRow.locator('[data-attention-reason="conflict"]')).toBeVisible();
});

test('a needs-input deep link opens Work focused on the blocked node', async ({ page }) => {
  await installMockDaemon(page);
  // The shape a push notification tap produces (notification-link.ts).
  await page.goto('/?view=fleet#fleet-node=agent-blocked-7&fleet-session=session-blocked');
  await expect(page.locator('.app-shell')).toBeVisible();
  // The node's detail is open (not the first approval, not the list).
  await expect(detailPane(page)).toBeVisible();
  // On desktop the list stays beside the detail: the blocked node is the selected row.
  if (test.info().project.name === 'desktop') {
    await expect(page.locator('.dv-list .gv-row__main[aria-current="true"]')).toHaveCount(1);
    await expect(listRow(page, FLEET_BLOCKED_NODE.label).locator('.gv-row__main')).toHaveAttribute('aria-current', 'true');
  }
  // The consumed fragment is scrubbed so a reload does not re-focus it.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
});

test('a fleet event over the subscription adds the announced node to the list', async ({ page }) => {
  await installMockDaemon(page, {
    fleetEvents: [
      { type: 'FLEET_NODE_STARTED', nodeId: FLEET_EVENT_NODE.id, kind: 'agent', label: FLEET_EVENT_NODE.label, state: 'thinking' },
    ],
  });
  await page.goto('/?view=work');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(listRow(page, FLEET_AGENT_NODE.label)).toBeVisible();
  // Not in the baseline snapshot: it appears because the fleet frame invalidated the snapshot.
  await expect(listRow(page, FLEET_EVENT_NODE.label)).toBeVisible();
});

test('the list still renders from the poll fallback when the subscription is dropped', async ({ page }) => {
  await installMockDaemon(page, { dropStreams: true });
  await page.goto('/?view=work');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(listRow(page, FLEET_AGENT_NODE.label)).toBeVisible();
  await expect(listRow(page, FLEET_BLOCKED_NODE.label)).toBeVisible();
});
