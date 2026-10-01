/**
 * Containment tests for card material on the webui.
 *
 * The standard here is the one the TUI's payments-cvv-containment suite set: a
 * fake value is typed through REAL production code, and every payload this
 * surface can produce is then searched for it, the test fails if it is found.
 * Nothing is mocked except `globalThis.fetch`, which is the actual network
 * boundary; the component, the sdk client, the route table, the transport and
 * the query cache are all the real ones.
 *
 * The payloads searched are the browser's equivalents of the TUI's export file
 * and diagnostic dump, the places a value on this surface could actually
 * survive:
 *
 *   - the request URL (condition 2: never in a URL)
 *   - the rendered DOM (condition 3: never rendered back)
 *   - localStorage and sessionStorage (state that survives navigation)
 *   - the react-query cache, serialized (a store, and the specific reason this
 *     component does not use useMutation, a mutation cache retains its
 *     `variables`, which here would be the card)
 *   - the input elements' own values (condition 6: cleared after submit)
 *
 * Each fake value is deliberately not the component's own placeholder text, so
 * a match can only come from an actual echo of a typed field rather than a
 * coincidental hit on static guidance.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../../lib/toast';
import { PaymentCardEntry } from './PaymentCardEntry';

const FAKE_NUMBER = '4000056655665556';
const FAKE_EXPIRY = '09/29';
const FAKE_CVV = '731';
const FAKE_HOLDER = 'Jane Q. Fakename';
const FAKE_LABEL = 'errands card';

/** Every value typed in this suite, what each payload below is searched for. */
const TYPED_VALUES = [FAKE_NUMBER, FAKE_CVV, FAKE_HOLDER];

/**
 * A leaked digit value appears as its own digit run ("731", "\"731\""), never
 * embedded inside a longer one: epoch timestamps in dumps and temp paths
 * currently contain the substring 731 (epoch millis 1787318... do, for days
 * at a stretch), so a raw substring scan false-positives on time, not leaks.
 */
function containsTypedValue(haystack: string, value: string): boolean {
  if (/^\d+$/.test(value)) {
    return new RegExp(`(?<!\\d)${value}(?!\\d)`).test(haystack);
  }
  return haystack.includes(value);
}

/** The metadata the daemon answers a create with. Note what is absent: any card value. */
const CARD_METADATA = {
  id: 'card_fake_1',
  label: FAKE_LABEL,
  brand: 'Visa',
  last4: '5556',
  kind: 'virtual' as const,
  expiryMonth: 9,
  expiryYear: 2029,
  issuerCapMinorUnits: 20000,
  addedAt: '2026-07-27T00:00:00.000Z',
  materialComplete: true,
};

interface Captured {
  url: string;
  method: string;
  body: string | undefined;
}

const originalFetch = globalThis.fetch;
let calls: Captured[] = [];
let queryClient: QueryClient;

function stubDaemon(): void {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined });
    const payload = url.includes('/api/payments/cards') && (init?.method ?? 'GET') === 'POST'
      ? { card: CARD_METADATA }
      : { cards: [] };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function render(surface?: string): { container: HTMLElement; unmount: () => void } {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ToastProvider, null, React.createElement(PaymentCardEntry, { surface })),
      ),
    );
  });
  return {
    container,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

/** Type into a controlled React input the way a user does. */
function typeInto(container: HTMLElement, id: string, value: string): void {
  const input = container.querySelector(`#${id}`) as HTMLInputElement;
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fillCard(container: HTMLElement): void {
  typeInto(container, 'gv-card-label', FAKE_LABEL);
  typeInto(container, 'gv-card-number', FAKE_NUMBER);
  typeInto(container, 'gv-card-expiry', FAKE_EXPIRY);
  typeInto(container, 'gv-card-cvv', FAKE_CVV);
  typeInto(container, 'gv-card-holder', FAKE_HOLDER);
}

async function submitCard(container: HTMLElement): Promise<void> {
  const button = container.querySelector('[data-testid="payment-card-submit"]') as HTMLButtonElement;
  expect(button).not.toBeNull();
  button.click();
  // Let the create promise, the state reset and the cache invalidation settle.
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (!button.disabled) break;
  }
  flushSync(() => {});
}

function cardFieldValues(container: HTMLElement): string[] {
  return ['gv-card-number', 'gv-card-expiry', 'gv-card-cvv', 'gv-card-holder'].map(
    (id) => (container.querySelector(`#${id}`) as HTMLInputElement).value,
  );
}

function storageDump(): string {
  const dump: Record<string, string> = {};
  for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
    if (!store) continue;
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null) dump[key] = store.getItem(key) ?? '';
    }
  }
  return JSON.stringify(dump);
}

