/** Real daemon-served bundle and routes. No intercepted requests or model calls. */
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect, type Page, type Request } from '@playwright/test';
import { WEBUI_METHOD_ROUTES } from '@goodvibes-jev/engine/contracts/generated/webui-facade';
import { isJsonRecord } from '@goodvibes-jev/engine/daemon-sdk';

const url = process.env.GOODVIBES_WEBUI_CONNECTED_URL;
const token = process.env.GOODVIBES_WEBUI_CONNECTED_TOKEN;
if (!url || !token) throw new Error('Set GOODVIBES_WEBUI_CONNECTED_URL and GOODVIBES_WEBUI_CONNECTED_TOKEN for an isolated test daemon serving the built WebUI.');
const origin = new URL(url);
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
  throw new Error('The connected daemon URL must be an HTTP origin without embedded credentials.');
}
const output = resolve(process.env.GOODVIBES_WEBUI_CONNECTED_OUTPUT ?? 'e2e/.artifacts/connected');
mkdirSync(output, { recursive: true });
type Method = 'control.status' | 'config.get' | 'sessions.create' | 'sessions.get' | 'sessions.list' | 'sessions.close' | 'sessions.delete';
const receipts: { viewport: string; stage: string }[] = [];
type RouteReceipt = { viewport: string; method: string; path: string; domains?: string; status: number | 'pending' };
const routes: RouteReceipt[] = [];
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  } : {}),
});

async function invoke(page: Page, method: Method, input: Record<string, unknown> = {}) {
  const route = WEBUI_METHOD_ROUTES[method];
  const body = { ...input };
  const path = route.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = body[key];
    assert.equal(typeof value, 'string', `Missing route parameter for ${method}`);
    delete body[key];
    return encodeURIComponent(String(value));
  });
  const target = new URL(path, origin);
  if (route.method === 'GET') {
    for (const [key, value] of Object.entries(body)) target.searchParams.set(key, String(value));
  }
  const response = await page.request.fetch(target.href, {
    method: route.method,
    headers: { authorization: `Bearer ${token}` },
    ...(route.method === 'GET' ? {} : { data: body }),
  });
  assert.equal(response.ok(), true, `${method} returned HTTP ${response.status()}`);
  const value: unknown = await response.json();
  assert.ok(isJsonRecord(value), `${method} must return an object`);
  return value;
}

function session(value: Record<string, unknown>, expectedStatus: 'active' | 'closed') {
  assert.ok(isJsonRecord(value.session), 'The daemon must return the actual session');
  assert.equal(value.session.status, expectedStatus);
  assert.equal(typeof value.session.id, 'string');
  if (typeof value.session.id !== 'string' || !value.session.id) throw new Error('Missing session identity');
  return value.session.id;
}

