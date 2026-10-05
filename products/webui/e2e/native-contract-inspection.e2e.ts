/** Genuine runner → daemon REST captures through the production WebUI on phone and desktop. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { detailPane, expectNoHorizontalScroll, listRow, openRow } from './support/app';
import { CAPTURED_CONTRACTS, malformedCapturedRecords } from './support/native-contract-records';
import { installCapturedContractDaemon } from './support/native-contract-fixture';

type CapturedDaemon = Awaited<ReturnType<typeof installCapturedContractDaemon>>;

async function expandRecordedDetails(detail: Locator) {
  for (let count = 0; count < 80; count += 1) {
    const closed = detail.locator('details:not([open]) > summary:visible');
    if (await closed.count() === 0) return;
    await closed.first().click();
  }
  throw new Error('Captured record unexpectedly exceeded 80 disclosures.');
}

function fact(scope: Locator, label: string) {
  return scope.locator('.dv-facts__row').filter({ has: scope.page().getByText(label, { exact: true }) }).locator('dd');
}

async function expectInspectionOnly(detail: Locator, daemon: CapturedDaemon, terminal: boolean) {
  await expect(detail.getByRole('button', { name: /^(approve|reject|reply|resume|amend|revise|start)\b/i })).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toHaveCount(terminal ? 0 : 1);
  await expect(detail.getByRole('textbox')).toHaveCount(0);
  expect(daemon.requests.filter((request) => (
    request.path.startsWith('/api/contracts') && request.method !== 'GET'
  ) || (request.methodId?.startsWith('contracts.') && !['contracts.get', 'contracts.list'].includes(request.methodId)))).toEqual([]);
}

async function screenshot(page: Page, name: string) {
  const path = test.info().outputPath(`${test.info().project.name}-${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(`${test.info().project.name}: ${name}`, { path, contentType: 'image/png' });
}

async function openCapture(page: Page, fixture: typeof CAPTURED_CONTRACTS[number]) {
  await page.goto('/?view=work&tab=processes');
  if (['passed', 'failed', 'cancelled'].includes(fixture.record.status)) {
    await page.getByRole('combobox', { name: 'Show', exact: true }).click();
    await page.getByRole('option', { name: 'Active and finished', exact: true }).click();
  }
  // Accessible text matching normalizes whitespace; original textContent is
  // independently asserted, including Unicode/newlines/trailing space.
  const rowText = fixture.record.goal.trim().replace(/\s+/g, ' ');
  await expect(listRow(page, rowText)).toBeVisible();
  const detail = await openRow(page, rowText);
  await expect(detail.locator('.contract-tree')).toBeVisible();
  return detail;
}

for (const fixture of CAPTURED_CONTRACTS) {
  test(`${fixture.name}: genuine evidence survives list/detail, refresh and strict malformed rejection`, async ({ page }) => {
    const daemon = await installCapturedContractDaemon(page, fixture);
    const detail = await openCapture(page, fixture);
    const record = fixture.record;
    await expect(detail.getByRole('heading', { name: record.goal.trim().replace(/\s+/g, ' '), exact: true })).toBeVisible();
    await expect(detail.locator('details').filter({ has: page.getByText('Original ask', { exact: true }) }).getByText(record.ask, { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, `${fixture.name}-overview`);
    await expandRecordedDetails(detail);
    for (const criterion of record.criteria) {
      await expect(detail.getByText(criterion.text, { exact: true }).first()).toBeVisible();
    }
    for (const check of [...record.checks, ...record.groups.flatMap((group) => group.checks), ...record.units.flatMap((unit) => unit.checks)]) {
      await expect(detail.getByText(check.evidenceDigest, { exact: true }).first()).toBeVisible();
    }

    if (record.nativeSource) {
      const source = detail.getByRole('region', { name: 'Native source', exact: true });
      const goal = source.getByRole('region', { name: 'Original native goal', exact: true }).locator('p');
      await expect(goal).toHaveJSProperty('textContent', record.nativeSource.goal);
      for (const criterion of record.nativeSource.criteria) {
        await expect(source.getByRole('list', { name: 'Original native criteria', exact: true }).getByText(criterion, { exact: true })).toBeVisible();
      }
      await expect(fact(source, 'Source revision')).toHaveText(record.nativeSource.sourceRevision);
      await expect(fact(source, 'Input revision')).toHaveText(record.nativeSource.inputRevision);
    }
    if (record.nativeProgress) {
      const progress = detail.getByRole('region', { name: 'Native progress', exact: true });
      await expect(fact(progress, 'State')).toHaveText(record.nativeProgress.state);
      await expect(fact(progress, 'Stage')).toHaveText(record.nativeProgress.stage);
    }
    if (record.nativeWaiting) {
      const waiting = detail.getByRole('region', { name: 'Transport waiting', exact: true });
      await expect(waiting.getByText('Shared-port retry progress describes transport attempts. It does not record a semantic outcome.', { exact: true })).toBeVisible();
      for (const request of record.nativeWaiting.requests) {
        const row = waiting.getByRole('list', { name: 'Transport waiting requests', exact: true }).locator(':scope > li').filter({ hasText: request.logicalRequestId });
        await expect(fact(row, 'Logical request id')).toHaveText(request.logicalRequestId);
        await expect(fact(row, 'Attempt')).toHaveText(String(request.attempt.attempt));
        await expect(fact(row, 'Transport outcome')).toHaveText(request.attempt.outcome);
        await expect(fact(row, 'HTTP status')).toHaveText(String(request.attempt.status));
        await expect(fact(row, 'Requested model')).toHaveText(request.attempt.requestedModel ?? '');
        await expect(fact(row, 'Next retry delay (ms)')).toHaveText(String(request.nextDelayMs));
      }
      await expect(detail.getByText('Recorded outcome: defer', { exact: true })).toHaveCount(0);
      await expect(detail.getByRole('region', { name: 'Recorded resume condition', exact: true })).toHaveCount(0);
      await expect(detail.getByText('No native semantic decisions recorded.', { exact: true })).toBeVisible();
      await waiting.scrollIntoViewIfNeeded();
      await screenshot(page, `${fixture.name}-transport-waiting`);
    }
    for (const entry of record.nativeDecisions?.history ?? []) {
      const history = detail.getByRole('list', { name: 'Native decision history', exact: true });
      const decision = history.locator(':scope > li').filter({ hasText: entry.decision.decisionId });
      await expect(decision.getByText(`Recorded outcome: ${entry.decision.outcome}`, { exact: true })).toBeVisible();
      await expect(fact(decision, 'Decision id')).toHaveText(entry.decision.decisionId);
      await expect(fact(decision, 'Operation revision')).toHaveText(entry.operationRevision);
      await expect(fact(decision, 'Action revision')).toHaveText(entry.decision.binding.actionRevision);
      for (const id of entry.decision.judgmentDecisionIds) await expect(decision.getByText(id, { exact: true })).toBeVisible();
      for (const reference of entry.decision.evidence) await expect(decision.getByText(reference.revision, { exact: true }).first()).toBeVisible();
      if (entry.decision.outcome === 'defer') {
        const condition = decision.getByRole('region', { name: 'Recorded resume condition', exact: true });
        await expect(fact(condition, 'Reference id')).toHaveText(entry.decision.until.id);
        await expect(fact(condition, 'Revision')).toHaveText(entry.decision.until.revision);
        await expect(detail.getByRole('list', { name: 'Pending native records', exact: true }).getByText(entry.decision.decisionId, { exact: true })).toBeVisible();
      }
      await decision.scrollIntoViewIfNeeded();
      await screenshot(page, `${fixture.name}-semantic-decision`);
    }
    if (record.durableAdmission) {
      const admission = detail.locator('details').filter({ has: page.getByText('Durable admission provenance', { exact: true }) });
      await expect(fact(admission, 'Payload revision')).toHaveText(record.durableAdmission.payloadRevision);
      await expect(admission.getByText('This admission receipt records an input and execution placement. It is not permission to run work.', { exact: true })).toBeVisible();
      await expect(detail.getByText('A persisted launch claim does not establish whether execution began.', { exact: true })).toBeVisible();
      await expect(fact(detail.getByRole('region', { name: 'Durable launch record', exact: true }), 'Launch state')).toHaveText('launch-claimed');
    }
    if (record.inputSnapshot) {
      const capture = detail.locator('details').filter({ has: page.getByText('Captured input provenance', { exact: true }) });
      await expect(fact(capture, 'Snapshot id')).toHaveText(record.inputSnapshot.id);
      await expect(fact(capture, 'Source root')).toHaveText(record.inputSnapshot.sourceRoot);
      for (const file of record.inputSnapshot.files) {
        const row = capture.getByRole('list', { name: 'Captured files', exact: true }).locator(':scope > li').filter({ hasText: file.path });
        await expect(fact(row, 'Path')).toHaveText(file.path);
        if (file.digest) await expect(fact(row, 'Digest')).toHaveText(file.digest);
        if (file.oid) await expect(fact(row, 'Object id')).toHaveText(file.oid);
      }
      await capture.scrollIntoViewIfNeeded();
      await screenshot(page, `${fixture.name}-captured-input`);
    }
    if (record.answer) await expect(detail.getByText(record.answer, { exact: true }).last()).toBeVisible();
    for (const unit of record.units) {
      if (unit.lastOutput) await expect(detail.getByText(unit.lastOutput, { exact: true })).toHaveJSProperty('textContent', unit.lastOutput);
    }
    await expectInspectionOnly(detail, daemon, ['passed', 'failed', 'cancelled'].includes(record.status));
    await expectNoHorizontalScroll(page);
    const tree = detail.locator('.contract-tree');
    expect(await tree.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

    const initialGets = daemon.requests.filter((request) => request.path === `/api/contracts/${record.id}`).length;
    await detail.getByRole('button', { name: 'Refresh contract', exact: true }).click();
    await expect.poll(() => daemon.requests.filter((request) => request.path === `/api/contracts/${record.id}`).length).toBeGreaterThan(initialGets);
    await expect(tree).toBeVisible();
    await expect(detail.getByRole('alert')).toHaveCount(0);

    // Deliberate invalid responses exercise closed objects, maps, enums,
    // primitives and semantic unions through real Refresh/Retry controls.
    for (const malformed of malformedCapturedRecords(record)) {
      daemon.setMalformedResponse(malformed.value);
      await detail.getByRole('button', { name: 'Refresh contract', exact: true }).click();
      await expect(detail.getByRole('alert'), malformed.name).toContainText('unreadable contract record');
      await expect(tree, malformed.name).toHaveCount(0);
      await expect(detail.getByRole('button', { name: 'Cancel contract', exact: true })).toHaveCount(0);
      daemon.restore();
      await detail.getByRole('button', { name: 'Retry contract', exact: true }).click();
      await expect(tree).toBeVisible();
      await expect(detail.getByRole('alert')).toHaveCount(0);
    }
    await expectInspectionOnly(detail, daemon, ['passed', 'failed', 'cancelled'].includes(record.status));
    await expectNoHorizontalScroll(page);
    if (test.info().project.name === 'phone') await page.getByRole('button', { name: 'All work', exact: true }).click();
    else await detail.getByRole('button', { name: 'Close contract', exact: true }).click();
    await expect(detailPane(page)).toHaveCount(0);
    await expect(listRow(page, record.goal.trim().replace(/\s+/g, ' '))).toBeVisible();
    expect(daemon.requests.some((request) => request.path === '/api/contracts' && request.method === 'GET')).toBe(true);
  });
}
