/** Real browser facade and HTTP Response decoding, without replacing the composer or SDK. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import { getClientLifetime, tokenStore, RELAY_PAIRING_STORAGE_KEY } from '../../lib/client-lifetime';
import { queryKeys } from '../../lib/queries';
import { SteerComposer } from './SteerComposer';

type Receipt = OperatorMethodOutput<'sessions.inputs.list'>['inputs'][number];
interface WireRequest { path: string; method: string; body: unknown; auth: string | null; signal: AbortSignal | null | undefined }
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
beforeEach(async () => { await tokenStore.setToken('synthetic-receipt-account-a'); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = originalFetch;
  localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
  await tokenStore.clearToken();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle(predicate: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Input receipts did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
  }
}
function receipt(id = 'input-1', state: Receipt['state'] = 'queued', sessionId = 's-a', updatedAt = 100): Receipt {
  return { id, sessionId, intent: 'follow-up', state, body: id, correlationId: id, createdAt: 1, updatedAt, metadata: {} };
}
function accepted(input: Receipt, mode = 'queued-for-surface') {
  return Response.json({ session: null, message: null, mode, input, agentId: null }, { status: 202 });
}
function render(initial: { sessionId?: string; canSteer?: boolean; closed?: boolean; streamPaused?: boolean } = {}) {
  const requests: WireRequest[] = [];
  let values: Receipt[] = [];
  let post: (request: WireRequest) => Response | Promise<Response> = () => accepted(receipt());
  let get: (request: WireRequest) => Response | Promise<Response> = () => Response.json({ session: null, inputs: values });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = { path: new URL(String(url)).pathname, method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined,
      auth: new Headers(init?.headers).get('authorization'), signal: init?.signal };
    requests.push(request);
    return request.method === 'GET' ? get(request) : post(request);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: 3 } } });
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  let props = { sessionId: 's-a', canSteer: false, closed: false, streamPaused: false, ...initial };
  const rerender = (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    flushSync(() => root.render(<QueryClientProvider client={client}><SteerComposer {...props} /></QueryClientProvider>));
  };
  rerender();
  let mounted = true;
  const unmount = () => { if (mounted) { flushSync(() => root.unmount()); mounted = false; } client.clear(); el.remove(); };
  cleanups.push(unmount);
  function type(text: string) {
    const input = el.querySelector('textarea')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  }
  function submit(text = 'Follow up on this') {
    type(text);
    flushSync(() => el.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  }
  const rows = () => [...el.querySelectorAll('.steer-dispatch')];
  const state = (index = 0) => rows()[index]?.querySelector('.steer-dispatch__state')?.textContent;
  return { el, client, requests, rerender, unmount, submit, type, rows, state,
    post: (fn: typeof post) => { post = fn; }, get: (fn: typeof get) => { get = fn; },
    inputs: (next: Receipt[]) => { values = next; },
    refresh: () => client.invalidateQueries({ queryKey: queryKeys.sessions }),
  };
}

describe('SteerComposer input receipts', () => {
  for (const [mode, state] of [['queued-for-surface', 'queued'], ['queued-follow-up', 'queued'], ['continued-live', 'delivered'], ['spawn', 'spawned']] as const) {
    test(`HTTP 202 ${mode} renders ${state} from input.state`, async () => {
      const h = render(); h.post(() => accepted(receipt('own', state), mode));
      h.submit(); await settle(() => h.state() === `follow-up · ${state}`);
      expect(h.requests[0]).toMatchObject({ method: 'POST', path: '/api/sessions/s-a/follow-up', body: { body: 'Follow up on this' }, auth: 'Bearer synthetic-receipt-account-a' });
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    });
  }
  test('submission stays sending until its receipt arrives', async () => {
    const h = render(); const pending = deferred<Response>(); h.post(() => pending.promise);
    h.submit(); await settle(() => h.requests.length === 1);
    expect(h.state()).toBe('follow-up · sending');
    expect(h.el.querySelector('textarea')?.value).toBe('');
    pending.resolve(accepted(receipt())); await settle(() => h.state() === 'follow-up · queued');
  });
  test('event invalidation reconciles only matching IDs through delivery and completion', async () => {
    const h = render(); h.submit(); await settle(() => h.state() === 'follow-up · queued');
    h.inputs([receipt('unrelated', 'completed', 's-a', 200)]); await h.refresh();
    expect(h.state()).toBe('follow-up · queued');
    await settle(() => h.el.textContent?.includes('missing from the latest input list') ?? false);
    h.inputs([receipt('input-1', 'delivered', 's-a', 200)]); await h.refresh();
    await settle(() => h.state() === 'follow-up · delivered');
    h.inputs([receipt('input-1', 'completed', 's-a', 300)]); await h.refresh();
    await settle(() => h.state() === 'follow-up · completed');
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  for (const state of ['cancelled', 'failed', 'rejected'] as const) {
    test(`authoritative ${state} and its error replace queued without resending`, async () => {
      const h = render(); h.submit(); await settle(() => h.state() === 'follow-up · queued');
      h.inputs([{ ...receipt('input-1', state, 's-a', 200), error: 'Surface stopped' }]); await h.refresh();
      await settle(() => h.state() === `follow-up · ${state}`);
      expect(h.el.textContent).toContain('Surface stopped');
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    });
  }
  test('overlapping identical sends retain separate IDs, modes, and out-of-order responses', async () => {
    const h = render(); const first = deferred<Response>(), second = deferred<Response>();
    h.post(request => request.path.endsWith('/steer') ? second.promise : first.promise);
    h.submit('same text'); await settle(() => h.requests.length === 1);
    h.rerender({ canSteer: true }); h.submit('same text'); await settle(() => h.requests.length === 2);
    second.resolve(accepted(receipt('second', 'delivered'), 'continued-live'));
    await settle(() => h.state() === 'steer · delivered');
    expect(h.state(1)).toBe('follow-up · sending');
    first.resolve(accepted(receipt('first'))); await settle(() => h.state(1) === 'follow-up · queued');
    h.inputs([receipt('first', 'cancelled', 's-a', 300), receipt('second', 'completed', 's-a', 300)]); await h.refresh();
    await settle(() => h.state() === 'steer · completed' && h.state(1) === 'follow-up · cancelled');
    expect(h.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['/api/sessions/s-a/follow-up', '/api/sessions/s-a/steer']);
  });
  test('an older list and equal-timestamp queued snapshots never regress delivered receipts', async () => {
    const h = render(); h.post(() => accepted(receipt('input-1', 'delivered', 's-a', 200)));
    h.inputs([receipt('input-1', 'queued', 's-a', 100)]); h.submit();
    await settle(() => h.requests.some(request => request.method === 'GET'));
    expect(h.state()).toBe('follow-up · delivered');
    h.inputs([receipt('input-1', 'queued', 's-a', 200)]); await h.refresh();
    expect(h.state()).toBe('follow-up · delivered');
  });
  test('the list can correct a manufactured spawned POST when an older input was claimed', async () => {
    const h = render(); h.post(() => accepted(receipt('new', 'spawned'), 'spawn'));
    h.inputs([receipt('old', 'spawned'), receipt('new', 'queued')]); h.submit();
    await settle(() => h.requests.some(request => request.method === 'GET'));
    await settle(() => h.state() === 'follow-up · queued');
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
  test('unreadable receipts and wrong-session IDs never claim delivery', async () => {
    for (const value of [{}, { input: receipt('wrong', 'delivered', 's-other') }, { input: { ...receipt(), state: 'made-up' } }]) {
      const h = render(); h.post(() => Response.json(value, { status: 202 })); h.submit();
      await settle(() => h.state() === 'follow-up · unknown');
      expect(h.el.textContent).toContain('Check the transcript before sending again');
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1); h.unmount();
    }
  });
  test('an HTTP rejection with an input receipt retains the authoritative rejected state', async () => {
    const h = render(); h.post(() => Response.json({ input: { ...receipt('rejected', 'rejected'), error: 'No active agent accepted the steer request.' }, mode: 'rejected' }, { status: 409 }));
    h.submit(); await settle(() => h.state() === 'follow-up · rejected');
    expect(h.el.textContent).toContain('No active agent accepted the steer request.');
  });
  test('a lost response, 503 or capacity 429 is unknown, never an automatic retry', async () => {
    for (const mode of ['disconnect', 'server-error', 'capacity']) {
      const h = render(); h.post(() => { if (mode === 'disconnect') throw new TypeError('Connection lost'); return Response.json({ error: 'Unavailable', code: mode === 'capacity' ? 'CAPACITY_EXCEEDED' : 'UNAVAILABLE' }, { status: mode === 'capacity' ? 429 : 503 }); });
      h.submit(); await settle(() => h.state() === 'follow-up · unknown');
      expect(h.el.textContent).toContain('will not be retried automatically');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1); h.unmount();
    }
  });
  test('a failed list keeps the last confirmed receipt and recovers on reconnect invalidation', async () => {
    const h = render(); h.submit(); await settle(() => h.state() === 'follow-up · queued');
    h.get(() => Response.json({ error: 'Offline' }, { status: 503 })); await h.refresh();
    await settle(() => h.el.textContent?.includes('could not be refreshed') ?? false);
    expect(h.state()).toBe('follow-up · queued');
    h.get(() => Response.json({ inputs: [receipt('input-1', 'completed', 's-a', 300)] })); await h.refresh();
    await settle(() => h.state() === 'follow-up · completed');
    expect(h.el.textContent).not.toContain('could not be refreshed');
  });
  test('paused-stream fallback polling updates queued without resending', async () => {
    const h = render({ streamPaused: true }); h.submit(); await settle(() => h.state() === 'follow-up · queued');
    await settle(() => h.requests.some(request => request.method === 'GET'));
    h.inputs([receipt('input-1', 'completed', 's-a', 300)]);
    await settle(() => h.state() === 'follow-up · completed', 8000);
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  }, 10_000);
  test('a hung input read times out honestly and a later refresh recovers without another POST', async () => {
    const realTimeout = globalThis.setTimeout;
    let deadline: (() => void) | undefined;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 15_000 && typeof callback === 'function') deadline = () => callback(...args);
      return realTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      const h = render(); h.get(request => new Promise<Response>((_resolve, reject) => {
        request.signal!.addEventListener('abort', () => reject(new DOMException('Read timed out', 'AbortError')), { once: true });
      }));
      h.submit(); await settle(() => h.requests.some(request => request.method === 'GET'));
      expect(deadline).toBeDefined(); deadline!();
      await settle(() => h.el.textContent?.includes('could not be refreshed') ?? false);
      expect(h.state()).toBe('follow-up · queued');
      h.get(() => Response.json({ inputs: [receipt('input-1', 'completed', 's-a', 300)] })); await h.refresh();
      await settle(() => h.state() === 'follow-up · completed');
      expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    } finally { timer.mockRestore(); }
  });
  test('a never-confirmed send times out to unknown and ignores its late reply', async () => {
    const realTimeout = globalThis.setTimeout;
    let deadline: (() => void) | undefined;
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 30_000 && typeof callback === 'function') deadline = () => callback(...args);
      return realTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    try {
      const h = render(); const pending = deferred<Response>(); h.post(() => pending.promise);
      h.submit(); await settle(() => h.requests.length === 1);
      expect(deadline).toBeDefined(); flushSync(() => deadline!());
      expect(h.state()).toBe('follow-up · unknown'); expect(h.requests[0].signal?.aborted).toBe(true);
      pending.resolve(accepted(receipt('late', 'completed'))); await new Promise(resolve => setTimeout(resolve, 30));
      expect(h.state()).toBe('follow-up · unknown'); expect(h.requests).toHaveLength(1);
    } finally { timer.mockRestore(); }
  });
  test('session A → B → A drops text and aborts late writes without contaminating the new selection', async () => {
    const h = render(); const pending = deferred<Response>(); h.post(() => pending.promise);
    h.submit('old session text'); await settle(() => h.requests.length === 1);
    h.type('unsent draft'); h.rerender({ sessionId: 's-b' }); h.rerender({ sessionId: 's-a' });
    expect(h.requests[0].signal?.aborted).toBe(true);
    expect(h.rows()).toHaveLength(0); expect(h.el.querySelector('textarea')?.value).toBe('');
    pending.resolve(accepted(receipt('old', 'completed'))); await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.rows()).toHaveLength(0); expect(h.requests).toHaveLength(1);
  });
  for (const change of ['account', 'relay', 'sign-out', 'unmount'] as const) {
    test(`${change} retires pending POST, local text, and old receipts`, async () => {
      const h = render(); const pending = deferred<Response>(); h.post(() => pending.promise);
      h.submit('private old text'); await settle(() => h.requests.length === 1);
      if (change === 'account') { await tokenStore.setToken('synthetic-receipt-account-b'); await tokenStore.setToken('synthetic-receipt-account-a'); }
      if (change === 'relay') { localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, 'changed relay identity'); getClientLifetime(); }
      if (change === 'sign-out') await tokenStore.clearToken();
      if (change === 'unmount') h.unmount();
      else await settle(() => h.rows().length === 0);
      expect(h.requests[0].signal?.aborted).toBe(true);
      pending.resolve(accepted(receipt('old', 'completed'))); await new Promise(resolve => setTimeout(resolve, 30));
      expect(h.el.textContent).not.toContain('private old text'); expect(h.rows()).toHaveLength(0);
      expect(h.client.getMutationCache().getAll()).toHaveLength(0);
      expect(h.requests).toHaveLength(1);
    });
  }
  test('late list responses cannot populate cache or render after account replacement', async () => {
    const h = render(); const pending = deferred<Response>(); h.get(() => pending.promise);
    const oldRevision = getClientLifetime().revision;
    h.submit(); await settle(() => h.requests.some(request => request.method === 'GET'));
    const read = h.requests.find(request => request.method === 'GET')!;
    await tokenStore.setToken('synthetic-receipt-account-b'); await settle(() => h.rows().length === 0);
    expect(read.signal?.aborted).toBe(true);
    pending.resolve(Response.json({ inputs: [receipt('input-1', 'completed', 's-a', 300)] }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.client.getQueryData(queryKeys.sessionInputs(oldRevision, 's-a'))).toBeUndefined();
    expect(h.rows()).toHaveLength(0);
  });
  test('closed composer cannot submit and IME/Shift+Enter do not dispatch', async () => {
    const h = render(); h.type('composition');
    for (const options of [{ isComposing: true }, { shiftKey: true }]) {
      flushSync(() => h.el.querySelector('textarea')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })));
    }
    await new Promise(resolve => setTimeout(resolve, 10)); expect(h.requests).toHaveLength(0);
    h.rerender({ closed: true }); h.submit('closed message'); await new Promise(resolve => setTimeout(resolve, 10));
    expect(h.requests).toHaveLength(0);
    h.rerender({ closed: false }); h.submit('reopened message'); await settle(() => h.state() === 'follow-up · queued');
    expect(h.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });
});