try {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'phone', width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.name === 'phone', hasTouch: viewport.name === 'phone',
    });
    const page = await context.newPage();
    const requests = new Map<Request, RouteReceipt>();
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/') || path === '/config') {
        const domains = path === '/api/control-plane/events' ? new URL(request.url()).searchParams.get('domains') : null;
        const receipt: RouteReceipt = { viewport: viewport.name, method: request.method(), path,
          ...(domains === null ? {} : { domains }), status: 'pending' };
        routes.push(receipt);
        requests.set(request, receipt);
      }
    });
    page.on('response', response => {
      const receipt = requests.get(response.request());
      if (receipt) receipt.status = response.status();
    });
    page.setDefaultTimeout(15_000);
    let createdId: string | undefined;
    try {
      const statusPath = new URL(WEBUI_METHOD_ROUTES['control.status'].path, origin).href;
      assert.equal((await page.request.get(statusPath)).status(), 401, 'Missing token must be refused');
      assert.equal((await page.request.get(statusPath, { headers: { authorization: 'Bearer connected-smoke-invalid-token' } })).status(), 401, 'Wrong token must be refused');
      await page.goto(origin.href);
      await page.getByLabel('Operator token', { exact: true }).fill(token);
      await page.getByRole('button', { name: 'Sign in with token', exact: true }).click();
      await expect(page.locator('.app-shell')).toBeVisible();
      await invoke(page, 'control.status');
      await invoke(page, 'config.get');
      receipts.push({ viewport: viewport.name, stage: 'real sign-in, protected status and canonical config' });

      const title = `connected-browser-${viewport.name}-${crypto.randomUUID()}`;
      createdId = session(await invoke(page, 'sessions.create', {
        title, surfaceKind: 'webui', surfaceId: title,
      }), 'active');
      await page.goto(new URL('/?view=work&tab=sessions', origin).href);
      const show = page.getByRole('combobox', { name: 'Show', exact: true });
      await show.click();
      await page.getByRole('option', { name: 'Active and finished', exact: true }).click();
      await page.locator('.dv-list .gv-row', { hasText: title }).locator('.gv-row__main').click();
      const detail = page.locator('.dv-detail');
      await expect(detail).toContainText(title);
      await detail.getByRole('button', { name: 'Close session', exact: true }).click();
      const close = page.getByRole('alertdialog', { name: 'Close this session?', exact: true });
      await close.getByRole('button', { name: 'Cancel', exact: true }).click();
      assert.equal(session(await invoke(page, 'sessions.get', { sessionId: createdId }), 'active'), createdId);
      await detail.getByRole('button', { name: 'Close session', exact: true }).click();
      const closed = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/sessions/${createdId}/close`);
      await close.getByRole('button', { name: 'Close session', exact: true }).click();
      assert.equal((await closed).status(), 200, 'The browser close must reach the real daemon');
      assert.equal(session(await invoke(page, 'sessions.get', { sessionId: createdId }), 'closed'), createdId);
      await expect(detail.getByRole('button', { name: 'Reopen', exact: true })).toBeEnabled({ timeout: 15_000 });
      const reopened = page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/api/sessions/${createdId}/reopen`);
      await detail.getByRole('button', { name: 'Reopen', exact: true }).click();
      assert.equal((await reopened).status(), 200, 'The browser reopen must reach the real daemon');
      await expect(detail.getByRole('button', { name: 'Close session', exact: true })).toBeEnabled();
      assert.equal(session(await invoke(page, 'sessions.get', { sessionId: createdId }), 'active'), createdId);
      await page.reload();
      await expect(page.locator('.dv-list .gv-row', { hasText: title })).toBeVisible();
      await page.locator('.dv-list .gv-row', { hasText: title }).locator('.gv-row__main').click();
      await expect(detail).toContainText('Unavailable here');
      await page.screenshot({ path: resolve(output, `${viewport.name}-session.png`), fullPage: true });
      receipts.push({ viewport: viewport.name, stage: 'session create, cancel-close, close, reopen and browser reload' });

      await detail.getByRole('button', { name: 'More session actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete permanently', exact: true }).click();
      const deleted = page.waitForResponse(response => response.request().method() === 'DELETE'
        && new URL(response.url()).pathname === `/api/sessions/${createdId}`);
      await page.getByRole('alertdialog', { name: 'Delete this session?', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
      assert.equal((await deleted).status(), 200, 'The browser deletion must reach the real daemon');
      const listed = await invoke(page, 'sessions.list');
      assert.ok(Array.isArray(listed.sessions), 'The final list must contain session records');
      assert.equal(listed.sessions.some((record: unknown) => isJsonRecord(record) && record.id === createdId), false, 'The daemon must verify hard deletion');
      createdId = undefined;
      await expect(page.locator('.dv-list .gv-row', { hasText: title })).toHaveCount(0);
      receipts.push({ viewport: viewport.name, stage: 'confirmed deletion and authoritative list reconciliation' });
    } catch (error: unknown) {
      await page.screenshot({ path: resolve(output, `${viewport.name}-failure.png`), fullPage: true });
      writeFileSync(resolve(output, `${viewport.name}-failure.txt`), await page.locator('body').innerText());
      throw error;
    } finally {
      if (createdId) {
        await invoke(page, 'sessions.close', { sessionId: createdId });
        await invoke(page, 'sessions.delete', { sessionId: createdId });
      }
      await context.close();
    }
  }
  writeFileSync(resolve(output, 'receipts.json'), `${JSON.stringify({ scope: 'real daemon-served browser, no model calls or interception', passed: true, receipts, routes }, null, 2)}\n`);
  process.stdout.write(`Connected browser smoke passed ${receipts.length} stages across desktop and phone. No model or live calibration claim.\n`);
} catch (error: unknown) {
  writeFileSync(resolve(output, 'receipts.json'), `${JSON.stringify({
    scope: 'real daemon-served browser, no model calls or interception', passed: false, receipts, routes,
  }, null, 2)}\n`);
  const message = error instanceof Error ? error.message : 'Unknown browser failure';
  process.stderr.write(`Connected browser smoke failed: ${message.replaceAll(token, '[redacted]')}\n`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
