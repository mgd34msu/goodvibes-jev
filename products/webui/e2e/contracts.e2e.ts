/** Read-only contract inspection, against typed synthetic daemon responses. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { detailPane, expectNoHorizontalScroll, listRow, nextFrames, openNavigation, openRow } from './support/app';
import {
  CANCELLED_CONTRACT, CONTRACT_EVIDENCE_DIGEST, FAILED_CONTRACT, installContractDaemon,
  PASSED_CONTRACT, RUNNING_CONTRACT, WAITING_CONTRACT,
} from './support/contract-fixture';
import { installMockDaemon } from './support/mock-daemon';

type ContractDaemon = Awaited<ReturnType<typeof installContractDaemon>>;

async function show(page: Page, scope: 'Active' | 'Active and finished' | 'Archive') {
  await page.getByRole('combobox', { name: 'Show', exact: true }).click();
  await page.getByRole('option', { name: scope, exact: true }).click();
}

async function closeContract(page: Page) {
  if (test.info().project.name === 'phone') await page.getByRole('button', { name: 'All work', exact: true }).click();
  else await page.getByRole('button', { name: 'Close contract', exact: true }).click();
  await expect(detailPane(page)).toHaveCount(0);
}

async function expandEvidence(detail: Locator) {
  // Exercise the real disclosure controls, including nested group/unit checks.
  for (let count = 0; count < 40; count += 1) {
    const closed = detail.locator('details:not([open]) > summary:visible');
    if (await closed.count() === 0) return;
    await closed.first().click();
  }
  throw new Error('Contract fixture unexpectedly needs more than 40 disclosures.');
}

function expectReadOnly(daemon: ContractDaemon) {
  expect(daemon.requests.filter((request) => (
    request.path.startsWith('/api/contracts') && request.method !== 'GET'
  ) || (request.methodId?.startsWith('contracts.') && !['contracts.get', 'contracts.list'].includes(request.methodId)))).toEqual([]);
}

test('Work renders the goal, criteria readings, evidence, group/unit checks and escalation history without unsolicited mutations', async ({ page }) => {
  const daemon = await installContractDaemon(page);
  await page.goto('/?view=work');
  const detail = await openRow(page, WAITING_CONTRACT.goal);
  await expect(detail.getByRole('heading', { name: WAITING_CONTRACT.goal, exact: true })).toBeVisible();
  await expect(detail.getByText(WAITING_CONTRACT.ask, { exact: true })).toBeVisible();
  const readings = detail.getByRole('list', { name: 'Readings for criterion-phone', exact: true });
  await expect(readings.getByText('0.32', { exact: true })).toBeVisible();
  await expect(readings.getByText('0.81', { exact: true })).toBeVisible();
  await expect(readings.getByText('unshown', { exact: true })).toBeVisible();
  await expect(readings.getByText('escalate', { exact: true })).toBeVisible();
  // A criterion's recorded check is navigable even before evidence is expanded.
  await readings.getByRole('link', { name: 'ctr-a1000001.k2', exact: true }).click();
  await expect(detail.getByText(CONTRACT_EVIDENCE_DIGEST, { exact: true })).toBeVisible();
  await expandEvidence(detail);

  for (const text of [
    'The detail fits the phone viewport.',
    'Only read endpoints are exposed.',
    'The owner requested local inspection only.',
    'decision-phone-1', 'decision-phone-2',
    CONTRACT_EVIDENCE_DIGEST,
    'Browser proof is attached to the checked commit.',
    'Types passed with no diagnostics.',
    'Phone detail overflow remains unresolved.',
    'Publishing was outside the requested scope.',
    'Read-only inspection group', 'Phone inspection unit',
    'Evidence digests remain readable.', 'group-evidence-001', 'unit-evidence-001',
    'Should the check include desktop?', 'Include desktop as well as phone.',
    'Can the phone overflow be accepted for this release?',
  ]) await expect(detail.getByText(text, { exact: false }).last()).toBeVisible();

  await expect(detail.getByRole('button', { name: /^(approve|reject|reply|resume|amend|start)\b/i })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toBeVisible();
  await expect(detail.getByRole('textbox')).toHaveCount(0);
  await expect.poll(() => daemon.requests.some((request) => request.method === 'GET' && request.path === `/api/contracts/${WAITING_CONTRACT.id}`)).toBe(true);
  await expectNoHorizontalScroll(page);
  await detail.getByText(CONTRACT_EVIDENCE_DIGEST, { exact: true }).scrollIntoViewIfNeeded();
  const screenshot = test.info().outputPath('contract-evidence.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await test.info().attach('Recorded contract evidence', { path: screenshot, contentType: 'image/png' });
  await closeContract(page);
  await nextFrames(page);
  await expect(detailPane(page)).toHaveCount(0);
  expectReadOnly(daemon);
});

test('Processes includes active contracts, explicitly loads terminal states, and keeps contracts out of Archive', async ({ page }) => {
  const daemon = await installContractDaemon(page);
  await page.goto('/?view=work&tab=processes');
  await expect(listRow(page, WAITING_CONTRACT.goal)).toBeVisible();
  await expect(listRow(page, RUNNING_CONTRACT.goal)).toBeVisible();
  await expect(listRow(page, PASSED_CONTRACT.goal)).toHaveCount(0);
  await expect.poll(() => daemon.requests.some((request) => request.path === '/api/contracts' && new URLSearchParams(request.search).get('includeTerminal') === 'false')).toBe(true);

  await show(page, 'Active and finished');
  for (const contract of [PASSED_CONTRACT, FAILED_CONTRACT, CANCELLED_CONTRACT]) {
    await expect(listRow(page, contract.goal)).toBeVisible();
  }
  await expect.poll(() => daemon.requests.some((request) => request.path === '/api/contracts' && new URLSearchParams(request.search).get('includeTerminal') === 'true')).toBe(true);
  await show(page, 'Archive');
  for (const contract of [WAITING_CONTRACT, RUNNING_CONTRACT, PASSED_CONTRACT, FAILED_CONTRACT, CANCELLED_CONTRACT]) {
    await expect(listRow(page, contract.goal)).toHaveCount(0);
  }
  await show(page, 'Active');
  await expect(listRow(page, RUNNING_CONTRACT.goal)).toBeVisible();
  await expect(listRow(page, PASSED_CONTRACT.goal)).toHaveCount(0);
  expectReadOnly(daemon);
});

test('terminal contracts show their recorded answer, failure and cancellation result', async ({ page }) => {
  const daemon = await installContractDaemon(page);
  await page.goto('/?view=work&tab=processes');
  await expect(listRow(page, RUNNING_CONTRACT.goal)).toBeVisible();
  await show(page, 'Active and finished');
  for (const [contract, result] of [
    [PASSED_CONTRACT, PASSED_CONTRACT.answer],
    [FAILED_CONTRACT, FAILED_CONTRACT.error],
    [CANCELLED_CONTRACT, CANCELLED_CONTRACT.statusLine],
  ] as const) {
    const detail = await openRow(page, contract.goal);
    if (!result) throw new Error(`Missing terminal result for ${contract.id}.`);
    await expect(detail.getByText(result, { exact: false })).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toHaveCount(0);
    if (contract.id === PASSED_CONTRACT.id) {
      await expect(detail.getByText('Inspection did not write a commit.', { exact: false })).toBeVisible();
    }
    await closeContract(page);
  }
  expectReadOnly(daemon);
});

test('a contracts-domain SSE frame refetches the selected detail and list from authoritative reads', async ({ page }) => {
  const daemon = await installContractDaemon(page, { contracts: [RUNNING_CONTRACT] });
  await page.goto('/?view=work&tab=processes');
  await show(page, 'Active and finished');
  const detail = await openRow(page, RUNNING_CONTRACT.goal);
  await expect(detail.getByText(RUNNING_CONTRACT.ask, { exact: true })).toBeVisible();
  await expect.poll(() => daemon.streamCount).toBeGreaterThan(0);
  const initialLists = daemon.requests.filter((request) => request.path === '/api/contracts').length;
  const initialDetails = daemon.requests.filter((request) => request.path === `/api/contracts/${RUNNING_CONTRACT.id}`).length;
  const updated = { ...RUNNING_CONTRACT, status: 'passed' as const, completedAt: Date.now(), answer: 'Fresh detail arrived from contracts.get after the event.' };
  daemon.setContracts([updated]);
  await daemon.emitContractChange(updated.id, 'running', 'passed');
  await expect(detail.getByText(updated.answer, { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(daemon.requests.filter((request) => request.path === '/api/contracts').length).toBeGreaterThan(initialLists);
  expect(daemon.requests.filter((request) => request.path === `/api/contracts/${RUNNING_CONTRACT.id}`).length).toBeGreaterThan(initialDetails);
  await closeContract(page);
  await expect(page.getByRole('list', { name: 'Finished', exact: true }).getByText(RUNNING_CONTRACT.goal, { exact: true })).toBeVisible();
  expectReadOnly(daemon);
});

test('an empty contract collection keeps unrelated Work usable and never fabricates a contract', async ({ page }) => {
  const daemon = await installContractDaemon(page, { contracts: [] });
  await page.goto('/?view=work&tab=processes');
  await expect(page.locator('.dv-list .gv-row').first()).toBeVisible();
  await expect.poll(() => daemon.requests.some((request) => request.path === '/api/contracts')).toBe(true);
  await expect(page.getByText(/could not load contracts/i)).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search work' }).fill('no synthetic contract exists');
  await expect(page.getByText('Nothing here matches “no synthetic contract exists”.')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await expect(page.locator('.dv-list .gv-row').first()).toBeVisible();
  expectReadOnly(daemon);
});

test('a contract with no recorded criteria or checks has an honest empty detail', async ({ page }) => {
  await installContractDaemon(page, { contracts: [RUNNING_CONTRACT] });
  await page.goto('/?view=work&tab=processes');
  const detail = await openRow(page, RUNNING_CONTRACT.goal);
  await expect(detail.getByText(RUNNING_CONTRACT.ask, { exact: true })).toBeVisible();
  await expect(detail.getByText(/no criteria/i)).toBeVisible();
  await expect(detail.getByText(/no checks/i)).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('contract list failure is visible, leaves other Work usable, and retries without a mutation', async ({ page }) => {
  const daemon = await installContractDaemon(page, { listError: { status: 503, error: 'Synthetic contract store unavailable.' } });
  await page.goto('/?view=work&tab=processes');
  const notice = page.getByRole('alert').filter({ hasText: /could not load contracts/i });
  await expect(notice).toBeVisible();
  await expect(page.locator('.dv-list .gv-row').first()).toBeVisible();
  daemon.setListError(undefined);
  await notice.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(listRow(page, RUNNING_CONTRACT.goal)).toBeVisible();
  await expect(notice).toHaveCount(0);
  expectReadOnly(daemon);
});

test('a malformed contract list is reported as unreadable, never as an empty success', async ({ page }) => {
  const daemon = await installContractDaemon(page, { contracts: [RUNNING_CONTRACT] });
  let malformed = true;
  await page.route(/\/api\/contracts(?:\?.*)?$/, async (route) => {
    if (malformed) return route.fulfill({ json: {} });
    return route.fallback();
  });
  await page.goto('/?view=work&tab=processes');
  const notice = page.getByRole('alert').filter({ hasText: /could not load contracts/i });
  await expect(notice).toBeVisible();
  await expect(page.locator('.dv-list .gv-row').first()).toBeVisible();
  await expect(listRow(page, RUNNING_CONTRACT.goal)).toHaveCount(0);
  malformed = false;
  await notice.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(listRow(page, RUNNING_CONTRACT.goal)).toBeVisible();
  await expect(notice).toHaveCount(0);
  expectReadOnly(daemon);
});

test('a detail response for the wrong contract is rejected rather than displayed', async ({ page }) => {
  const daemon = await installContractDaemon(page, { contracts: [RUNNING_CONTRACT] });
  await page.route(`**/api/contracts/${RUNNING_CONTRACT.id}`, (route) => route.fulfill({ json: WAITING_CONTRACT }));
  await page.goto('/?view=work&tab=processes');
  const detail = await openRow(page, RUNNING_CONTRACT.goal);
  await expect(detail.getByRole('alert')).toContainText(/could not load this contract/i);
  await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toHaveCount(0);
  await expect(detail.getByText(WAITING_CONTRACT.ask, { exact: true })).toHaveCount(0);
  await closeContract(page);
  expectReadOnly(daemon);
});

test('contract detail failure can retry and Close or Back does not reopen it', async ({ page }) => {
  const daemon = await installContractDaemon(page, { contracts: [RUNNING_CONTRACT] });
  daemon.setDetailError(RUNNING_CONTRACT.id, { status: 503, error: 'Synthetic detail read failed.' });
  await page.goto('/?view=work&tab=processes');
  const detail = await openRow(page, RUNNING_CONTRACT.goal);
  await expect(detail.getByText(/Synthetic detail read failed/)).toBeVisible();
  daemon.setDetailError(RUNNING_CONTRACT.id, undefined);
  await detail.getByRole('button', { name: 'Retry contract', exact: true }).click();
  await expect(detail.getByText(RUNNING_CONTRACT.ask, { exact: true })).toBeVisible();
  await closeContract(page);
  await page.getByRole('region', { name: 'Work', exact: true }).getByRole('button', { name: 'Refresh', exact: true }).click();
  await nextFrames(page);
  await expect(detailPane(page)).toHaveCount(0);
  expectReadOnly(daemon);
});

for (const [code, message] of [
  ['CONTRACT_NOT_FOUND', 'This contract is no longer available on this daemon.'],
  ['METHOD_NOT_FOUND', 'Contract inspection is unavailable on this daemon.'],
] as const) {
  test(`${code} hides stale contract evidence and offers a read-only retry`, async ({ page }) => {
    const daemon = await installContractDaemon(page, { contracts: [RUNNING_CONTRACT] });
    await page.goto('/?view=work&tab=processes');
    const detail = await openRow(page, RUNNING_CONTRACT.goal);
    await expect(detail.getByText(RUNNING_CONTRACT.ask, { exact: true })).toBeVisible();
    daemon.setDetailError(RUNNING_CONTRACT.id, { status: 404, error: 'Synthetic contract read unavailable.', code });
    await detail.getByRole('button', { name: 'Refresh contract', exact: true }).click();
    await expect(detail.getByRole('alert')).toContainText(message);
    await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toHaveCount(0);
    await expect(detail.getByText(RUNNING_CONTRACT.ask, { exact: true })).toHaveCount(0);
    await expect(detail.getByRole('button', { name: 'Retry contract', exact: true })).toBeVisible();
    await closeContract(page);
    expectReadOnly(daemon);
  });
}

test('a late selected-contract read cannot undo Close or phone Back', async ({ page }) => {
  const daemon = await installContractDaemon(page, { contracts: [RUNNING_CONTRACT] });
  daemon.holdDetail(RUNNING_CONTRACT.id);
  try {
    await page.goto('/?view=work&tab=processes');
    await openRow(page, RUNNING_CONTRACT.goal);
    await expect.poll(() => daemon.pendingDetailCount(RUNNING_CONTRACT.id)).toBeGreaterThan(0);
    await closeContract(page);
    await daemon.releaseDetail(RUNNING_CONTRACT.id);
    await nextFrames(page);
    await expect(detailPane(page)).toHaveCount(0);
    await expect(listRow(page, RUNNING_CONTRACT.goal)).toBeVisible();
    expectReadOnly(daemon);
  } finally { await daemon.releaseDetail(RUNNING_CONTRACT.id); }
});

test('a late contract response cannot replace a newer row selection', async ({ page }) => {
  const daemon = await installContractDaemon(page, { contracts: [RUNNING_CONTRACT, WAITING_CONTRACT] });
  daemon.holdDetail(RUNNING_CONTRACT.id);
  try {
    await page.goto('/?view=work&tab=processes');
    await openRow(page, RUNNING_CONTRACT.goal);
    await expect.poll(() => daemon.pendingDetailCount(RUNNING_CONTRACT.id)).toBeGreaterThan(0);
    if (test.info().project.name === 'phone') await closeContract(page);
    const detail = await openRow(page, WAITING_CONTRACT.goal);
    await expect(detail.getByText(WAITING_CONTRACT.ask, { exact: true })).toBeVisible();
    await daemon.releaseDetail(RUNNING_CONTRACT.id);
    await nextFrames(page);
    await expect(detail.getByRole('heading', { name: WAITING_CONTRACT.goal, exact: true })).toBeVisible();
    await expect(detail.getByText(RUNNING_CONTRACT.ask, { exact: true })).toHaveCount(0);
    expectReadOnly(daemon);
  } finally { await daemon.releaseDetail(RUNNING_CONTRACT.id); }
});

for (const pending of [true, false]) {
  test(`${pending ? 'pending' : 'settled'} contract data does not survive a real cross-tab account change`, async ({ page, context }) => {
    const daemon = await installContractDaemon(page, { contracts: [RUNNING_CONTRACT] });
    if (pending) daemon.holdDetail(RUNNING_CONTRACT.id);
    const account = await context.newPage();
    await installMockDaemon(account);
    try {
      await page.goto('/?view=work&tab=processes');
      await openRow(page, RUNNING_CONTRACT.goal);
      if (pending) await expect.poll(() => daemon.pendingDetailCount(RUNNING_CONTRACT.id)).toBeGreaterThan(0);
      else await expect(detailPane(page).getByText(RUNNING_CONTRACT.ask, { exact: true })).toBeVisible();
      await account.goto('/?view=work');
      await openNavigation(account);
      await account.getByRole('button', { name: /^Account:/ }).click();
      await account.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
      await expect(account.locator('.signed-out-gate')).toBeVisible();
      await expect(page.getByText(RUNNING_CONTRACT.ask, { exact: true })).toHaveCount(0);

      const replacement = { ...RUNNING_CONTRACT, goal: 'Another account contract', ask: 'Only the new account response may be shown.' };
      daemon.setContracts([replacement]);
      await account.getByLabel('Operator token', { exact: true }).fill('e2e-second-account-token');
      await account.getByRole('button', { name: 'Sign in with token', exact: true }).click();
      await expect(account.locator('.app-shell')).toBeVisible();
      await daemon.releaseDetail(RUNNING_CONTRACT.id);
      await expect(listRow(page, replacement.goal)).toBeVisible();
      const detail = await openRow(page, replacement.goal);
      await expect(detail.getByText(replacement.ask, { exact: true })).toBeVisible();
      await expect(page.getByText(RUNNING_CONTRACT.ask, { exact: true })).toHaveCount(0);
      expectReadOnly(daemon);
    } finally {
      await daemon.releaseDetail(RUNNING_CONTRACT.id);
      await account.close();
    }
  });
}
