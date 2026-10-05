/** Real captured HTTP bytes → real facade → real hooks → existing detail renderer. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CAPTURED_CONTRACTS, malformedCapturedRecords } from '../../../e2e/support/native-contract-records';
import { useContractList, useContractScope } from '../../hooks/useContracts';
import { tokenStore } from '../../lib/client-lifetime';
import { sdk } from '../../lib/goodvibes';
import { ContractDetail } from './ContractDetail';

const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
beforeEach(async () => { await tokenStore.setToken('captured-contract-test-account'); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
});

async function settle(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Captured contract inspection did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
    flushSync(() => {});
  }
}

function installWire(fixture: typeof CAPTURED_CONTRACTS[number]) {
  let getBody = fixture.getBody, listBody = fixture.listBody;
  const requests: { path: string; method: string; search: string }[] = [];
  // Only the network boundary is replaced. sdk.operator.contracts, its generated
  // routes, useContracts, runtime schema validation and ContractDetail are real.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    requests.push({ path: url.pathname, method, search: url.search });
    if (method !== 'GET') throw new Error(`Unexpected contract mutation: ${method} ${url.pathname}`);
    if (url.pathname !== '/api/contracts' && url.pathname !== `/api/contracts/${fixture.record.id}`) {
      throw new Error(`Unexpected request: ${url.pathname}`);
    }
    return new Response(url.pathname === '/api/contracts' ? listBody : getBody, { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    requests,
    malformed(value: unknown) { getBody = JSON.stringify(value); listBody = JSON.stringify({ contracts: [value] }); },
    restore() { getBody = fixture.getBody; listBody = fixture.listBody; },
  };
}

function renderDetail(id: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  let list: ReturnType<typeof useContractList>;
  function Harness() {
    const lifetime = useContractScope();
    list = useContractList(lifetime, true, true, false);
    return <>
      <div data-testid="captured-list">{list.isError ? 'List rejected' : list.data?.contracts.map((record) => record.id).join(',')}</div>
      <ContractDetail id={id} lifetime={lifetime} live={false} onClose={() => undefined} />
    </>;
  }
  flushSync(() => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
  cleanups.push(() => { flushSync(() => root.unmount()); client.clear(); el.remove(); });
  function click(name: string) {
    const button = Array.from(el.querySelectorAll('button')).find((candidate) => candidate.textContent === name);
    if (!button) throw new Error(`Missing detail button: ${name}`);
    flushSync(() => button.click());
  }
  return { el, click, list: () => list! };
}

function expectReadOnly(el: HTMLElement) {
  expect(Array.from(el.querySelectorAll('button')).map((button) => button.textContent)
    .filter((text) => /^(approve|reject|reply|resume|amend|revise|cancel|start)\b/i.test(text ?? ''))).toEqual([]);
  expect(el.querySelector('input,textarea,[contenteditable=true]')).toBeNull();
}

describe('genuine runner records across the WebUI inspection boundary', () => {
  for (const fixture of CAPTURED_CONTRACTS) {
    test(`${fixture.name}: complete facade response is preserved and detail remains readable`, async () => {
      const wire = installWire(fixture);
      const response = await sdk.operator.contracts.get(fixture.record.id);
      expect(response).toEqual(fixture.record);
      // Explicitly retain the parsed report, even though the product displays
      // its lastOutput/answer rather than a separate report-specific viewer.
      expect(response.units.map((unit) => unit.lastReport)).toEqual(fixture.record.units.map((unit) => unit.lastReport));
      const h = renderDetail(fixture.record.id);
      await settle(() => h.list().isSuccess && Boolean(h.el.querySelector('.contract-tree')));
      expect(h.list().data).toEqual(JSON.parse(fixture.listBody));
      expect(h.el.querySelector('[data-testid="captured-list"]')?.textContent).toBe(fixture.record.id);
      const text = h.el.textContent ?? '';
      expect(text).toContain(fixture.record.ask);
      expect(text).toContain(fixture.record.goal);
      for (const criterion of fixture.record.criteria) expect(text).toContain(criterion.text);
      for (const unit of fixture.record.units) {
        expect(text).toContain(unit.title);
        if (unit.lastOutput) expect(text).toContain(unit.lastOutput);
      }
      if (fixture.record.answer) expect(text).toContain(fixture.record.answer);
      if (fixture.record.inputSnapshot) {
        expect(text).toContain('Captured input provenance');
        expect(text).toContain(fixture.record.inputSnapshot.id);
        expect(text).toContain(fixture.record.inputSnapshot.sourceRoot);
        for (const file of fixture.record.inputSnapshot.files) {
          expect(text).toContain(file.path);
          if (file.digest) expect(text).toContain(file.digest);
        }
      }
      if (fixture.record.nativeSource) {
        const goal = Array.from(h.el.querySelectorAll('section')).find((section) => section.querySelector('h4')?.textContent === 'Original native goal');
        expect(goal?.querySelector('p')?.textContent).toBe(fixture.record.nativeSource.goal);
        for (const criterion of fixture.record.nativeSource.criteria) expect(text).toContain(criterion);
      }
      if (fixture.record.durableAdmission) {
        expect(text).toContain('Durable admission provenance');
        expect(text).toContain(fixture.record.durableAdmission.payloadRevision);
        expect(text).toContain('launch-claimed');
        expect(text).toContain('A persisted launch claim does not establish whether execution began.');
      }
      for (const entry of fixture.record.nativeDecisions?.history ?? []) {
        expect(text).toContain(`Recorded outcome: ${entry.decision.outcome}`);
        expect(text).toContain(entry.decision.decisionId);
        expect(text).toContain(entry.operationRevision);
        expect(text).toContain(entry.decision.binding.actionRevision);
        for (const id of entry.decision.judgmentDecisionIds) expect(text).toContain(id);
        if (entry.decision.outcome === 'defer') {
          expect(text).toContain('Recorded resume condition');
          expect(text).toContain(entry.decision.until.id);
        }
      }
      if (fixture.record.nativeWaiting) {
        expect(text).toContain('Transport waiting');
        expect(text).toContain('It does not record a semantic outcome.');
        for (const request of fixture.record.nativeWaiting.requests) {
          expect(text).toContain(request.logicalRequestId);
          expect(text).toContain(String(request.nextDelayMs));
          expect(text).toContain(request.attempt.outcome);
          expect(text).toContain(String(request.attempt.status));
        }
        expect(text).toContain('deciding');
        expect(text).not.toContain('Recorded outcome: defer');
        expect(text).not.toContain('Recorded resume condition');
      }
      expectReadOnly(h.el);
      expect(wire.requests.every((request) => request.method === 'GET')).toBe(true);
      expect(wire.requests.some((request) => request.path === '/api/contracts' && new URLSearchParams(request.search).get('includeTerminal') === 'true')).toBe(true);
    });

    test(`${fixture.name}: malformed refresh rejects strictly, hides cached evidence and recovers original bytes`, async () => {
      const wire = installWire(fixture);
      const h = renderDetail(fixture.record.id);
      await settle(() => h.list().isSuccess && Boolean(h.el.querySelector('.contract-tree')));
      for (const malformed of malformedCapturedRecords(fixture.record)) {
        wire.malformed(malformed.value);
        h.click('Refresh contract');
        await h.list().refetch();
        await settle(() => h.list().isError && Boolean(h.el.querySelector('[role="alert"]')));
        expect(h.el.querySelector('[role="alert"]')?.textContent, malformed.name).toContain('unreadable contract record');
        expect(h.el.querySelector('.contract-tree'), malformed.name).toBeNull();
        expect(h.list().error?.message, malformed.name).toContain('unreadable contract record');
        wire.restore();
        h.click('Retry contract');
        await h.list().refetch();
        await settle(() => h.list().isSuccess && Boolean(h.el.querySelector('.contract-tree')));
        expect(h.el.querySelector('[role="alert"]')).toBeNull();
        expect(h.list().data).toEqual(JSON.parse(fixture.listBody));
      }
      expectReadOnly(h.el);
      expect(wire.requests.every((request) => request.method === 'GET')).toBe(true);
    });
  }
});