function queryCacheDump(): string {
  const cache = queryClient.getQueryCache().getAll().map((q) => ({ key: q.queryKey, state: q.state }));
  const mutations = queryClient.getMutationCache().getAll().map((m) => ({ state: m.state }));
  return JSON.stringify({ cache, mutations });
}

beforeEach(() => {
  stubDaemon();
  globalThis.localStorage?.clear();
  globalThis.sessionStorage?.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('a typed card reaches the daemon and nowhere else', () => {
  test('the card goes out over the authenticated daemon channel as a POST body, never in the URL', async () => {
    const { container, unmount } = render();
    fillCard(container);
    await submitCard(container);

    const create = calls.find((c) => c.method === 'POST' && c.url.includes('/api/payments/cards'));
    expect(create).toBeDefined();

    // Condition 1: it went to the daemon's own card endpoint, the same scoped
    // transport every other secret takes.
    expect(create!.url).toContain('/api/payments/cards');

    // Condition 2: not one card value appears anywhere in the URL, not as a
    // query parameter, not a fragment, not a path segment.
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(create!.url, value)).toBe(false);
    }
    expect(create!.url).not.toContain('?');
    expect(create!.url).not.toContain('#');

    // Functional correctness alongside containment: the values really did go,
    // in the body, in the shape the daemon's schema requires.
    const body = JSON.parse(create!.body ?? '{}') as Record<string, unknown>;
    expect(body.number).toBe(FAKE_NUMBER);
    expect(body.cvv).toBe(FAKE_CVV);
    expect(body.cardholderName).toBe(FAKE_HOLDER);
    expect(body.expiryMonth).toBe(9);
    expect(body.expiryYear).toBe(2029);

    unmount();
  });

  test('NO request URL made by this component carries a card value, including the list refetch', async () => {
    const { container, unmount } = render();
    fillCard(container);
    await submitCard(container);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      for (const value of TYPED_VALUES) {
        expect(containsTypedValue(call.url, value)).toBe(false);
      }
    }
    unmount();
  });

  test('after submit, no card value is left in the DOM', async () => {
    const { container, unmount } = render();
    fillCard(container);
    await submitCard(container);

    const html = document.body.innerHTML;
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(html, value)).toBe(false);
    }
    unmount();
  });

  test('after submit, every card input is cleared, condition 6, on the elements themselves', async () => {
    const { container, unmount } = render();
    fillCard(container);
    // Precondition: the values really were there, so the assertion below is
    // proving a clear rather than a field that never held anything.
    expect(cardFieldValues(container)).toEqual([FAKE_NUMBER, FAKE_EXPIRY, FAKE_CVV, FAKE_HOLDER]);

    await submitCard(container);

    expect(cardFieldValues(container)).toEqual(['', '', '', '']);
    unmount();
  });

  test('after submit, no card value is in localStorage or sessionStorage', async () => {
    const { container, unmount } = render();
    fillCard(container);
    await submitCard(container);

    const dump = storageDump();
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(dump, value)).toBe(false);
    }
    unmount();
  });

  test('after submit, no card value is in the react-query cache, including the mutation cache', async () => {
    const { container, unmount } = render();
    fillCard(container);
    await submitCard(container);

    const dump = queryCacheDump();
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(dump, value)).toBe(false);
    }
    unmount();
  });

  test('nothing card-shaped survives unmounting and remounting the panel', async () => {
    const first = render();
    fillCard(first.container);
    await submitCard(first.container);
    first.unmount();

    const second = render();
    expect(cardFieldValues(second.container)).toEqual(['', '', '', '']);
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(document.body.innerHTML, value)).toBe(false);
    }
    second.unmount();
  });
});

