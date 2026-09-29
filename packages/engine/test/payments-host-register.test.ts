/**
 * The `payments.*` handlers, over a real GatewayMethodCatalog and real stores.
 *
 * The catalog here is the SDK's own, constructed empty, so every descriptor
 * these handlers attach to is the shipped one. Nothing below authors a
 * descriptor, which is the property `registerCatalogHandler` exists to keep.
 *
 * What this layer tests that the live-route file cannot easily reach: the
 * settings the verbs report are read at the moment of the call, path parameters
 * and query strings are read the same way a body is, and the projection into
 * each response is an allowlist rather than a spread.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import type { BrowserCheckoutSeam } from '../sdk/src/platform/control-plane/routes/browser-composition.js';
import { BudgetLedger } from '../sdk/src/platform/payments/budget.js';
import { CardMaterialRedactor } from '../sdk/src/platform/payments/card-redaction.js';
import { MemoryCheckoutJournal } from '../sdk/src/platform/payments/checkout-registry.js';
import type { AddressStore } from '../sdk/src/platform/payments/address.js';
import type { CheckoutPageDriver } from '../sdk/src/platform/payments/checkout-page.js';
import type { MerchantJudgePort } from '../sdk/src/platform/payments/merchant-recourse.js';
import type { PaymentNotifier } from '../sdk/src/platform/payments/payment-ports.js';
import type { PaymentsConfigReader } from '../sdk/src/platform/payments/payments-config.js';
import type { PurchaseRecord } from '../sdk/src/platform/payments/purchase-record.js';
import { getProcessUntrustedContentLedger } from '../sdk/src/platform/security/untrusted-content.js';
import { DaemonApprovalStore } from '../sdk/src/platform/payments/host/approval-store.js';
import { DaemonCardStore, type PaymentsSecretStore } from '../sdk/src/platform/payments/host/card-store.js';
import { DaemonPurchaseLedger } from '../sdk/src/platform/payments/host/purchase-ledger.js';
import {
  ATTACHED_PAYMENTS_METHOD_IDS,
  UNATTACHED_PAYMENTS_METHOD_IDS,
  registerPaymentsMethods,
  type CheckoutComposition,
} from '../sdk/src/platform/payments/host/register.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { usePaymentsReadings } from './helpers/payments-readings.ts';

// The begin flow's link validation asks the judgment port about the checkout url's host; a fake port answers the plain cases these tests use.
usePaymentsReadings();

/**
 * A `CheckoutPageDriver` that satisfies the shape and does nothing.
 *
 * Never actually exercised by the not-owner-direct/no-seam refusal tests
 * below: `checkPaymentGates` refuses (missing card, missing address, or not
 * owner-direct) before `runCheckout` calls any of these, and `driverFor`
 * itself is invoked unconditionally near the top of `beginCheckout`, so it has
 * to exist and not throw, nothing more.
 */
const stubDriver: CheckoutPageDriver = {
  identity: () => ({ sessionId: 'stub-session', pageId: 'stub-page' }),
  url: async () => 'https://example.invalid/checkout',
  fill: async () => {},
  fillSecrets: async () => ({ filledTargets: [], failedTarget: null }),
  choose: async () => {},
  submitOrder: async () => ({ url: 'https://example.invalid/checkout', orderId: null, challenge: null, verified: false }),
};

const noAddresses: AddressStore = { read: async () => null };
const noopNotifier: PaymentNotifier = { deliver: async () => [], awaitAnswer: async () => null };
const unqualifiedMerchantJudge: MerchantJudgePort = {
  judge: async () => ({ qualifies: false, confident: false, recourse: 'test double' }),
};

/** A fresh, persisted approval store on its own temp file, as the real composition builds one. */
function freshApprovals(now?: () => Date): DaemonApprovalStore {
  const path = join(makeProjectTempDir('gv-payments-approvals'), 'payments-approvals.json');
  return now ? new DaemonApprovalStore(path, now) : new DaemonApprovalStore(path);
}

/** A `CheckoutComposition` whose seam is absent by default; tests that need one call `withSeam`. */
function fakeCheckout(overrides: Partial<CheckoutComposition> = {}): CheckoutComposition {
  return {
    seam: () => undefined,
    addresses: noAddresses,
    notifier: noopNotifier,
    merchantJudge: unqualifiedMerchantJudge,
    untrusted: getProcessUntrustedContentLedger(),
    approvals: freshApprovals(),
    journal: new MemoryCheckoutJournal(),
    ...overrides,
  };
}

