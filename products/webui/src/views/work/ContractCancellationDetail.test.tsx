/** Real facade, confirmation controls and hook against captured authenticated route bytes. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { LIVE_CANCELLATION, RETAINED_CANCELLATION } from '../../../e2e/support/contract-cancellation-fixture';
import { useContractList, useContractScope } from '../../hooks/useContracts';
import { tokenStore } from '../../lib/client-lifetime';
import { queryKeys } from '../../lib/queries';
import { ContractDetail } from './ContractDetail';
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
beforeEach(async () => { await tokenStore.setToken('captured-cancellation-account'); });
afterEach(async () => { for (const clean of cleanups.splice(0)) clean(); globalThis.fetch = originalFetch; await tokenStore.clearToken(); });
async function settle(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Contract controls did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); flushSync(() => {}); }
}
function render(capture = RETAINED_CANCELLATION) {
  let phase: 'before' | 'after' = 'before'; let ambiguous = false;
  const requests: { path: string; method: string; auth: string | null }[] = [];
  let fleetReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? 'GET';
    requests.push({ path: url.pathname, method, auth: new Headers(init?.headers).get('authorization') });
    if (method === 'POST') { phase = 'after'; if (ambiguous) throw new TypeError('Disconnected after send'); return new Response(capture.resultBody); }
    return new Response(url.pathname === '/api/contracts' ? capture[phase].listBody : capture[phase].getBody);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  function Harness() {
    const scope = useContractScope(); useContractList(scope, true, true, false);
    useQuery({ queryKey: queryKeys.fleet, queryFn: () => { fleetReads++; return Promise.resolve({}); } });
    return <ContractDetail key={scope.revision} id={capture.before.record.id} lifetime={scope} live={false} onClose={() => undefined} />;
  }
  flushSync(() => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
  const button = (label: string, scope: ParentNode = document) => [...scope.querySelectorAll('button')].find(item => item.textContent === label);
  const click = (label: string, scope: ParentNode = document) => { const item = button(label, scope); if (!item) throw new Error(`Missing ${label}`); flushSync(() => item.click()); };
  return { el, requests, button, click, fleet: () => fleetReads, ambiguous: () => { ambiguous = true; } };
}
for (const capture of [LIVE_CANCELLATION, RETAINED_CANCELLATION]) {
  test(`${capture.name}: explicit warning/dismissal and confirmed wire acknowledgement retain authoritative state`, async () => {
    const h = render(capture); await settle(() => Boolean(h.button('Cancel contract', h.el)));
    h.click('Cancel contract', h.el);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Files already changed may be incomplete');
    expect(document.activeElement?.textContent).toBe('Keep running');
    h.click('Keep running', dialog); expect(h.requests.every(r => r.method === 'GET')).toBe(true);
    const reads = h.requests.length, fleet = h.fleet(); h.click('Cancel contract', h.el);
    h.click('Cancel contract', document.querySelector('[role="alertdialog"]')!);
    await settle(() => Boolean(h.el.querySelector('[role="status"]')));
    await settle(() => h.fleet() > fleet);
    expect(h.requests.filter(r => r.method === 'POST')).toEqual([{ path: `/api/contracts/${capture.before.record.id}/cancel`, method: 'POST', auth: 'Bearer captured-cancellation-account' }]);
    expect(h.requests.length).toBeGreaterThan(reads + 1);
    if (capture.name === 'live') {
      expect(h.el.textContent).toContain('Child processes may still be stopping');
      expect(h.button('Cancel contract', h.el)).toBeUndefined();
    } else {
      expect(h.el.textContent).toContain('retained record without a live runner');
      expect(h.button('Cancel contract', h.el)).toBeDefined();
    }
  });
}
test('unknown transport outcome remains visible and cannot be resubmitted until explicit read refresh', async () => {
  const h = render(); h.ambiguous(); await settle(() => Boolean(h.button('Cancel contract', h.el)));
  h.click('Cancel contract', h.el); h.click('Cancel contract', document.querySelector('[role="alertdialog"]')!);
  await settle(() => h.el.textContent?.includes('Cancellation outcome is unknown') ?? false);
  expect(h.button('Cancel contract', h.el)?.disabled).toBe(true);
  h.click('Cancel contract', h.el); expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(h.requests.filter(r => r.method === 'POST')).toHaveLength(1);
  await settle(() => !h.button('Refresh contract', h.el)?.disabled); h.click('Refresh contract', h.el);
  await settle(() => !h.button('Cancel contract', h.el)?.disabled);
  expect(h.requests.filter(r => r.method === 'POST')).toHaveLength(1);
});
