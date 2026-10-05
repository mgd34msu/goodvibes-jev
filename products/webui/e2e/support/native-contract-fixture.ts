/** Scoped GET overlays of genuine runner → daemon captures; other routes use the ordinary harness. */
import type { Page } from '@playwright/test';
import { installMockDaemon } from './mock-daemon';
import type { loadCapturedContract } from './native-contract-records';

export async function installCapturedContractDaemon(page: Page, fixture: ReturnType<typeof loadCapturedContract>) {
  const daemon = await installMockDaemon(page);
  let getBody = fixture.getBody;
  let listBody = fixture.listBody;
  await page.route('**/api/contracts**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET') {
      await route.fulfill({ status: 405, json: { error: 'Read-only captured contract inspection.' } });
      return;
    }
    if (url.pathname === '/api/contracts') {
      // Each original LIST was captured with includeTerminal=true. Only the
      // ordinary completed case is excluded from the app's active-only scope.
      const excluded = ['passed', 'failed', 'cancelled'].includes(fixture.record.status) && url.searchParams.get('includeTerminal') !== 'true';
      await route.fulfill({ contentType: 'application/json', body: excluded ? '{"contracts":[]}' : listBody });
      return;
    }
    if (url.pathname === `/api/contracts/${fixture.record.id}`) {
      await route.fulfill({ contentType: 'application/json', body: getBody });
      return;
    }
    await route.fulfill({ status: 404, json: { error: 'Unknown captured contract.', code: 'CONTRACT_NOT_FOUND' } });
  });
  return {
    ...daemon,
    setMalformedResponse(value: unknown) {
      getBody = JSON.stringify(value);
      listBody = JSON.stringify({ contracts: [value] });
    },
    restore() { getBody = fixture.getBody; listBody = fixture.listBody; },
  };
}