/**
 * A working seam.
 *
 * `armSubmitApproval` is part of the sdk's `BrowserCheckoutSeam` shape and has
 * to exist to satisfy it, but nothing in this daemon calls it any more (see
 * checkout-handlers.ts's header on `checkoutBeginHandler`: the mechanism it
 * used to arm was deleted, it never actually cleared anything), so this is a
 * plain no-op rather than something tests observe calls on.
 */
function fakeSeam(): BrowserCheckoutSeam {
  return {
    cardFieldGuard: new CardMaterialRedactor(),
    driverFor: () => stubDriver,
    armSubmitApproval: async () => {},
  };
}

function memorySecrets(): PaymentsSecretStore {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function purchase(overrides: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    purchaseId: 'pur-1',
    atUtc: '2026-08-19T10:00:00.000Z',
    dayKey: '2026-08-19',
    timezone: 'UTC',
    merchantDomain: 'example.invalid',
    item: 'a replacement kettle' as PurchaseRecord['item'],
    currency: 'USD' as PurchaseRecord['currency'],
    itemMinorUnits: 4599,
    taxMinorUnits: 380,
    feesMinorUnits: 0,
    shippingMinorUnits: 599,
    totalMinorUnits: 5578,
    shippingTierRequested: 'normal',
    shippingTierUsed: 'normal',
    steppedDown: false,
    itemPoolDraw: 4599,
    overagePoolDraw: 979,
    tolerancePoolDraw: 0,
    cardLast4: '1111',
    windowKind: 'veto',
    windowOutcome: 'proceeded',
    answeredBy: null,
    outcome: 'purchased',
    refusalReason: null,
    merchantOrderId: 'ORD-9',
    refundedAt: null,
    merchantRecognised: true,
    merchantQualifier: 'major-retailer',
    merchantDiscovered: false,
    ...overrides,
  };
}

let catalog: GatewayMethodCatalog;
let cardsPath = '';
let cards: DaemonCardStore;
let purchases: DaemonPurchaseLedger;
let budget: BudgetLedger;
let settings: Map<string, unknown>;
let leader = true;
let unregister: () => void;

const config: PaymentsConfigReader = { get: (key: string) => settings.get(key) };

async function invoke(id: string, invocation: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return await catalog.invoke(id, {
    context: { principalId: 'test-operator' },
    ...invocation,
  } as never) as Record<string, unknown>;
}

async function refusalOf(id: string, invocation: Record<string, unknown>): Promise<{ code: string; status: number; message: string }> {
  try {
    await invoke(id, invocation);
    return { code: '', status: 0, message: '' };
  } catch (error) {
    const record = error as { code?: unknown; status?: unknown; message?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : '',
      status: typeof record.status === 'number' ? record.status : 0,
      message: typeof record.message === 'string' ? record.message : '',
    };
  }
}

beforeEach(async () => {
  const dir = makeProjectTempDir('gv-payments-register');
  catalog = new GatewayMethodCatalog();
  cardsPath = join(dir, 'payments-cards.json');
  cards = new DaemonCardStore({
    filePath: cardsPath,
    secrets: memorySecrets(),
    cvvHandling: () => 'stored',
  });
  purchases = new DaemonPurchaseLedger({ filePath: join(dir, 'payments-purchases.json') });
  budget = new BudgetLedger();
  settings = new Map<string, unknown>();
  leader = true;
  const registration = registerPaymentsMethods(catalog, {
    cards,
    purchases,
    budget,
    config,
    isPaymentsLeader: () => leader,
    checkout: fakeCheckout(),
  });
  await registration.ready;
  unregister = registration.unregister;
});

