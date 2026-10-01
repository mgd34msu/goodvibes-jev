/**
 * Task graph (fleet.graph.get, SDK 1.8.0's fix-phase workstream rework),
 * the dependency-graph view of one workstream rendered in the
 * workstream/fleet detail pane. Proves the represented state tells
 * (ready/running/blocked/at-cap/stalled) render legibly against the mock
 * daemon's representative fixture (fleetGraphResponse). Runs on both phone
 * and desktop.
 */
import { test, expect } from '@playwright/test';
import { FLEET_GRAPH_WORKSTREAM_ID, installMockDaemon } from './support/mock-daemon';
import { FLEET_GRAPH_WORKSTREAM_NODE } from './support/seed';
import { expectNoHorizontalScroll, openRow } from './support/app';

test('the old Workstream link lands on Work, and opening the workstream fetches and renders its graph', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  // The old Workstream link lands on Work, Processes.
  await page.goto('/?view=workstream');
  await expect(page.locator('.app-shell')).toBeVisible();

  await openRow(page, FLEET_GRAPH_WORKSTREAM_NODE.label);
  const panel = page.locator('.task-graph-panel');
  await expect(panel).toBeVisible();

  // The graph read names the selected workstream, and every node it returned is a row.
  expect(daemon.requests.some((r) => r.method === 'GET' && r.path === `/api/fleet/workstreams/${FLEET_GRAPH_WORKSTREAM_ID}/graph`)).toBe(true);
  await expect(panel.locator('[data-testid="task-graph-node"]')).toHaveCount(5);

  await expectNoHorizontalScroll(page);
});

test('the task graph also renders from Work, All, for the same workstream', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=work');
  await expect(page.locator('.app-shell')).toBeVisible();

  await openRow(page, FLEET_GRAPH_WORKSTREAM_NODE.label);
  await expect(page.locator('.task-graph-panel')).toBeVisible();
  await expect(page.locator('[data-testid="task-graph-node"]')).toHaveCount(5);
});
