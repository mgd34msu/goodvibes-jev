import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ContractRecord, ContractsListResult } from '../lib/contract-bridge-types';
import { getClientLifetime, tokenStore, WEBUI_TOKEN_STORE_KEY } from '../lib/client-lifetime';

let contractEvent: (() => void) | undefined;
let listRead: (input: { includeTerminal?: boolean }, signal?: AbortSignal) => Promise<ContractsListResult> = () => Promise.resolve({ contracts: [] });
let detailRead: (id: string, signal?: AbortSignal) => Promise<ContractRecord> = () => Promise.reject(new Error('not configured'));
mock.module('../lib/goodvibes', () => ({
  DEFAULT_SSE_RECONNECT: { enabled: true },
  getCurrentAuth: () => Promise.resolve({}),
  invokeMethod: () => Promise.resolve({}),
  hasStoredTokenSync: () => Boolean(localStorage.getItem(WEBUI_TOKEN_STORE_KEY)),
  sdk: { streams: { open: (_path: string, handlers: { onEvent?: (name: string, payload: unknown) => void }) => { contractEvent = () => handlers.onEvent?.('contracts', {}); return Promise.resolve(() => {}); } }, operator: { contracts: {
    list: (input: { includeTerminal?: boolean }, signal?: AbortSignal) => listRead(input, signal),
    get: (id: string, signal?: AbortSignal) => detailRead(id, signal),
  } } },
}));
const { readInContractScope, useContractScope, useContractList, useContractDetail } = await import('./useContracts');
const { queryKeys } = await import('../lib/queries');
const { useRealtimeInvalidation } = await import('./useRealtimeInvalidation');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function settle(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Contract query did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
  }
}
const cleanups: (() => void)[] = [];
beforeEach(async () => { await tokenStore.setToken('synthetic-contract-account-a'); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await tokenStore.clearToken();
  listRead = () => Promise.resolve({ contracts: [] });
  detailRead = () => Promise.reject(new Error('not configured'));
});
function render(initialId = '', includeTerminal = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  let list: ReturnType<typeof useContractList>;
  let detail: ReturnType<typeof useContractDetail>;
  function Harness({ id, terminal }: { id: string; terminal: boolean }) {
    const scope = useContractScope();
    useRealtimeInvalidation(true);
    list = useContractList(scope, terminal, true, true);
    detail = useContractDetail(scope, id, true);
    return <div>{list.data?.contracts.map((c) => c.id).join(',')}|{detail.data?.id ?? 'no detail'}</div>;
  }
  const rerender = (id: string, terminal = includeTerminal) => flushSync(() => root.render(<QueryClientProvider client={client}><Harness id={id} terminal={terminal} /></QueryClientProvider>));
  rerender(initialId);
  cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
  return { client, el, rerender, list: () => list!, detail: () => detail! };
}
function record(id: string): ContractRecord {
  return {
    id, schemaVersion: 1, sessionId: 'test-session', origin: 'external', ask: id,
    ownerAgentId: 'test-owner', projectRoot: '/fixture', isolation: 'shared', goal: id,
    criteria: [], groups: [], units: [], status: 'running', checks: [], fixRounds: 0,
    escalations: [], decisions: [], plannerAgentIds: [], createdAt: 1_790_000_000_000,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      llmCallCount: 0, turnCount: 0, toolCallCount: 0, costUsd: null, costState: 'unpriced' },
    judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
}