describe('registerPaymentsMethods: what it attaches', () => {
  test('every verb in the family gains a handler; UNATTACHED_PAYMENTS_METHOD_IDS is empty', () => {
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) {
      expect(catalog.hasHandler(id), `${id} was not attached`).toBe(true);
    }
    for (const { id } of UNATTACHED_PAYMENTS_METHOD_IDS) {
      expect(catalog.hasHandler(id), `${id} was attached and should not be`).toBe(false);
    }
  });

  test('teardown detaches every handler it attached', () => {
    unregister();
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) {
      expect(catalog.hasHandler(id), `${id} survived teardown`).toBe(false);
    }
  });

  test('the descriptors are the SDK\'s own, untouched', () => {
    const descriptor = catalog.get('payments.cards.create');
    expect(descriptor).toBeTruthy();
    expect(descriptor!.access).toBe('admin');
    expect(descriptor!.scopes).toContain('write:payments');
    expect(descriptor!.http).toEqual({ method: 'POST', path: '/api/payments/cards' });
  });

  test('a second registration on the same catalog, after teardown, attaches cleanly', async () => {
    // The defect this pins: `registerCatalogHandlers`' own teardown removes
    // FOUR of the seven descriptors (`cards.create`, `purchases.list`,
    // `checkout.begin`, `checkout.fillCard`) from the catalog entirely, not
    // merely their handler. Without restoring all seven, handler-less, in
    // `registerPaymentsMethods`' own teardown, a second registration on this
    // SAME catalog (a recompose without a fresh catalog, the daemon's own
    // restart-without-recreating-the-catalog shape) would find those four ids
    // gone and reject `ready` with `Unknown gateway method` trying to attach
    // to them.
    unregister();
    const registration = registerPaymentsMethods(catalog, {
      cards, purchases, budget, config, isPaymentsLeader: () => leader,
      checkout: fakeCheckout(),
    });
    await registration.ready;
    unregister = registration.unregister;
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) {
      expect(catalog.hasHandler(id), `${id} was not attached the second time`).toBe(true);
    }
  });

  test('teardown before ready settles leaves no handler attached once it does', async () => {
    // The race the torn flag closes: the SDK's own attach lands inside its
    // promise and cannot be cancelled, so a teardown that runs before `ready`
    // settles must have the chain restore the descriptors handler-less AFTER
    // the SDK's attach, or the catalog is left serving payment verbs nobody
    // holds a teardown for.
    unregister();
    const second = registerPaymentsMethods(catalog, {
      cards, purchases, budget, config, isPaymentsLeader: () => leader,
      checkout: fakeCheckout(),
    });
    second.unregister();
    await second.ready;
    for (const id of ATTACHED_PAYMENTS_METHOD_IDS) {
      expect(catalog.hasHandler(id), `${id} survived a pre-ready teardown`).toBe(false);
    }
    // beforeEach's unregister already ran; hand it a no-op so afterEach-style
    // double calls stay harmless.
    unregister = () => {};
  });
});

