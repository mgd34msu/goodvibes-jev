import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider, onlineManager, useQuery } from '@tanstack/react-query';
import { getClientLifetime, tokenStore, WEBUI_TOKEN_STORE_KEY } from '../lib/client-lifetime';
import { queryKeys } from '../lib/queries';
let cancel: (id: string, signal: AbortSignal) => Promise<{ cancelled: boolean }> = () => Promise.resolve({ cancelled: true });
mock.module('../lib/goodvibes', () => ({
  hasStoredTokenSync: () => Boolean(localStorage.getItem(WEBUI_TOKEN_STORE_KEY)),
  sdk: { operator: { contracts: { cancel: (id: string, signal: AbortSignal) => cancel(id, signal) } } },
}));
const { useContractCancellation, CONTRACT_CANCEL_NOTICE } = await import('./useContractCancellation');
const { useContractScope } = await import('./useContracts');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve };
}
async function settle(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Cancellation did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5)); flushSync(() => {});
  }
}
const cleanups: (() => void)[] = [];
beforeEach(async () => { await tokenStore.setToken('cancel-account-a'); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup(); onlineManager.setOnline(true); await tokenStore.clearToken();
  cancel = () => Promise.resolve({ cancelled: true });
});
function render(initialId = 'first') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 5 } } });
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  const reads = { list: 0, detail: 0, fleet: 0, attempts: 0 }; let failReads = false, failAttempts = false;
  let fleetResponse: (() => Promise<string>) | undefined;
  let action: ReturnType<typeof useContractCancellation>;
  const read = (kind: keyof typeof reads) => { reads[kind]++; if (kind === 'fleet' && fleetResponse) return fleetResponse(); return (failReads || (kind === 'attempts' && failAttempts)) ? Promise.reject(new Error('read failed')) : Promise.resolve('running'); };
  function Detail({ id }: { id: string }) {
    const scope = useContractScope(); action = useContractCancellation(scope, id);
    const detail = useQuery({ queryKey: queryKeys.contractDetail(scope.revision, id), queryFn: () => read('detail') });
    return <div>{id}:{detail.data}:{action.phase}:{action.notice}</div>;
  }
  function Harness({ id }: { id: string }) {
    const scope = useContractScope();
    useQuery({ queryKey: queryKeys.contractList(scope.revision, true), queryFn: () => read('list') });
    useQuery({ queryKey: queryKeys.fleet, queryFn: () => read('fleet') });
    useQuery({ queryKey: queryKeys.fleetAttempts, queryFn: () => read('attempts') });
    return id ? <Detail key={`${scope.revision}:${id}`} id={id} /> : null;
  }
  const rerender = (id: string) => flushSync(() => root.render(<QueryClientProvider client={client}><Harness id={id} /></QueryClientProvider>));
  rerender(initialId); cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
  const ask = () => flushSync(() => action.ask());
  const confirm = () => { let result!: Promise<void>; flushSync(() => { result = action.confirm(); }); return result; };
  return { client, el, reads, rerender, action: () => action!, ask, confirm, failReads: () => { failReads = true; }, failAttempts: () => { failAttempts = true; }, holdFleet: (read: () => Promise<string>) => { fleetResponse = read; } };
}
describe('explicit lifetime-bound contract cancellation', () => {
  test('duplicate asks and confirmations make one request despite mutation retry defaults', async () => {
    const pending = deferred<{ cancelled: boolean }>(); let calls = 0;
    cancel = () => { calls++; return pending.promise; };
    const h = render(); h.ask(); h.ask(); expect(h.action().phase).toBe('confirming'); expect(calls).toBe(0);
    const first = h.confirm(), second = h.confirm(); h.ask(); expect(calls).toBe(1); expect(h.action().disabled).toBe(true);
    pending.resolve({ cancelled: true }); await Promise.all([first, second]); await settle(() => h.action().phase === 'acknowledged'); expect(calls).toBe(1);
  });
  test('dismissed intent never sends', async () => {
    let calls = 0; cancel = () => { calls++; return Promise.resolve({ cancelled: true }); };
    const h = render(); h.ask(); flushSync(() => h.action().dismiss()); await h.confirm(); expect(h.action().phase).toBe('idle'); expect(calls).toBe(0);
  });
  for (const replacement of ['', 'second']) {
    test(`${replacement || 'closed'} selection invalidates unsubmitted confirmation`, async () => {
      let calls = 0; cancel = () => { calls++; return Promise.resolve({ cancelled: true }); };
      const h = render(); h.ask(); const old = h.action(); h.rerender(replacement); await old.confirm(); expect(calls).toBe(0);
      h.rerender('first'); expect(h.action().phase).toBe('idle');
    });
    test(`${replacement || 'closed'} selection aborts response and retains unknown across reopening`, async () => {
      const pending = deferred<{ cancelled: boolean }>(); let signal: AbortSignal | undefined; let calls = 0;
      cancel = (_, value) => { calls++; signal = value; return pending.promise; };
      const h = render(); h.ask(); const request = h.confirm(); h.rerender(replacement); expect(signal?.aborted).toBe(true); await request;
      h.rerender('first'); await settle(() => h.action().phase === 'unknown'); expect(h.action().disabled).toBe(true); h.ask(); expect(calls).toBe(1);
      pending.resolve({ cancelled: true }); await new Promise((resolve) => setTimeout(resolve, 10)); expect(h.action().phase).toBe('unknown');
    });
  }
  for (const confirmed of [false, true]) {
    test(`account A → B → A invalidates ${confirmed ? 'sent' : 'unsubmitted'} intent`, async () => {
      const pending = deferred<{ cancelled: boolean }>(); let calls = 0; let signal: AbortSignal | undefined;
      cancel = (_, value) => { calls++; signal = value; return pending.promise; };
      const h = render(); h.ask(); const old = h.action(); const request = confirmed ? h.confirm() : Promise.resolve();
      await tokenStore.setToken('cancel-account-b'); await tokenStore.setToken('cancel-account-a'); await old.confirm(); await request;
      if (confirmed) expect(signal?.aborted).toBe(true);
      pending.resolve({ cancelled: true }); await settle(() => h.action().phase === 'idle'); expect(calls).toBe(confirmed ? 1 : 0); expect(h.el.textContent).not.toContain('acknowledged');
    });
  }
  test('cleared or expired token cannot submit pending confirmation', async () => {
    let calls = 0; cancel = () => { calls++; return Promise.resolve({ cancelled: true }); };
    const h = render(); h.ask(); const old = h.action(); await tokenStore.clearToken(); await old.confirm(); expect(calls).toBe(0);
    await tokenStore.setTokenEntry('expired', Date.now() - 1); h.rerender('second'); h.ask(); await h.confirm(); expect(calls).toBe(0);
  });
  test('ambiguous failure needs explicit refresh and new confirmation; never replayed', async () => {
    let calls = 0; cancel = () => { calls++; return Promise.reject(new Error('connection lost after write')); };
    const h = render(); h.ask(); await h.confirm(); await settle(() => h.action().phase === 'unknown');
    expect(h.action().notice).toBe(CONTRACT_CANCEL_NOTICE.unknown); expect(h.action().needsRefresh).toBe(true); h.ask(); await h.confirm(); expect(calls).toBe(1);
    await h.action().refresh(); await settle(() => !h.action().needsRefresh); h.ask(); expect(calls).toBe(1); await h.confirm(); expect(calls).toBe(2);
  });
  test('account replacement rejects a late fleet response from cancellation refresh', async () => {
    const oldFleet = deferred<string>(); const h = render(); await settle(() => h.reads.fleet > 0);
    h.holdFleet(() => oldFleet.promise); h.ask(); const request = h.confirm();
    await settle(() => h.reads.fleet > 1);
    await tokenStore.setToken('cancel-account-b');
    oldFleet.resolve('private old account fleet'); await request;
    await settle(() => h.action().phase === 'idle');
    expect(h.client.getQueryData<string>(queryKeys.fleet)).not.toBe('private old account fleet');
    expect(h.el.textContent).not.toContain('acknowledged');
  });
  test('failed contract refresh does not release the lifetime guard while fleet is still pending', async () => {
    const oldFleet = deferred<string>(); const h = render(); await settle(() => h.reads.fleet > 0);
    h.holdFleet(() => oldFleet.promise); h.failReads(); h.ask(); const request = h.confirm();
    await settle(() => h.reads.fleet > 1 && h.reads.detail > 1);
    await tokenStore.setToken('cancel-account-b');
    oldFleet.resolve('private fleet after failed contract read'); await request;
    await settle(() => h.action().phase === 'idle');
    expect(h.client.getQueryData<string>(queryKeys.fleet)).not.toBe('private fleet after failed contract read');
  });
  test('failed fleet attempts do not release the guard while the fleet snapshot is pending', async () => {
    const oldFleet = deferred<string>(); const h = render(); await settle(() => h.reads.fleet > 0);
    h.holdFleet(() => oldFleet.promise); h.failAttempts(); h.ask(); const request = h.confirm();
    await settle(() => h.reads.fleet > 1 && h.reads.attempts > 1);
    await tokenStore.setToken('cancel-account-b');
    oldFleet.resolve('private snapshot after attempts failed'); await request;
    await settle(() => h.action().phase === 'idle');
    expect(h.client.getQueryData<string>(queryKeys.fleet)).not.toBe('private snapshot after attempts failed');
  });
  test('offline paused refetch cannot clear unknown outcome or authorize another mutation', async () => {
    let calls = 0; cancel = () => { calls++; return Promise.reject(new Error('response lost')); };
    const h = render(); await settle(() => h.reads.detail > 0); h.ask(); await h.confirm();
    onlineManager.setOnline(false); const before = { ...h.reads }; await h.action().refresh();
    expect(h.reads).toEqual(before); expect(h.action().needsRefresh).toBe(true);
    h.ask(); await h.confirm(); expect(calls).toBe(1);
    onlineManager.setOnline(true); await settle(() => h.reads.detail > before.detail);
    expect(h.action().needsRefresh).toBe(true);
    await h.action().refresh(); await settle(() => !h.action().needsRefresh);
    h.ask(); expect(h.action().phase).toBe('confirming'); expect(calls).toBe(1);
  });
  test('failed authoritative refresh keeps retry blocked', async () => {
    cancel = () => Promise.reject(new Error('timeout')); const h = render(); await settle(() => h.reads.detail > 0); h.ask(); await h.confirm(); h.failReads();
    await h.action().refresh(); await settle(() => !h.action().refreshing); expect(h.action().needsRefresh).toBe(true); h.ask(); expect(h.action().phase).toBe('unknown');
  });
  for (const cancelled of [false, true]) {
    test(`${cancelled}: authoritative list/detail/fleet refetch, no optimistic terminal state`, async () => {
      cancel = () => Promise.resolve({ cancelled }); const h = render(); await settle(() => h.reads.detail > 0); const before = { ...h.reads };
      h.ask(); await h.confirm(); await settle(() => h.action().phase === (cancelled ? 'acknowledged' : 'not-cancelled'));
      for (const key of ['list', 'detail', 'fleet'] as const) expect(h.reads[key]).toBeGreaterThan(before[key]);
      expect(h.client.getQueryData<string>(queryKeys.contractDetail(getClientLifetime().revision, 'first'))).toBe('running');
      expect(h.action().notice).toBe(CONTRACT_CANCEL_NOTICE[cancelled ? 'acknowledged' : 'not-cancelled']);
    });
  }
});
