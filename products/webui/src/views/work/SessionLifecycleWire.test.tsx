/** Real SessionDetail and SDK facade with synthetic HTTP only. */
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getClientLifetime, tokenStore, WEBUI_TOKEN_STORE_KEY } from '../../lib/client-lifetime';
import { queryKeys } from '../../lib/queries';
import { unionSessionsFromListResponse } from '../../lib/sessions-union';
import { ToastProvider } from '../../lib/toast';
mock.module('../../hooks/useCompactionReceipts', () => ({ useCompactionReceipts: () => ({ receipts: [], latestCheck: null, connected: true, error: null }) }));
const { SessionDetail } = await import('./SessionDetail');
const { sdk } = await import('../../lib/goodvibes');
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
beforeEach(async () => { await tokenStore.setToken('synthetic-account-A'); });
afterEach(async () => { for (const dispose of cleanups.splice(0)) dispose(); mock.restore(); globalThis.fetch = originalFetch; await tokenStore.clearToken(); });
const rawRecord = (id: string, status = 'active') => ({ id, title: id, kind: 'tui', status, createdAt: 1, updatedAt: 1, messageCount: 0, surfaceKinds: [] });
const record = (id: string, status = 'active') => unionSessionsFromListResponse({ sessions: [rawRecord(id, status)] })[0]!;
async function settle(check: () => boolean) {
  const end = Date.now() + 2500;
  while (!check()) { if (Date.now() > end) throw new Error(`Timed out\n${document.body.textContent ?? ''}`); await new Promise(resolve => setTimeout(resolve, 5)); flushSync(() => {}); }
}
async function drain() { await new Promise(resolve => setTimeout(resolve, 25)); flushSync(() => {}); }
function click(element: Element | null | undefined) {
  if (!element) throw new Error('Missing click target');
  flushSync(() => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
}
function button(label: string) { return [...document.querySelectorAll('button')].find(element => element.textContent?.trim() === label); }
type Stage = 'close' | 'reopen' | 'delete' | 'list' | 'get';
function harness(options: { hold?: Stage; fail?: Stage; malformed?: boolean; stillPresent?: boolean; omitted?: boolean; notFound?: Stage; reuse?: boolean } = {}) {
  const requests: { path: string; method: string; auth: string | null; signal?: AbortSignal | null }[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let pending: Stage | undefined;
  let status = 'active'; let deleted = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname, method = init?.method ?? 'GET';
    requests.push({ path, method, auth: new Headers(init?.headers).get('authorization'), signal: init?.signal });
    const stage: Stage | undefined = path.endsWith('/close') ? 'close' : path.endsWith('/reopen') ? 'reopen' : method === 'DELETE' ? 'delete' : path === '/api/sessions' ? 'list' : path === '/api/sessions/old-session' ? 'get' : undefined;
    if (stage) {
      if (options.hold === stage) { pending = stage; await held; }
      if (stage === 'close') status = 'closed';
      if (stage === 'reopen') status = 'active';
      if (stage === 'delete') deleted = !options.stillPresent;
      if (options.fail === stage) throw new TypeError('Synthetic disconnected response after dispatch');
      if (options.notFound === stage || (stage === 'get' && deleted)) return Response.json(stage === 'delete' ? { code: 'SESSION_NOT_FOUND', error: 'Unknown shared session' } : { error: 'Unknown shared session' }, { status: 404 });
      if (stage === 'list') return Response.json(options.malformed ? { unexpected: [] } : { sessions: deleted || options.omitted ? [] : [rawRecord('old-session', status)] });
      if (stage === 'delete') return Response.json({ sessionId: 'old-session', deleted: true });
      return Response.json({ session: rawRecord('old-session', status) });
    }
    if (path.endsWith('/context-usage')) return Response.json({ estimatedContextTokens: 10, contextWindow: 100, contextUsagePct: 10 });
    if (path.endsWith('/permission-mode')) return Response.json({ mode: 'normal' });
    if (path.endsWith('/sessions.delete')) return Response.json({ method: { id: 'sessions.delete', invokable: true } });
    if (path.includes('/cost/') || path.includes('cost.attribution')) return Response.json({ rows: [] });
    if (path.endsWith('/messages')) return Response.json({ messages: [] });
    throw new Error(`Unhandled synthetic route: ${path}`);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 3 } } });
  const lifetime = getClientLifetime();
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  let closes = 0;
  function render(id: string | null, nextStatus = 'active') {
    flushSync(() => root.render(<QueryClientProvider client={client}><ToastProvider>
      {id && <SessionDetail key={options.reuse ? undefined : id} record={record(id, nextStatus)} agents={[]} tab="transcript"
        onTabChange={() => undefined} streamPaused={false} onOpenItem={() => undefined} onClose={() => { closes++; }} />}
    </ToastProvider></QueryClientProvider>));
  }
  cleanups.push(() => { release(); flushSync(() => root.unmount()); client.clear(); el.remove(); });
  const writes = () => requests.filter(request => request.method !== 'GET' && request.path.startsWith('/api/sessions/'));
  return { requests, writes, render, release, client, lifetime, options, el, pending: () => pending, closes: () => closes };
}
async function askDelete(h: ReturnType<typeof harness>) {
  if (!document.querySelector('[aria-label="More session actions"]')) h.render('old-session');
  await settle(() => Boolean(document.querySelector('[aria-label="More session actions"]')));
  await drain(); click(document.querySelector('[aria-label="More session actions"]'));
  await settle(() => Boolean(button('Delete permanently'))); click(button('Delete permanently'));
  await settle(() => Boolean(document.querySelector('.gv-confirm__confirm')));
}
async function startDelete(h: ReturnType<typeof harness>) {
  await askDelete(h); click(document.querySelector('.gv-confirm__confirm')); await settle(() => h.writes().length > 0);
}
for (const backToA of [false, true]) {
  test(`buffered close cannot continue delete after identity A→B${backToA ? '→A' : ''}`, async () => {
    const h = harness({ hold: 'close' }); await startDelete(h);
    await tokenStore.setToken('synthetic-account-B'); if (backToA) await tokenStore.setToken('synthetic-account-A');
    h.release(); await drain();
    expect(h.writes().map(({ path, method, auth }) => ({ path, method, auth }))).toEqual([
      { path: '/api/sessions/old-session/close', method: 'POST', auth: 'Bearer synthetic-account-A' },
    ]);
    expect(h.writes()[0]?.signal?.aborted).toBe(true); expect(h.requests.some(request => request.path === '/api/sessions')).toBe(false); expect(h.closes()).toBe(0);
  });
}
for (const reuse of [false, true]) for (const stage of ['close', 'delete', 'list', 'get'] as const) {
  test(`${reuse ? 'same component' : 'remounted detail'} selection A→B→A rejects late ${stage} completion`, async () => {
    const h = harness({ hold: stage, reuse }); await startDelete(h); await settle(() => h.pending() === stage);
    h.render('new-session'); h.render('old-session'); h.release(); await drain();
    expect(h.writes()).toHaveLength(stage === 'close' ? 1 : 2); expect(h.closes()).toBe(0);
    expect(h.client.getQueryData(queryKeys.sessionList(h.lifetime.revision))).toBeUndefined();
    expect(h.el.textContent).toContain('Session action outcome is unknown'); expect(button('Close session')?.disabled).toBe(true);
  });
}
for (const stage of ['close', 'delete', 'list', 'get'] as const) {
  test(`unmounted ${stage} cannot adopt its response or close replacement detail`, async () => {
    const h = harness({ hold: stage }); await startDelete(h); await settle(() => h.pending() === stage);
    h.render(null); h.render('new-session'); h.release(); await drain();
    expect(h.closes()).toBe(0); expect(h.writes()).toHaveLength(stage === 'close' ? 1 : 2);
    expect(h.el.textContent).toContain('new-session'); expect(h.el.textContent).not.toContain('Session action outcome is unknown');
    expect(h.client.getQueryData(queryKeys.sessionList(h.lifetime.revision))).toBeUndefined();
  });
}
test('token expiry during buffered close invalidates the originating action', async () => {
  localStorage.setItem(`${WEBUI_TOKEN_STORE_KEY}.expiresAt`, String(Date.now() + 60_000));
  const h = harness({ hold: 'close' }); await startDelete(h);
  localStorage.setItem(`${WEBUI_TOKEN_STORE_KEY}.expiresAt`, String(Date.now() - 1));
  h.release(); await drain(); expect(h.writes()).toHaveLength(1); expect(h.closes()).toBe(0);
});
test('confirmation cannot transfer to a newer selection or account', async () => {
  const h = harness({ reuse: true }); await askDelete(h); const oldConfirm = document.querySelector('.gv-confirm__confirm');
  h.render('new-session'); click(oldConfirm); await drain(); expect(h.writes()).toHaveLength(0);
  await askDelete(h); const accountConfirm = document.querySelector('.gv-confirm__confirm');
  await tokenStore.setToken('synthetic-account-B'); click(accountConfirm); await drain(); expect(h.writes()).toHaveLength(0);
});
test('cancel confirmation sends nothing; duplicate confirmation sends one close/delete/list/get chain', async () => {
  const h = harness({ hold: 'close' }); await askDelete(h);
  expect(document.activeElement?.textContent).toBe('Cancel'); click(button('Cancel')); expect(h.writes()).toHaveLength(0);
  await askDelete(h); const confirmation = document.querySelector('.gv-confirm__confirm'); click(confirmation); click(confirmation);
  await settle(() => h.pending() === 'close'); expect(h.writes()).toHaveLength(1);
  click(button('Close session')); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  h.release(); await settle(() => h.closes() === 1);
  expect(h.writes().map(request => request.method)).toEqual(['POST', 'DELETE']);
  expect(h.requests.filter(request => request.path === '/api/sessions')).toHaveLength(1);
  expect(h.client.getQueryData<{ sessions: unknown[] }>(queryKeys.sessionList(h.lifetime.revision))).toEqual({ sessions: [] });
});
for (const action of ['close', 'reopen'] as const) {
  test(`${action} repeated clicks remain one flight and reconcile same-account state`, async () => {
    const h = harness({ hold: action }); h.render('old-session', action === 'reopen' ? 'closed' : 'active'); await drain();
    if (action === 'close') { click(button('Close session')); click(document.querySelector('.gv-confirm__confirm')); }
    else { const reopen = button('Reopen'); click(reopen); click(reopen); }
    await settle(() => h.pending() === action); expect(h.writes()).toHaveLength(1);
    h.release(); await settle(() => Boolean(h.client.getQueryData(queryKeys.sessionList(h.lifetime.revision))));
    expect(h.closes()).toBe(0); expect(h.writes()).toHaveLength(1);
  });
}
for (const stage of ['close', 'delete', 'list'] as const) {
  test(`unknown ${stage} stays locked across detail reopen until successful explicit read`, async () => {
    const h = harness({ fail: stage }); await startDelete(h); await settle(() => h.el.textContent?.includes('Session action outcome is unknown') ?? false);
    const count = h.writes().length; h.render(null); h.render('old-session');
    expect(h.el.textContent).toContain('Session action outcome is unknown'); expect(button('Close session')?.disabled).toBe(true);
    h.options.fail = undefined; h.options.malformed = true; click(button('Refresh session state'));
    await settle(() => h.el.textContent?.includes('Could not refresh session state') ?? false);
    expect(button('Close session')?.disabled).toBe(true); expect(h.writes()).toHaveLength(count);
    h.options.malformed = false; click(button('Refresh session state')); await settle(() => !h.el.textContent?.includes('Session action outcome is unknown'));
    expect(h.writes()).toHaveLength(count);
    if (stage === 'close') { await askDelete(h); click(button('Cancel')); expect(h.writes()).toHaveLength(count); }
  });
}
for (const options of [{ malformed: true }, { stillPresent: true }, { stillPresent: true, omitted: true }]) {
  test(`${JSON.stringify(options)} cannot falsely prove deletion`, async () => {
    const h = harness(options); await startDelete(h); await settle(() => h.el.textContent?.includes('Session action outcome is unknown') ?? false);
    expect(h.closes()).toBe(0); expect(h.writes()).toHaveLength(2); expect(h.client.getQueryData(queryKeys.sessionList(h.lifetime.revision))).toBeUndefined();
  });
}
for (const stage of ['close', 'delete'] as const) {
  test(`${stage} SESSION_NOT_FOUND still requires an authoritative target proof-of-gone`, async () => {
    const h = harness({ notFound: stage }); await startDelete(h); await settle(() => h.closes() === 1);
    expect(h.writes()).toHaveLength(2); expect(h.requests.some(request => request.path === '/api/sessions/old-session' && request.method === 'GET')).toBe(true);
  });
}
for (const change of ['abort', 'account', 'direct-storage'] as const) {
  test(`async authentication ${change} prevents lifecycle dispatch`, async () => {
    const controller = new AbortController(); let finish!: (token: string) => void;
    const waiting = new Promise<string>(resolve => { finish = resolve; });
    const getter = spyOn(tokenStore, 'getToken').mockImplementationOnce(() => waiting);
    const h = harness(); const result = sdk.operator.sessions.delete('old-session', controller.signal).catch(error => error as unknown);
    await drain();
    if (change === 'abort') controller.abort(); else if (change === 'account') await tokenStore.setToken('synthetic-account-B'); else localStorage.setItem(WEBUI_TOKEN_STORE_KEY, 'synthetic-account-B');
    finish('synthetic-account-B'); expect(await result).toBeInstanceOf(DOMException); expect(h.writes()).toHaveLength(0); getter.mockRestore();
  });
}