describe('payments.checkout.begin: what actually gates entry', () => {
  /** Fields `parseBeginCheckoutInput` requires; passes shape validation regardless of what happens after. */
  function validBeginBody(): Record<string, unknown> {
    return {
      sessionId: 'session-1',
      pageId: 'page-1',
      merchantDomain: 'example.invalid',
      checkoutUrl: 'https://example.invalid/checkout',
      item: 'a test item',
      cardId: 'card-that-does-not-exist',
      requestedLines: [{ label: 'a test item', quantity: 1 }],
      lines: [{ label: 'a test item', quantity: '1', unitPrice: '1.00' }],
      shippingOptions: [{ label: 'standard', cost: '0.00' }],
      cardFields: [{ field: 'number', ref: 'e1' }],
      placeOrderTarget: 'e9',
    };
  }

  /** Re-registers over a fresh catalog with a working (but otherwise inert) seam. */
  async function registerWithSeam(overrides: Partial<CheckoutComposition> = {}): Promise<void> {
    const seam = fakeSeam();
    catalog = new GatewayMethodCatalog();
    const registration = registerPaymentsMethods(catalog, {
      cards, purchases, budget, config, isPaymentsLeader: () => leader,
      checkout: fakeCheckout({ seam: () => seam, ...overrides }),
    });
    await registration.ready;
    unregister = registration.unregister;
  }

  /** Mints one approval over the verb itself, for the purchase `validBeginBody` names. */
  async function approvePurchase(amount = '20.00'): Promise<void> {
    await invoke('payments.checkout.approve', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { confirm: true, merchantDomain: 'example.invalid', item: 'a test item', amount },
    });
  }

  test('refuses when the call is not owner-direct', async () => {
    settings.set('payments.enabled', true);
    await registerWithSeam();

    const result = await invoke('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: false } },
      body: validBeginBody(),
    });

    // checkPaymentGates' own honest refusal, not a distinct error this wrapper
    // invents: the SAME outcome any other gate refusal produces. There is no
    // separate approval mechanism here any more to assert did-not-fire on:
    // `context.explicitUserRequest` reaching `isOwnerDirectRequest`, below, is
    // the whole gate. See checkout-handlers.ts's header on
    // `checkoutBeginHandler` for the ruling this pins.
    expect(result['outcome']).toBe('refused:not-owner-request');
    expect(String(result['reason'])).toContain('not asked for by you directly');
  });

  test('refuses on the NEXT gate, not this one, once explicit user authority and an approval are granted', async () => {
    settings.set('payments.enabled', true);
    await registerWithSeam();
    await approvePurchase();

    const result = await invoke('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { ...validBeginBody(), requestedMax: '20.00' },
    });

    // Owner-direct with a matching approval now, and still refused: no card
    // and no address are configured on this fixture, so `checkPaymentGates`
    // refuses on `no-card` (or, if the fixture ever gains a default card
    // first, `no-shipping-address`), the honest next gate, never the
    // owner-direct or approval one.
    expect(String(result['outcome'])).toStartWith('refused:');
    expect(result['outcome']).not.toBe('refused:not-owner-request');
  });

  test('refuses honestly, before dispatching, when no browser seam is composed', async () => {
    // The default beforeEach registration: fakeCheckout()'s seam getter
    // returns undefined, the "no browser composed" case.
    const refusal = await refusalOf('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: validBeginBody(),
    });
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe('FAILED_PRECONDITION');
    expect(refusal.message).toContain('not available');
  });

  test('an owner-direct begin with no approval on file refuses, naming the approve verb', async () => {
    settings.set('payments.enabled', true);
    await registerWithSeam();

    const refusal = await refusalOf('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { ...validBeginBody(), requestedMax: '20.00' },
    });
    expect(refusal.status).toBe(403);
    expect(refusal.code).toBe('OWNER_APPROVAL_REQUIRED');
    expect(refusal.message).toContain('payments.checkout.approve');
  });

  test('the approval is single use: the begin that spent it succeeds past the gate, the next one refuses', async () => {
    settings.set('payments.enabled', true);
    await registerWithSeam();
    await approvePurchase();

    // First begin: past the approval gate, refused on the honest next gate
    // (no card on this fixture), never on the approval.
    const first = await invoke('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { ...validBeginBody(), requestedMax: '20.00' },
    });
    expect(String(first['outcome'])).toStartWith('refused:');
    expect(first['outcome']).not.toBe('refused:not-owner-request');

    // Second, identical begin: the record was taken (removed when returned,
    // approval-store.ts), so this one has nothing to spend.
    const second = await refusalOf('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { ...validBeginBody(), requestedMax: '20.00' },
    });
    expect(second.status).toBe(403);
    expect(second.code).toBe('OWNER_APPROVAL_REQUIRED');
    expect(second.message).toContain('payments.checkout.approve');
  });

  test('a begin whose content differs from what was approved refuses and leaves the approval unspent', async () => {
    settings.set('payments.enabled', true);
    await registerWithSeam();
    await approvePurchase('20.00');

    // Same merchant and item, different amount: `different-content`, and the
    // record stays on file, since `take` only removes what it returns.
    const mismatched = await refusalOf('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { ...validBeginBody(), requestedMax: '999.99' },
    });
    expect(mismatched.status).toBe(403);
    expect(mismatched.code).toBe('OWNER_APPROVAL_REQUIRED');
    expect(mismatched.message).toContain('different purchase');

    // The matching begin still finds it, proving the mismatch spent nothing.
    const matching = await invoke('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { ...validBeginBody(), requestedMax: '20.00' },
    });
    expect(String(matching['outcome'])).toStartWith('refused:');
    expect(matching['outcome']).not.toBe('refused:not-owner-request');
  });

  test('an expired approval refuses and says so', async () => {
    settings.set('payments.enabled', true);
    let nowMs = Date.parse('2026-08-21T12:00:00.000Z');
    await registerWithSeam({ approvals: freshApprovals(() => new Date(nowMs)) });
    await approvePurchase();

    // Six minutes later: past the five-minute TTL the store enforces.
    nowMs += 6 * 60 * 1000;
    const refusal = await refusalOf('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { ...validBeginBody(), requestedMax: '20.00' },
    });
    expect(refusal.status).toBe(403);
    expect(refusal.code).toBe('OWNER_APPROVAL_REQUIRED');
    expect(refusal.message).toContain('expired');
  });

  test('a call that never claimed owner authority is refused by the OUTER gate, not the approval one', async () => {
    settings.set('payments.enabled', true);
    await registerWithSeam();

    // No approval on file AND not owner-direct: the outer layer answers, the
    // approval store is never consulted, so the refusal is the flow's own
    // `not-owner-request`, exactly as before the record existed.
    const result = await invoke('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: false } },
      body: { ...validBeginBody(), requestedMax: '20.00' },
    });
    expect(result['outcome']).toBe('refused:not-owner-request');
  });
});

