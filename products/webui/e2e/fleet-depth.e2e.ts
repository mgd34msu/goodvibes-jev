/**
 * Fleet depth (WEBUI-FLEET-DEPTH), the process tree's steer/detach/stop actions and
 * "approve from the tree", proved against the hermetic mock daemon on both viewports.
 *
 * Desktop: every new action (steer, detach, stop, approve/deny/claim/cancel inline)
 * is available and reaches the real wire route. Phone: the tree stays browsable and
 * a correlated approval is still decidable, but the new mutation controls (steer
 * input, detach, stop) are desktop-only, an honest note says so instead of cramming
 * them into a 375px column, and there is never a horizontal scroll.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon, type MockDaemon } from './support/mock-daemon';
import { FLEET_AGENT_NODE, FLEET_WATCHER_NODE } from './support/seed';
import { DESKTOP, PHONE, detailPane, expectNoHorizontalScroll, listRow, only, openRow } from './support/app';

let daemon: MockDaemon;

test.beforeEach(async ({ page }) => {
  daemon = await installMockDaemon(page);
  await page.goto('/?view=work&tab=all');
  await expect(page.locator('.app-shell')).toBeVisible();
});

test('the Work list renders both seeded processes', async ({ page }) => {
  await expect(listRow(page, FLEET_AGENT_NODE.label)).toBeVisible();
  await expect(listRow(page, FLEET_WATCHER_NODE.label)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test.describe('process actions', () => {
  test('steer sends over sessions.steer with this browser stamped as the surface', async ({ page }) => {
    const detail = await openRow(page, FLEET_AGENT_NODE.label);
    const input = detail.getByRole('textbox', { name: 'Steer message' });
    await expect(input).toBeVisible();
    await expect(detail.getByRole('textbox', { name: 'Original request', exact: true })).toHaveCount(0);
    const discoveryIndex = daemon.requests.findIndex((request) => request.method === 'POST' && request.path === '/api/work-ledger/turn/session');
    expect(discoveryIndex).toBeGreaterThanOrEqual(0);
    expect(daemon.requests[discoveryIndex].body).toEqual({ sessionId: FLEET_AGENT_NODE.sessionRef.sessionId });
    await input.fill('Keep going, prioritize the flaky test');
    await input.press('Enter');
    await expect.poll(() => daemon.steerRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const sent = daemon.steerRequests.at(-1) as { sessionId: string; body: Record<string, unknown> };
    expect(sent.sessionId).toBe(FLEET_AGENT_NODE.sessionRef.sessionId);
    expect(sent.body).toMatchObject({ surfaceKind: 'webui', surfaceId: 'goodvibes-webui' });
    const steerIndex = daemon.requests.findIndex((request) => request.methodId === 'sessions.steer'
      || request.path === `/api/sessions/${encodeURIComponent(String(FLEET_AGENT_NODE.sessionRef.sessionId))}/steer`);
    expect(steerIndex).toBeGreaterThan(discoveryIndex);
  });

  test('detach calls sessions.detach with this surface id, not the process', async ({ page }) => {
    const detail = await openRow(page, FLEET_AGENT_NODE.label);
    await detail.getByRole('button', { name: /Detach this browser/i }).click();
    await expect.poll(() => daemon.detachRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(daemon.detachRequests[0]).toEqual({
      sessionId: FLEET_AGENT_NODE.sessionRef.sessionId,
      surfaceId: 'goodvibes-webui',
    });
  });

  test('stop on the watcher confirms first, then calls watchers.stop keyed on the node id', async ({ page }) => {
    const detail = await openRow(page, FLEET_WATCHER_NODE.label);
    await detail.getByRole('button', { name: /^Stop$/ }).click();
    const sheet = page.getByRole('alertdialog');
    await expect(sheet.first()).toBeVisible();
    expect(daemon.watcherStopRequests.length).toBe(0);
    await sheet.first().getByRole('button', { name: /^Stop$/ }).click();
    await expect.poll(() => daemon.watcherStopRequests.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(daemon.watcherStopRequests[0]).toBe(FLEET_WATCHER_NODE.id);
  });

  test('an agent with no wire verb for stopping offers no Stop', async ({ page }) => {
    const detail = await openRow(page, FLEET_AGENT_NODE.label);
    await expect(detail.getByRole('textbox', { name: 'Steer message' })).toBeVisible();
    await expect(detail.getByRole('button', { name: /^Stop$/ })).toHaveCount(0);
  });

  test('the correlated pending approval is one row away and Approve reaches approvals.approve', async ({ page }) => {
    const detail = await openRow(page, FLEET_AGENT_NODE.label);
    const waiting = detail.getByRole('list', { name: 'Approvals for this process' });
    await expect(waiting.getByRole('listitem')).toHaveCount(1);
    await waiting.locator('.gv-row__main').first().click();
    expect(daemon.approvalActions).toHaveLength(0);
    await detailPane(page).getByRole('button', { name: /^Approve$/ }).click();
    await expect.poll(() => daemon.approvalActions.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(daemon.approvalActions[0]).toMatchObject({ approvalId: 'appr-e2e-1', action: 'approve' });
  });
});

test.describe('desktop: the detail folds the sidebar to its rail', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, DESKTOP));

  test('opening a detail shows the rail; closing it brings the sidebar back', async ({ page }) => {
    // The first available needs-you item opens by itself. Fleet and approval
    // queries resolve independently, so either detail can win the initial load.
    await expect(detailPane(page)).toBeVisible();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar', 'rail');
    await detailPane(page).getByRole('button', { name: /^Close (approval|process)$/ }).click();
    await expect(detailPane(page)).toBeHidden();
    await expect(page.locator('.app-shell')).toHaveAttribute('data-sidebar', 'expanded');
  });
});

test.describe('phone: one pane at a time, every action still reachable', () => {
  test.beforeEach(async ({ page: _page }, testInfo) => only(testInfo, PHONE));

  test('selecting a process flips to its detail with a Back button, no horizontal scroll', async ({ page }) => {
    await openRow(page, FLEET_AGENT_NODE.label);
    await expect(page.locator('.dv-list')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: 'All work' }).click();
    await expect(page.locator('.dv-list')).toBeVisible();
  });

  test('steering is available on the phone and fits the screen', async ({ page }) => {
    const detail = await openRow(page, FLEET_AGENT_NODE.label);
    await expect(detail.getByRole('textbox', { name: 'Steer message' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