describe('contract query lifetimes', () => {
  test('includeTerminal changes fetch a distinct snapshot', async () => {
    const inputs: boolean[] = [];
    listRead = (input) => { inputs.push(Boolean(input.includeTerminal)); return Promise.resolve({ contracts: [record(input.includeTerminal ? 'ended' : 'active')] }); };
    const h = render(); await settle(() => h.list().isSuccess);
    expect(h.el.textContent).toContain('active');
    h.rerender('', true); await settle(() => h.el.textContent?.includes('ended') ?? false);
    expect(inputs).toEqual([false, true]);
  });
  test('rapid selection aborts old read and ignores its late answer', async () => {
    const old = deferred<ContractRecord>(), next = deferred<ContractRecord>();
    const signals: AbortSignal[] = [];
    detailRead = (id, signal) => { signals.push(signal!); return id === 'old' ? old.promise : next.promise; };
    const h = render('old'); await settle(() => signals.length === 1);
    h.rerender('next'); await settle(() => signals.length === 2);
    expect(signals[0].aborted).toBe(true);
    next.resolve(record('next')); await settle(() => h.detail().data?.id === 'next');
    old.resolve(record('old')); await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.el.textContent).toContain('next'); expect(h.el.textContent).not.toContain('old');
  });
  test('closing cancels the detail and late answer cannot reopen it', async () => {
    const pending = deferred<ContractRecord>(); let signal: AbortSignal | undefined;
    detailRead = (_, s) => { signal = s; return pending.promise; };
    const h = render('closing'); await settle(() => Boolean(signal)); h.rerender('');
    expect(signal!.aborted).toBe(true); pending.resolve(record('closing'));
    await new Promise((resolve) => setTimeout(resolve, 20)); expect(h.el.textContent).toContain('no detail');
  });
  test('account A to B to A removes old cache and rejects late response', async () => {
    const pending = deferred<ContractsListResult>(); let oldSignal: AbortSignal | undefined; let calls = 0;
    listRead = (_, signal) => { calls++; if (calls === 1) { oldSignal = signal; return pending.promise; } return Promise.resolve({ contracts: [record('new account')] }); };
    const h = render(); await settle(() => Boolean(oldSignal)); const oldRevision = getClientLifetime().revision;
    await tokenStore.setToken('synthetic-contract-account-b'); await tokenStore.setToken('synthetic-contract-account-a');
    await settle(() => h.list().data?.contracts[0]?.id === 'new account'); expect(oldSignal!.aborted).toBe(true);
    pending.resolve({ contracts: [record('secret old response')] }); await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.el.textContent).not.toContain('secret');
    expect(h.client.getQueryData(queryKeys.contractList(oldRevision, false))).toBeUndefined();
  });
  test('sign-out clears visible data/cache without a new read', async () => {
    let calls = 0; listRead = () => { calls++; return Promise.resolve({ contracts: [record('private contract')] }); };
    const h = render(); await settle(() => h.list().isSuccess); const revision = getClientLifetime().revision;
    await tokenStore.clearToken(); await settle(() => !h.el.textContent?.includes('private contract'));
    expect(calls).toBe(1); expect(h.client.getQueryData(queryKeys.contractList(revision, false))).toBeUndefined();
  });
  test('contract prefix refetches both list and open detail', async () => {
    let listCalls = 0, detailCalls = 0;
    listRead = () => { listCalls++; return Promise.resolve({ contracts: [] }); };
    detailRead = () => { detailCalls++; return Promise.resolve(record('open')); };
    const h = render('open'); await settle(() => h.list().isSuccess && h.detail().isSuccess);
    await h.client.invalidateQueries({ queryKey: queryKeys.contracts }); expect(listCalls).toBe(2); expect(detailCalls).toBe(2);
  });
  test('a contract event supersedes in-flight initial list and detail snapshots', async () => {
    const oldList = deferred<ContractsListResult>(), oldDetail = deferred<ContractRecord>();
    let lists = 0, details = 0;
    listRead = () => ++lists === 1 ? oldList.promise : Promise.resolve({ contracts: [record('after event')] });
    detailRead = () => ++details === 1 ? oldDetail.promise : Promise.resolve({ ...record('selected'), goal: 'after event' });
    const h = render('selected');
    await settle(() => lists === 1 && details === 1 && Boolean(contractEvent));
    contractEvent?.();
    await settle(() => h.list().isSuccess && h.detail().isSuccess);
    expect(lists).toBe(2); expect(details).toBe(2);
    oldList.resolve({ contracts: [record('before event')] }); oldDetail.resolve({ ...record('selected'), goal: 'before event' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.list().data?.contracts[0]?.id).toBe('after event');
    expect(h.detail().data?.goal).toBe('after event');
  });
  test('malformed nested records reject list and detail before render', async () => {
    const malformed = [
      { ...record('broken'), groups: [null] },
      { ...record('broken'), groups: [{ id: 'g1' }] },
      { ...record('broken'), criteria: [{ id: 'criterion', text: 'No readings container' }] },
      { ...record('broken'), checks: [{ id: 'check', quality: null }] },
    ];
    for (const value of malformed) {
      const invalid = value as unknown as ContractRecord;
      listRead = () => Promise.resolve({ contracts: [invalid] });
      detailRead = () => Promise.resolve(invalid);
      const h = render('broken');
      await settle(() => h.list().isError && h.detail().isError);
      expect(h.list().error?.message).toContain('unreadable contract');
      expect(h.detail().error?.message).toContain('unreadable contract');
      expect(h.el.textContent).not.toContain('broken');
      cleanups.pop()?.();
    }
  });
  test('an unmodeled list and a valid but different detail id are errors', async () => {
    listRead = () => Promise.resolve({} as ContractsListResult);
    detailRead = () => Promise.resolve(record('different'));
    const h = render('selected');
    await settle(() => h.list().isError && h.detail().isError);
    expect(h.list().error?.message).toContain('unreadable contract list');
    expect(h.detail().error?.message).toContain('different contract');
  });
  test('expired identity rejects adoption even before an expiry timer runs', async () => {
    const pending = deferred<string>(), lifetime = getClientLifetime();
    const result = readInContractScope(lifetime, new AbortController().signal, () => pending.promise);
    localStorage.setItem(`${WEBUI_TOKEN_STORE_KEY}.expiresAt`, String(Date.now() - 1)); pending.resolve('private result'); await expect(result).rejects.toThrow();
  });
});