describe('payments.checkout.approve: the distinct act that authorizes one begin', () => {
  test('refuses without the confirmation gate, so page text cannot mint one', async () => {
    // No confirm field: the gate refuses before the handler runs, whatever
    // the context claims.
    const unconfirmed = await refusalOf('payments.checkout.approve', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { merchantDomain: 'example.invalid', item: 'a test item', amount: '20.00' },
    });
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.code).toBe('REQUIRE_CONFIRM');

    // confirm: true but no explicit-user-request context: still refused. The
    // model can set a body field; the context flag is the caller surface's.
    const automated = await refusalOf('payments.checkout.approve', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: false } },
      body: { confirm: true, merchantDomain: 'example.invalid', item: 'a test item', amount: '20.00' },
    });
    expect(automated.status).toBe(403);
    expect(automated.code).toBe('REQUIRE_CONFIRM');
  });

  test('names each missing field with a 400 rather than storing a partial approval', async () => {
    const refusal = await refusalOf('payments.checkout.approve', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { confirm: true, merchantDomain: 'example.invalid', item: 'a test item' },
    });
    expect(refusal.status).toBe(400);
    expect(refusal.message).toContain('amount');
  });

  test('answers with the approved fields and an expiry, never a spread', async () => {
    const result = await invoke('payments.checkout.approve', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: { confirm: true, merchantDomain: 'example.invalid', item: 'a test item', amount: '20.00' },
    });
    expect(result).toEqual({
      approved: true,
      action: 'payments.checkout.begin',
      merchantDomain: 'example.invalid',
      item: 'a test item',
      amount: '20.00',
      expiresAt: result['expiresAt'],
    });
    expect(Date.parse(String(result['expiresAt']))).toBeGreaterThan(Date.now());
  });
});

describe('the checkout registry is shared across begin and fillCard, not rebuilt per call', () => {
  /**
   * The defect this pins: `checkoutBeginHandler`/`checkoutFillCardHandler`
   * used to build a fresh `PaymentsGatewayServiceImpl`, and therefore a fresh,
   * empty `CheckoutRegistry`, on EVERY call. A `fillCard` call could then never
   * find a checkout a prior `begin` opened (always "no purchase decision is in
   * flight", real or not), and two concurrent `begin` calls on the same page
   * never collided (each got its own empty registry), silently bypassing the
   * registry's one-checkout-per-page guarantee. Both tests below need a `begin`
   * call to reach `CheckoutRegistry.open()` (checkout-flow.ts, after GATES,
   * TAINT, LINK, RECOURSE, EXTRACT, CART, DECIDE, RESERVE) and STAY there,
   * without racing a real clock or a real notification channel, so
   * `hangingNotifier` below never answers: the flow parks at the
   * 'awaiting-window' phase (registry.advance, right after `open`) for as long
   * as either test needs it to, and neither test ever awaits the `begin`
   * call's own promise to completion.
   */
  function stubDriverFor(sessionId: string, pageId: string): CheckoutPageDriver {
    return {
      identity: () => ({ sessionId, pageId }),
      url: async () => 'https://example.invalid/checkout',
      fill: async () => {},
      fillSecrets: async () => ({ filledTargets: [], failedTarget: null }),
      choose: async () => {},
      submitOrder: async () => ({ url: 'https://example.invalid/checkout', orderId: null, challenge: null, verified: false }),
    };
  }

  /**
   * Never answers. Parks a `begin` call at 'awaiting-window' indefinitely, so
   * the registry stays open for the test to inspect.
   *
   * `deliver` must report at least one delivered channel: `advanceApproval`/
   * `advanceVeto` (windows.ts) read an all-undelivered dispatch as
   * "undeliverable" and settle the window immediately, DENIED, without ever
   * calling `awaitAnswer` at all, which would make the checkout refuse and
   * close before either test below gets a chance to observe it in flight.
   */
  function hangingNotifier(): PaymentNotifier {
    return {
      deliver: async () => [{ channel: 'tui', delivered: true, backfillable: false }],
      awaitAnswer: () => new Promise<null>(() => { /* never resolves */ }),
    };
  }

  const SHIPPING_ADDRESS = {
    name: 'Test Owner', line1: '1 Test Street', line2: '', city: 'Testville',
    region: 'TS', postalCode: '00000', country: 'US',
  };

  function addressStoreWithShipping(): AddressStore {
    return { read: async (kind) => (kind === 'shipping' ? SHIPPING_ADDRESS : null) };
  }

  function checkoutBeginBody(cardId: string): Record<string, unknown> {
    return {
      sessionId: 'session-shared',
      pageId: 'page-shared',
      merchantDomain: 'example.invalid',
      checkoutUrl: 'https://example.invalid/checkout',
      item: 'a test item',
      cardId,
      requestedLines: [{ label: 'a test item', quantity: 1 }],
      lines: [{ label: 'a test item', quantity: '1', unitPrice: '1.00' }],
      shippingOptions: [{ label: 'standard', cost: '0.00' }],
      cardFields: [{ field: 'number', ref: 'e1' }],
      placeOrderTarget: 'e9',
      requestedMax: '20.00',
    };
  }

  /** A macrotask tick: drains every pending microtask first, which is enough for a fired-but-unawaited begin() to reach and park at 'awaiting-window'. */
  function nextTick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  let sharedCardId = '';

  beforeEach(async () => {
    settings.set('payments.enabled', true);
    settings.set('payments.budget.dailyItem', 100);
    settings.set('payments.budget.perPurchaseCeilingEnabled', false);
    const card = await cards.create({
      label: 'shared-registry test card', kind: 'virtual', number: '4111111111111111',
      expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person', issuerCapMinorUnits: null,
    });
    sharedCardId = card.id;

    const seam: BrowserCheckoutSeam = { ...fakeSeam(), driverFor: () => stubDriverFor('session-shared', 'page-shared') };
    catalog = new GatewayMethodCatalog();
    const registration = registerPaymentsMethods(catalog, {
      cards, purchases, budget, config, isPaymentsLeader: () => leader,
      checkout: fakeCheckout({ seam: () => seam, addresses: addressStoreWithShipping(), notifier: hangingNotifier() }),
    });
    await registration.ready;
    unregister = registration.unregister;
    // Each begin call below spends one owner approval before it reaches the
    // registry (checkout-handlers.ts), so mint one per begin these tests fire.
    for (let count = 0; count < 2; count += 1) {
      await invoke('payments.checkout.approve', {
        context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
        body: { confirm: true, merchantDomain: 'example.invalid', item: 'a test item', amount: '20.00' },
      });
    }
  });

  test('a fillCard for the SAME page a begin opened finds it, refusing on phase rather than "no purchase in flight"', async () => {
    // Fired, not awaited: this call never settles (hangingNotifier), which is
    // what lets the test observe the registry while a checkout is genuinely
    // in flight rather than after it closed.
    void invoke('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: checkoutBeginBody(sharedCardId),
    });
    await nextTick();

    const refusal = await refusalOf('payments.checkout.fillCard', {
      body: { sessionId: 'session-shared', pageId: 'page-shared', targets: [{ field: 'number', ref: 'e1' }] },
    });
    // THE FIX: the record was found (never the old blanket "no purchase
    // decision is in flight", which every session and page got under a fresh
    // registry per call, real or not) and refused on the next thing that is
    // honestly true right now: the decision window has not settled, so the
    // purchase has not reached the payment stage.
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('INVALID_ARGUMENT');
    expect(refusal.message).not.toContain('no purchase decision is in flight');
    expect(refusal.message).toContain('stage');
  });

  test('a second begin for the same session and page while one is in flight refuses, rather than starting a second purchase', async () => {
    void invoke('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: checkoutBeginBody(sharedCardId),
    });
    await nextTick();

    const refusal = await refusalOf('payments.checkout.begin', {
      context: { principalId: 'test-operator', metadata: { explicitUserRequest: true } },
      body: checkoutBeginBody(sharedCardId),
    });
    // `CheckoutRegistry.open`'s own duplicate guard, forwarded by
    // `checkoutBeginHandler`'s containment (see checkout-handlers.ts): never a
    // silent second purchase on the same page, which is what a fresh registry
    // per call let happen.
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe('FAILED_PRECONDITION');
    expect(refusal.message).toContain('already in flight');
  });
});

