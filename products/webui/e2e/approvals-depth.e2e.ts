/**
 * Approvals depth, remember tiers, the pending queue, the exec-prompt
 * answerable card, deny with a reason, and the durable-rules view. Runs on
 * BOTH phone and desktop; the mock daemon forwards the decision fields into
 * resolution and returns the authoritative `recorded` block
 * (rememberTier / reasonStored / modifiedArgsDelivered) plus its
 * remembered-decision sweep, so every honesty path here exercises the same
 * recorded-block reporting a supporting daemon drives, the UI claims only
 * what the daemon actually recorded.
 */
import { test, expect, type Page } from '@playwright/test';
import { installMockDaemon } from './support/mock-daemon';
import { detailPane, expectNoHorizontalScroll, openRow } from './support/app';
import {
  EXEC_PROMPT_APPROVAL,
  PENDING_APPROVAL,
  PENDING_APPROVAL_SAME_CLASS,
  SEEDED_PERMISSION_RULE,
} from './support/seed';

function needsYou(page: Page) {
  return page.getByRole('region', { name: 'Needs you' });
}

test('multiple pending asks render under Needs you, newest first', async ({ page }) => {
  await installMockDaemon(page, { approvals: [PENDING_APPROVAL, PENDING_APPROVAL_SAME_CLASS] });
  // The old Approvals link lands on Work.
  await page.goto('/?view=approvals-tasks');
  const approvals = needsYou(page).locator('.gv-row', { hasText: /^Approve bash/ });
  await expect(approvals).toHaveCount(2);
  // Newest first: the later-created same-class ask leads.
  await expect(approvals.nth(0).filter({ hasText: 'Typecheck the workspace' })).toHaveCount(1);
  await expect(approvals.nth(1).filter({ hasText: 'Run the full test suite before merging' })).toHaveCount(1);
  await expectNoHorizontalScroll(page);
});

test('an approval granted at the command-class tier records a rule and suppresses the next identical ask', async ({ page }) => {
  const daemon = await installMockDaemon(page, { approvals: [PENDING_APPROVAL, PENDING_APPROVAL_SAME_CLASS] });
  await page.goto('/?view=work');
  const detail = await openRow(page, 'Run the full test suite before merging');
  // The ask's own rememberOptions render in a kit Select; pick the command class.
  await detail.getByRole('combobox', { name: 'Remember scope for bash' }).click();
  await page.getByRole('option', { name: /every bun command/ }).click();
  await detail.getByRole('button', { name: 'Approve', exact: true }).click();

  // The approve call carried the chosen tier.
  await expect.poll(() => daemon.approvalActions.length).toBe(1);
  expect(daemon.approvalActions[0]).toMatchObject({
    approvalId: PENDING_APPROVAL.id,
    action: 'approve',
    body: { remember: true, rememberTier: 'command-class' },
  });

  // The remembered decision swept the identical pending ask: nothing left to answer.
  await expect(needsYou(page).locator('.gv-row', { hasText: /^Approve bash/ })).toHaveCount(0);
  // …and the durable rule is listed in Settings, Permissions.
  await page.goto('/?view=work&settings=permissions');
  const rules = page.locator('[data-testid="permission-rules"]');
  await expect(rules.getByRole('button', { name: /^Delete rule/ })).toHaveCount(1);
  await expectNoHorizontalScroll(page);
});

test('deny accepts an optional reason that rides the wire with the denial', async ({ page }) => {
  const daemon = await installMockDaemon(page, { approvals: [PENDING_APPROVAL] });
  await page.goto('/?view=work');
  const detail = await openRow(page, 'Run the full test suite before merging');
  await detail.getByText('Add a reason for denying').click();
  await detail.getByLabel('Deny reason for bash').fill('wrong branch: run it on main');
  await detail.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect.poll(() => daemon.approvalActions.length).toBe(1);
  expect(daemon.approvalActions[0]).toMatchObject({
    approvalId: PENDING_APPROVAL.id,
    action: 'deny',
    body: { note: 'wrong branch: run it on main', reason: 'wrong branch: run it on main' },
  });
});

test('a command waiting on stdin is answerable and the typed reply feeds the run', async ({ page }) => {
  const daemon = await installMockDaemon(page, { approvals: [EXEC_PROMPT_APPROVAL] });
  await page.goto('/?view=work');
  const detail = await openRow(page, 'Continue connecting (yes/no)?');

  const send = detailPane(page).getByRole('button', { name: 'Send answer' });
  await expect(send).toBeDisabled();
  await detail.getByLabel('Answer for ssh deploy@staging.internal').fill('yes');
  await expect(send).toBeEnabled();
  await send.click();
  await expect.poll(() => daemon.approvalActions.length).toBe(1);
  expect(daemon.approvalActions[0]).toMatchObject({
    approvalId: EXEC_PROMPT_APPROVAL.id,
    action: 'approve',
    body: { modifiedArgs: { answer: 'yes' } },
  });
  await expectNoHorizontalScroll(page);
});

test('approval rules live in Settings, Permissions, and delete revokes one', async ({ page }) => {
  const daemon = await installMockDaemon(page, { permissionRules: [SEEDED_PERMISSION_RULE] });
  await page.goto('/?view=work&settings=permissions');
  const rules = page.locator('[data-testid="permission-rules"]');
  const deleteButtons = rules.getByRole('button', { name: /^Delete rule/ });
  await expect(deleteButtons).toHaveCount(1);
  await deleteButtons.click();
  await expect.poll(() => daemon.invocations('permissions.rules.delete')).toEqual([expect.objectContaining({ ruleId: SEEDED_PERMISSION_RULE.id })]);
  await expect(deleteButtons).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