describe('the daemon never sends card material back', () => {
  test('the create response is metadata only, and the panel renders only that', async () => {
    const { container, unmount } = render();
    fillCard(container);
    await submitCard(container);

    // The stub answers with the real CARD_METADATA shape, which has no field
    // for a number, a security code or a cardholder name. If a read path ever
    // appeared, this shape is where it would show up first.
    expect(Object.keys(CARD_METADATA)).not.toContain('number');
    expect(Object.keys(CARD_METADATA)).not.toContain('cvv');
    expect(Object.keys(CARD_METADATA)).not.toContain('cardholderName');

    const html = document.body.innerHTML;
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(html, value)).toBe(false);
    }
    unmount();
  });

  test('a card the daemon already holds renders as last four only, and never repopulates a field', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: undefined });
      return new Response(JSON.stringify({ cards: [CARD_METADATA] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const { container, unmount } = render();
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (container.querySelector('[data-testid="payment-card-list"]')) break;
    }
    flushSync(() => {});

    const list = container.querySelector('[data-testid="payment-card-list"]');
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain('5556');

    // The stored card is listed, but not one input was filled from it.
    expect(cardFieldValues(container)).toEqual(['', '', '', '']);
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(document.body.innerHTML, value)).toBe(false);
    }
    unmount();
  });
});

describe('a failed store keeps the draft but still leaks nothing', () => {
  test('the error message carries no card value', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined });
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ error: { message: 'Storing the card failed. Nothing was saved.' } }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ cards: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const { container, unmount } = render();
    fillCard(container);
    await submitCard(container);

    const banner = container.querySelector('[data-testid="payment-card-error"]');
    expect(banner).not.toBeNull();
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(banner!.textContent ?? '', value)).toBe(false);
    }

    // The draft is intentionally kept on failure so a network blip does not
    // cost a retype, but it is still only in the inputs, nowhere else.
    const dump = storageDump() + queryCacheDump();
    for (const value of TYPED_VALUES) {
      expect(containsTypedValue(dump, value)).toBe(false);
    }
    unmount();
  });
});

describe('a surface the gate refuses is never even offered the fields', () => {
  test('no card input is rendered at all. A disabled field would still be an invitation to type', () => {
    const { container, unmount } = render('telegram');

    expect(container.querySelector('[data-testid="payment-card-entry-refused"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="payment-card-entry"]')).toBeNull();
    for (const id of ['gv-card-number', 'gv-card-expiry', 'gv-card-cvv', 'gv-card-holder']) {
      expect(container.querySelector(`#${id}`)).toBeNull();
    }
    expect(container.querySelector('[data-testid="payment-card-submit"]')).toBeNull();

    // And it says which surface it refused, in the SDK's own words.
    expect(container.textContent).toContain("can't take card details over telegram");
    unmount();
  });

  test('the refused panel makes no daemon call; it does not even list cards', async () => {
    const { unmount } = render('telegram');
    // render() committed inside flushSync, effects included, and an enabled query
    // starts fetching during that commit. The card list exists only as a disabled
    // query that has never fetched, nothing is in flight, and no request went out.
    expect(queryClient.isFetching()).toBe(0);
    for (const query of queryClient.getQueryCache().getAll()) {
      expect(query.state.fetchStatus).toBe('idle');
      expect(query.state.dataUpdateCount + query.state.errorUpdateCount).toBe(0);
    }
    expect(calls).toHaveLength(0);
    unmount();
  });
});