describe('payments.budget.status', () => {
  test('reports the settings as they are at the moment of the call', async () => {
    settings.set('payments.enabled', true);
    settings.set('payments.currency', 'GBP');
    settings.set('payments.budget.dailyItem', 40);
    settings.set('daemon.timezone', 'Europe/London');
    const first = await invoke('payments.budget.status');
    expect(first['enabled']).toBe(true);
    expect(first['currency']).toBe('GBP');
    expect(first['timezone']).toBe('Europe/London');
    expect(first['item']).toEqual({ limit: 4000, spent: 0, reserved: 0, remaining: 4000 });

    // Raised between two calls; the second must see it. That is the whole reason
    // the config is a function and not a captured object.
    settings.set('payments.budget.dailyItem', 90);
    const second = await invoke('payments.budget.status');
    expect(second['item']).toEqual({ limit: 9000, spent: 0, reserved: 0, remaining: 9000 });
  });

  test('an unconfigured daemon reports disabled with zero pools, not a default budget', async () => {
    const result = await invoke('payments.budget.status');
    expect(result['enabled']).toBe(false);
    expect(result['currency']).toBe('USD');
    expect(result['timezone']).toBe('UTC');
    expect(result['item']).toEqual({ limit: 0, spent: 0, reserved: 0, remaining: 0 });
    expect(result['tolerance']).toEqual({ limit: 0, spent: 0, reserved: 0, remaining: 0 });
  });

  test('leadership is reported from the injected answer, never assumed', async () => {
    leader = false;
    expect((await invoke('payments.budget.status'))['isPaymentsLeader']).toBe(false);
    leader = true;
    expect((await invoke('payments.budget.status'))['isPaymentsLeader']).toBe(true);
  });

  test('reservationCount counts only reservations that have not expired', async () => {
    settings.set('payments.budget.dailyItem', 100);
    settings.set('payments.budget.perPurchaseCeilingEnabled', false);
    const reserved = budget.reserve({
      id: 'pur-live',
      itemMinorUnits: 100,
      overageMinorUnits: 0,
      toleranceMinorUnits: 0,
      limits: { dailyItemMinorUnits: 10000, dailyOverageMinorUnits: 0, perPurchaseCeiling: { enabled: false, minorUnits: 0 }, overageTolerance: { enabled: false, dailyAllowanceMinorUnits: 0 } },
      nowMs: Date.now(),
      timezone: 'UTC',
    });
    expect(reserved).not.toBeNull();
    expect((await invoke('payments.budget.status'))['reservationCount']).toBe(1);
    budget.release(reserved!.id);
    expect((await invoke('payments.budget.status'))['reservationCount']).toBe(0);
  });
});

