/** Real SDK fetch/SSE facade and SessionDetail, replaying engine-owned HTTP captures. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { tokenStore } from '../../lib/client-lifetime';
import { unionSessionsFromListResponse } from '../../lib/sessions-union';
import { ToastProvider } from '../../lib/toast';
import { useRealtimeInvalidation } from '../../hooks/useRealtimeInvalidation';
import { SessionDetail } from './SessionDetail';
import { loadSessionContextCapture, type ContextScenario } from '../../../e2e/support/session-context-fixture';

const capture = loadSessionContextCapture();
const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
beforeEach(async () => { await tokenStore.setToken('synthetic-context-proof'); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
});
async function settle(check: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out\n${document.body.textContent ?? ''}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    flushSync(() => {});
  }
}
const record = (id: string) => unionSessionsFromListResponse({ sessions: [{ id, title: id, kind: 'tui', status: 'active',
  createdAt: 1, updatedAt: 1, messageCount: 0, surfaceKinds: [] }] })[0]!;

function harness(holdFirst = false) {
  let scenario: ContextScenario = 'provider_api';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  const streams: { domains: string[]; controller: ReadableStreamDefaultController<Uint8Array> }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = url.pathname;
    requests.push(path);
    if (path === '/api/control-plane/events') {
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        streams.push({ domains: url.searchParams.get('domains')?.split(',') ?? [], controller });
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (path.endsWith('/context-usage')) {
      const wire = path === capture.scenarios.hosted_refusal.path ? capture.scenarios.hosted_refusal : capture.scenarios[scenario];
      if (holdFirst) { holdFirst = false; await held; }
      return new Response(wire.body, { status: wire.status, headers: { 'content-type': 'application/json' } });
    }
    if (path.endsWith('/permission-mode')) return Response.json({ mode: 'normal' });
    if (path.endsWith('/sessions.delete')) return Response.json({ method: { id: 'sessions.delete', invokable: true } });
    if (path.includes('/cost/') || path.includes('cost.attribution')) return Response.json({ rows: [] });
    if (path.endsWith('/messages')) return Response.json({ messages: [] });
    throw new Error(`Unhandled context proof route: ${path}`);
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  function Harness({ id }: { id: string }) {
    useRealtimeInvalidation(true);
    return <SessionDetail key={id} record={record(id)} agents={[]} tab="transcript" onTabChange={() => undefined}
      streamPaused={false} onOpenItem={() => undefined} onClose={() => undefined} />;
  }
  function render(id = capture.sessionId) {
    flushSync(() => root.render(<QueryClientProvider client={client}><ToastProvider><Harness id={id} /></ToastProvider></QueryClientProvider>));
  }
  cleanups.push(() => {
    release(); flushSync(() => root.unmount()); client.clear(); el.remove();
    for (const stream of streams) { try { stream.controller.close(); } catch { /* aborted stream */ } }
  });
  const context = () => [...el.querySelectorAll('.dv-facts__row')].find(row => row.querySelector('dt')?.textContent === 'Context')?.querySelector('dd')?.textContent ?? '';
  return {
    render, release, context, requests,
    setScenario(next: ContextScenario) { scenario = next; },
    ready(domain: string) { return streams.some(stream => stream.domains.includes(domain)); },
    emit(domain: string, payload: unknown) {
      for (const stream of streams.filter(item => item.domains.includes(domain))) {
        stream.controller.enqueue(new TextEncoder().encode(`event: ${domain}\ndata: ${JSON.stringify(payload)}\n\n`));
      }
    },
  };
}

test('captured known→unknown→configured usage flows through real SDK SSE invalidation and compaction refresh', async () => {
  const h = harness(); h.render();
  await settle(() => h.context().includes('~40%') && h.ready('providers') && h.ready('compaction'));
  h.setScenario('accepted_floor');
  h.emit('providers', { type: 'MODEL_CHANGED', provider: 'synthetic', registryKey: 'synthetic:unknown' });
  await settle(() => h.context().includes('context window unknown'));
  expect(h.context()).toContain('provider accepted at least 24,000 tokens (lower bound, not capacity)');
  expect(h.context()).not.toContain('%');
  h.setScenario('configured_cap');
  h.emit('compaction', { type: 'COMPACTION_CHECK', sessionId: capture.sessionId, tokenCount: 999999, threshold: 1000000 });
  await settle(() => h.context().includes('~50%'));
  expect(h.context()).toContain('source: configured cap · user override');
  expect(h.context()).not.toContain('999,999');
  expect(h.context()).not.toContain('lower bound');
  expect(h.requests.filter(path => path.endsWith('/context-usage'))).toHaveLength(3);
});

test('provider event supersedes an initial buffered known-window response through the real SDK', async () => {
  const h = harness(true); h.render();
  await settle(() => h.ready('providers') && h.requests.some(path => path.endsWith('/context-usage')));
  h.setScenario('no_model');
  h.emit('providers', { type: 'MODEL_CHANGED', provider: 'synthetic', registryKey: 'synthetic:unknown' });
  await settle(() => h.context().includes('context window unknown'));
  h.release();
  await new Promise(resolve => setTimeout(resolve, 25)); flushSync(() => {});
  expect(h.context()).toBe('40,000 tokens estimated; context window unknown');
  expect(h.requests.filter(path => path.endsWith('/context-usage'))).toHaveLength(2);
});

test('switching from a real local usage capture to hosted refusal cannot retain another scope capacity', async () => {
  const h = harness(); h.render();
  await settle(() => h.context().includes('~40%'));
  h.render(capture.hostedSessionId);
  await settle(() => h.context() === 'Unavailable here');
  expect(h.context()).not.toContain('100,000');
});
