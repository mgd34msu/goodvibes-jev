/**
 * Knowledge depth on the Library: consolidation candidates (knowledge.candidates.list/
 * .candidate.decide, rows on the Review tab with their decisions in the detail pane) and the
 * prompt packet builder (knowledge.packet, the Packet section of the Knowledge tab). Proven
 * against a real HTTP round-trip through the mock daemon's separate knowledge.candidates/
 * .packet registrations (mock-daemon.ts), not just a unit-mocked module.
 */
import { test, expect } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { expectNoHorizontalScroll } from './support/app';

test('accepting a candidate sends the decision and moves it out of the undecided list', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto('/?view=library&tab=review');
  const row = page.locator('.knowledge-candidate-row', { hasText: 'Promote the session-spine keepalive decision' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Promote the session-spine keepalive decision/ }).click();

  const pane = page.getByRole('region', { name: 'Review item' });
  expect(daemon.requests.filter((r) => r.path.endsWith('/decide'))).toHaveLength(0);
  await pane.getByRole('button', { name: 'Accept' }).click();
  await expect.poll(() => daemon.requests
    .filter((r) => r.method === 'POST' && r.path === '/api/knowledge/candidates/cand-1/decide')
    .map((r) => (r.body as { decision?: string }).decision)).toEqual(['accept']);
  // The list refetches and the pane loses its decisions (an already-decided candidate offers none).
  await expect(pane.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Knowledge candidates' }).locator('.knowledge-candidate-row', { hasText: 'Promote the session-spine keepalive decision' })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('an already-decided candidate (accepted) offers no decisions', async ({ page }) => {
  await installMockDaemon(page);
  await page.goto('/?view=library&tab=review');
  // Decided candidates sit behind a quiet disclosure.
  await page.getByText(/\d+ decided/).click();
  const decided = page.locator('.knowledge-candidate-row', { hasText: 'Refresh the daemon architecture source' });
  await expect(decided).toBeVisible();
  await decided.getByRole('button', { name: /Refresh the daemon architecture source/ }).click();
  const pane = page.getByRole('region', { name: 'Review item' });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Accept' })).toHaveCount(0);
});

test('building a prompt packet sends the task and renders the returned items, untruncated', async ({ page }) => {
  const daemon = await installMockDaemon(page);
  await page.goto('/?view=library&tab=knowledge');
  await page.getByRole('radio', { name: 'Packet' }).click();
  await page.getByLabel('Task description').fill('Refactor the session spine');
  await page.getByRole('button', { name: 'Build packet' }).click();
  const packetPanel = page.locator('.knowledge-packet__result');
  await expect(packetPanel).toBeVisible();
  expect(daemon.requests.filter((r) => r.method === 'POST' && r.path === '/api/knowledge/packet').map((r) => (r.body as { task?: string }).task))
    .toEqual(['Refactor the session spine']);
  await expect(packetPanel.getByRole('list', { name: 'Packet items' }).getByRole('listitem')).toHaveCount(1);
  await expect(packetPanel.getByRole('note')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test('a real post-1.2.0 truncated packet (the final SDK\'s full field shape) renders the truncation disclosure', async ({ page }) => {
  // packet: 'truncated' answers truncated/totalCandidates/droppedCount/droppedForBudget/
  // budgetExhausted all populated (packet.ts's real shape), not just the hand-authored
  // truncated/totalCandidates/droppedCount subset, proving the disclosure renders from
  // a genuine final-SDK wire response.
  await installMockDaemon(page, { packet: 'truncated' });
  await page.goto('/?view=library&tab=knowledge');
  await page.getByRole('radio', { name: 'Packet' }).click();
  await page.getByLabel('Task description').fill('Refactor the session spine');
  await page.getByRole('button', { name: 'Build packet' }).click();
  const packetPanel = page.locator('.knowledge-packet__result');
  await expect(packetPanel).toBeVisible();
  await expect(packetPanel.getByRole('note')).toBeVisible();
  await expectNoHorizontalScroll(page);
});