describe('payments.cards.*', () => {
  test('the list reports the configured default card id', async () => {
    settings.set('payments.defaultCardId', 'card-preferred');
    const result = await invoke('payments.cards.list');
    expect(result['cards']).toEqual([]);
    expect(result['defaultCardId']).toBe('card-preferred');
  });

  test('a created card is projected through an allowlist, with nothing else on it', async () => {
    const created = await invoke('payments.cards.create', {
      body: {
        label: 'one', kind: 'virtual', number: '4111111111111111',
        expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person',
        issuerCapMinorUnits: 5000,
      },
    });
    const card = created['card'] as Record<string, unknown>;
    expect(Object.keys(card).sort()).toEqual([
      'addedAt', 'brand', 'expiryMonth', 'expiryYear', 'id', 'issuerCapMinorUnits',
      'kind', 'label', 'last4', 'materialComplete',
    ]);
  });

  test.each([
    [{ kind: 'debit' }, 'kind'],
    [{ label: '' }, 'label'],
    [{ number: '4111' }, 'number'],
    [{ expiryMonth: 13 }, 'expiryMonth'],
    [{ expiryMonth: 7.5 }, 'expiryMonth'],
    [{ expiryYear: 29 }, 'expiryYear'],
    [{ cvv: '12' }, 'cvv'],
    [{ cvv: 'abcd' }, 'cvv'],
    [{ cardholderName: '   ' }, 'cardholderName'],
  ])('a bad %o is refused by naming %s and nothing else', async (override, field) => {
    const refusal = await refusalOf('payments.cards.create', {
      body: {
        label: 'one', kind: 'virtual', number: '4111111111111111',
        expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person',
        ...override,
      },
    });
    expect(refusal.code).toBe('INVALID_ARGUMENT');
    expect(refusal.status).toBe(400);
    expect(refusal.message).toContain(field);
    // The submitted card is never part of the diagnostic.
    expect(refusal.message).not.toContain('4111111111111111');
    expect(refusal.message).not.toContain('907');
  });

  test('a non-integer issuer cap is stored as null rather than coerced', async () => {
    const created = await invoke('payments.cards.create', {
      body: {
        label: 'one', kind: 'real', number: '4111111111111111',
        expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person',
        issuerCapMinorUnits: 'lots',
      },
    });
    expect((created['card'] as Record<string, unknown>)['issuerCapMinorUnits']).toBeNull();
  });

  test('delete reads the id from the REST path parameter, not only from a body', async () => {
    const created = await invoke('payments.cards.create', {
      body: {
        label: 'one', kind: 'virtual', number: '4111111111111111',
        expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person',
      },
    });
    const id = String((created['card'] as Record<string, unknown>)['id']);
    // What the REST route supplies: the path parameter, folded into the query.
    const removed = await invoke('payments.cards.delete', { query: { id } });
    expect(removed).toEqual({ id, deleted: true, secretsCleared: 5 });
  });

  test('delete with no id refuses by naming the field', async () => {
    const refusal = await refusalOf('payments.cards.delete', { body: {} });
    expect(refusal.code).toBe('INVALID_ARGUMENT');
    expect(refusal.message).toContain('id');
  });
});

