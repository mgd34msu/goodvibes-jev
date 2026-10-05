/** Browser config traffic goes through the real dispatcher, handler and owned disk store. */
import type { Page } from '@playwright/test';
import { installMockDaemon } from './mock-daemon';
import { createTerminalThemeHost } from './terminal-theme-host';

export async function installTerminalThemeDaemon(page: Page, savedTheme?: string) {
  const daemon = await installMockDaemon(page);
  const host = createTerminalThemeHost(savedTheme);
  await page.route('**/config', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname !== '/config' && pathname !== '/api/config') throw new Error(`Unexpected browser config path: ${pathname}`);
    // The browser/proxy prefix is transport-only; the daemon dispatcher owns /config.
    const response = await host.dispatch(new Request('http://terminal-theme-fixture/config', {
      method: request.method(),
      headers: request.headers(),
      ...(request.method() === 'POST' ? { body: request.postData() } : {}),
    }));
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  return { ...daemon, host };
}
