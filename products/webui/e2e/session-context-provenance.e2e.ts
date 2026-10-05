/** Genuine runtime/route bytes, real SDK and session UI, on phone and desktop. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, openRow } from './support/app';
import { installSessionContextDaemon, type ContextScenario } from './support/session-context-fixture';

type Fixture = Awaited<ReturnType<typeof installSessionContextDaemon>>;
const contextFact = (detail: Locator) => detail.locator('.dv-facts__row').filter({
  has: detail.page().getByText('Context', { exact: true }),
}).locator('dd');
async function openLocal(page: Page, fixture: Fixture) {
  await page.goto('/?view=work&tab=sessions');
  const detail = await openRow(page, fixture.session.title);
  await expect(contextFact(detail)).not.toBeEmpty();
  return detail;
}
async function expectCapturedUsage(detail: Locator, fixture: Fixture, scenario: ContextScenario) {
  const usage = fixture.usage(scenario);
  const fact = contextFact(detail);
  if (usage.contextWindow === null) {
    await expect(fact).toContainText(`${usage.estimatedContextTokens.toLocaleString()} tokens estimated; context window unknown`);
    await expect(fact).not.toContainText('%');
    await expect(fact).not.toContainText(' of ');
  } else {
    await expect(fact).toContainText(`~${usage.contextUsagePct}% (${usage.estimatedContextTokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens, estimated)`);
  }
  await expect(fact).not.toContainText('NaN');
}

for (const [scenario, label] of [
  ['provider_api', 'provider API'], ['configured_cap', 'configured cap'],
  ['observed_limit', 'learned from a provider rejection'], ['fallback', 'fallback estimate'],
  ['consensus', 'estimate from'], ['accepted_floor', 'provider accepted a larger request than the stated window'],
  ['catalog', 'catalog:'], ['no_model', 'context window unknown'],
] as const) {
  test(`${scenario}: captured context provenance stays honest and readable`, async ({ page }, testInfo) => {
    const fixture = await installSessionContextDaemon(page, scenario);
    const detail = await openLocal(page, fixture);
    await expectCapturedUsage(detail, fixture, scenario);
    await expect(contextFact(detail)).toContainText(label);
    const usage = fixture.usage(scenario);
    if (usage.contextWindowAcceptedFloor !== undefined) {
      await expect(contextFact(detail)).toContainText(`provider accepted at least ${usage.contextWindowAcceptedFloor.toLocaleString()} tokens (lower bound, not capacity)`);
    }
    await expectNoHorizontalScroll(page);
    await contextFact(detail).scrollIntoViewIfNeeded();
    await testInfo.attach(`context-${scenario}`, { body: await page.screenshot(), contentType: 'image/png' });
    expect(fixture.reads).toContainEqual({ sessionId: fixture.capture.sessionId, scenario });
    expect(fixture.requests.filter(request => request.path.startsWith('/api/sessions') && request.method !== 'GET')).toEqual([]);
  });
}

test('provider change replaces known capacity with unknown and a compaction check refreshes usage', async ({ page }) => {
  const fixture = await installSessionContextDaemon(page);
  const detail = await openLocal(page, fixture);
  await expectCapturedUsage(detail, fixture, 'provider_api');
  await expect.poll(() => fixture.hasStream('providers')).toBe(true);
  fixture.setScenario('accepted_floor');
  await fixture.emitProviderChange();
  await expectCapturedUsage(detail, fixture, 'accepted_floor');
  await expect(contextFact(detail)).not.toContainText('source: provider API');
  await expect.poll(() => fixture.hasStream('compaction')).toBe(true);
  fixture.setScenario('configured_cap');
  await fixture.emitCompactionCheck();
  await expectCapturedUsage(detail, fixture, 'configured_cap');
  await expect(contextFact(detail)).toContainText('source: configured cap');
  await expect(contextFact(detail)).not.toContainText('999,999');
  await expect(contextFact(detail)).not.toContainText('lower bound, not capacity');
  expect(fixture.reads.map(read => read.scenario)).toEqual(['provider_api', 'accepted_floor', 'configured_cap']);
  await expectNoHorizontalScroll(page);
});

test('hosted scope without its own store snapshot remains unavailable and cannot inherit local usage', async ({ page }, testInfo) => {
  const fixture = await installSessionContextDaemon(page);
  const local = await openLocal(page, fixture);
  await expectCapturedUsage(local, fixture, 'provider_api');
  if (testInfo.project.name === 'phone') await page.getByRole('button', { name: 'All work', exact: true }).click();
  else await local.getByRole('button', { name: 'Close session detail', exact: true }).click();
  const detail = await openRow(page, fixture.hosted.title);
  await expect(contextFact(detail)).toHaveText('Unavailable here');
  await expect(contextFact(detail)).not.toContainText('tokens');
  expect(fixture.reads).toContainEqual({ sessionId: fixture.capture.hostedSessionId, scenario: 'hosted_refusal' });
  await expectNoHorizontalScroll(page);
});