describe('a store failure never hands a caller the store internals', () => {
  /**
   * Rebuild the surface over a card store whose secret tier always fails.
   *
   * A fresh catalog rather than a re-registration: `registerCatalogHandlers`'
   * teardown removes the DESCRIPTOR, not just the handler slot, so the second
   * registration would answer METHOD_NOT_FOUND.
   */
  async function overFailingSecrets(): Promise<void> {
    catalog = new GatewayMethodCatalog();
    const failing: PaymentsSecretStore = {
      get: async () => {
        throw new Error('EACCES: permission denied, open /home/someone/.goodvibes/tui/secrets.enc');
      },
      set: async () => {
        throw new Error('EACCES: permission denied, open /home/someone/.goodvibes/tui/secrets.enc');
      },
      delete: async () => {
        throw new Error('EACCES: permission denied, open /home/someone/.goodvibes/tui/secrets.enc');
      },
    };
    cards = new DaemonCardStore({ filePath: cardsPath, secrets: failing, cvvHandling: () => 'stored' });
    const registration = registerPaymentsMethods(catalog, {
      cards, purchases, budget, config, isPaymentsLeader: () => leader, checkout: fakeCheckout(),
    });
    await registration.ready;
    unregister = registration.unregister;
  }

  test('cards.list replaces the secret-store message instead of forwarding it', async () => {
    // A row has to exist, or the list never reaches the secret store at all.
    await invoke('payments.cards.create', {
      body: {
        label: 'one', kind: 'virtual', number: '4111111111111111',
        expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person',
      },
    });
    await overFailingSecrets();
    const refusal = await refusalOf('payments.cards.list', {});
    expect(refusal.status).toBe(500);
    expect(refusal.code).toBe('INTERNAL_ERROR');
    // The path the secret store was working on is not a read:payments caller's business.
    expect(refusal.message).not.toContain('/home/someone');
    expect(refusal.message).not.toContain('secrets.enc');
    expect(refusal.message).toBe('Listing the stored cards failed.');
  });

  test('cards.delete replaces it too', async () => {
    await overFailingSecrets();
    const refusal = await refusalOf('payments.cards.delete', { body: { id: 'card-anything' } });
    expect(refusal.status).toBe(500);
    expect(refusal.message).not.toContain('secrets.enc');
    expect(refusal.message).toBe('Deleting the card failed.');
  });

  test('a damaged card file is forwarded verbatim, because the operator has to fix it', async () => {
    writeFileSync(cardsPath, '{"version":1,"cards":[{');
    for (const id of ['payments.cards.list', 'payments.cards.delete', 'payments.cards.create']) {
      const refusal = await refusalOf(id, {
        body: {
          id: 'card-anything',
          label: 'one', kind: 'virtual', number: '4111111111111111',
          expiryMonth: 7, expiryYear: 2029, cvv: '907', cardholderName: 'A Person',
        },
      });
      // 409, not 500: nothing is wrong with the request, the store is not in a
      // state that can serve it, and that distinction is what tells an operator
      // to go look at the file rather than to retry.
      expect(refusal.status, `${id} answered ${String(refusal.status)}`).toBe(409);
      expect(refusal.code).toBe('FAILED_PRECONDITION');
      expect(refusal.message).toContain(cardsPath);
      expect(refusal.message).toContain('Repair the file');
    }
  });
});

describe('payments.purchases.list', () => {
  test('a row is projected through an allowlist, so an extra stored field cannot escape', async () => {
    await purchases.record({ ...purchase(), secretNote: 'must not ship' } as PurchaseRecord);
    const result = await invoke('payments.purchases.list');
    const rows = result['purchases'] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!['secretNote']).toBeUndefined();
    expect(rows[0]!['merchantDiscovered']).toBe(false);
    expect(rows[0]!['cardLast4']).toBe('1111');
    expect(rows[0]!['totalMinorUnits']).toBe(5578);
  });

  test('limit and dayKey arrive as query strings on a GET and are read the same way', async () => {
    await purchases.record(purchase({ purchaseId: 'pur-a', dayKey: '2026-08-18' }));
    await purchases.record(purchase({ purchaseId: 'pur-b', dayKey: '2026-08-19' }));
    await purchases.record(purchase({ purchaseId: 'pur-c', dayKey: '2026-08-19' }));

    const filtered = await invoke('payments.purchases.list', { query: { dayKey: '2026-08-19' } });
    expect(filtered['total']).toBe(2);

    const limited = await invoke('payments.purchases.list', { query: { limit: '1' } });
    expect((limited['purchases'] as unknown[]).length).toBe(1);
    expect(limited['total']).toBe(3);
  });

  test('an unusable limit falls back to the default rather than refusing', async () => {
    await purchases.record(purchase());
    for (const limit of ['not-a-number', '0', '-4', ''] as const) {
      const result = await invoke('payments.purchases.list', { query: { limit } });
      expect((result['purchases'] as unknown[]).length).toBe(1);
    }
  });
});
