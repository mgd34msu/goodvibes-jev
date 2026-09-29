/**
 * register.ts, the `payments.*` handlers this daemon attaches.
 *
 * ── The SDK now owns most of these bodies ──────────────────────────────────
 *
 * `registerPaymentsGatewayMethods` (platform/control-plane, exported from the
 * barrel as of sdk 2.0.18) ships real handler bodies for all seven `payments.*`
 * verbs, built over a `PaymentsGatewayService` seam. `budgetStatus`, `listCards`
 * and `deleteCard` are answered from that seam directly below and attached
 * through the SDK's registrar; the local handler bodies that used to duplicate
 * them are gone.
 *
 * Two verbs stay LOCAL rather than going through the SDK's own route handlers
 * for it, and both are deliberate, not oversights:
 *
 *  - `payments.cards.create`: the SDK's `createPaymentsCardsCreateHandler`
 *    wraps the whole call to `service.createCard(...)` in one try/catch that
 *    replaces ANY thrown error, whatever its shape, with a fixed 500
 *    "Storing the card failed. Nothing was saved." This daemon's contract is
 *    narrower than the published input schema (a card number has to contain
 *    enough digits to be one, a CVV has to be three or four digits, an expiry
 *    month has to be 1-12, see the field readers below) and reports each of
 *    those with an honest 400 naming the field. Delegating create to the SDK
 *    handler would still validate the fields, but every refusal would answer
 *    500 instead of 400, a real wire-behaviour regression, not merely an
 *    implementation detail. So this verb keeps its own thin wrapper, which does
 *    the narrowing and then calls the same `service.createCard` the SDK
 *    handler would have, for the store write and the response shape.
 *  - `payments.purchases.list`: the SDK's `createPaymentsPurchasesListHandler`
 *    only accepts `limit` when it arrives already typed as a JS number. A GET
 *    request's query string never is, `?limit=5` arrives as the string `"5"`,
 *    so every caller of the real REST route would silently lose the ability to
 *    bound the page size and always get the handler's own default. This
 *    daemon's contract reads a numeric-looking string the same way it reads a
 *    number (`optionalCount` below), so this verb also keeps its own thin
 *    wrapper, which does that reading and then calls `service.listPurchases`.
 *
 * `payments.checkout.begin` and `payments.checkout.fillCard` are now attached
 * too, over the sdk 2.0.19 browser-checkout seam
 * (`platform/control-plane`'s `composeDaemonBrowser`/`onBrowserCheckout`/
 * `BrowserCheckoutSeam`). They do NOT go through
 * `registerPaymentsGatewayMethods`'s own route handlers, for the same reason
 * `payments.cards.create`/`payments.purchases.list` do not: those handlers
 * call `service.beginCheckout(input)`/`service.fillCardIntoCheckout(input)`
 * with no invocation context at all, and this composition's whole
 * "approving a purchase is a distinct act" ruling (see `registerPaymentsMethods`
 * below) needs `context.explicitUserRequest`, which only reaches a handler
 * attached through this daemon's own `registerCatalogHandlers`. So both verbs
 * are attached locally, alongside `cardsCreate`/`purchasesList`, reading and
 * shaping the SAME wire shapes `routes/payments.ts` does (ported here rather
 * than imported, since the SDK does not publish those parsing functions on
 * their own), and calling into the ONE `PaymentsGatewayServiceImpl` this
 * registration's checkout pair shares for its whole life (see
 * checkout-handlers.ts's `CheckoutServiceHolder` for why one, not one per
 * call: its own `CheckoutRegistry` is in-memory, per-instance state, and
 * `begin` and `fillCard` are separate control-plane calls that both need to
 * see it).
 *
 * `deps.checkout` (a `CheckoutComposition`, see below) is REQUIRED, not
 * optional: in the real daemon it is always supplied
 * (runtime/payments-composition.ts), and its own `seam()` getter is what may
 * legitimately be absent, either because this composition never builds a
 * browser at all (no `homeDirectory`, a narrow embed) or because
 * `onBrowserCheckout` has not fired yet (see
 * runtime/browser-checkout-seam-holder.ts for why that race is benign). Either
 * way `payments.checkout.begin`/`.fillCard` answer an honest refusal rather
 * than 501 NOT_INVOKABLE or a crash; see `checkoutBegin`/`checkoutFillCard`
 * below.
 *
 * ── Containment ───────────────────────────────────────────────────────────
 *
 * Every response below is BUILT from named fields rather than spread from a
 * store record, for the reason the SDK's own route module gives: an allowlist
 * silently drops a field a later change adds, a denylist silently ships it, and
 * for anything on a card's code path that is the correct direction to fail.
 * No handler here reads card material, and no failure path forwards a message
 * from a call that had material in its arguments.
 */
import type { BudgetLedger } from '../budget.js';
import { readDefaultCardId, readPaymentsEnabled, readPaymentsServiceConfig } from '../payments-config.js';
import type { PaymentsConfigReader } from '../payments-config.js';
import type { CardMetadata } from '../types.js';
import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import type { GatewayMethodDescriptor } from '../../control-plane/method-catalog-shared.js';
import { registerPaymentsGatewayMethods } from '../../control-plane/routes/payments.js';
import type {
  PaymentPurchaseView,
  PaymentsGatewayService,
} from '../../control-plane/routes/payments.js';
import { logger } from '../../utils/logger.js';
import { HandlerError, registerCatalogHandlers } from './handler-plumbing.js';
import type { TypedHandler, Unregister } from './handler-plumbing.js';
import { CheckoutServiceHolder, checkoutApproveHandler, checkoutBeginHandler, checkoutFillCardHandler } from './checkout-handlers.js';
import type { CheckoutComposition } from './checkout-handlers.js';
import { CardStoreUnreadableError } from './card-store.js';
import type { DaemonCardStore } from './card-store.js';
import { MAX_PURCHASE_LIST_LIMIT } from './purchase-ledger.js';
import type { DaemonPurchaseLedger, StoredPurchase } from './purchase-ledger.js';

export type { CheckoutComposition } from './checkout-handlers.js';

/** The verbs this module attaches. Named so a test can assert the exact set. */
export const ATTACHED_PAYMENTS_METHOD_IDS: readonly string[] = [
  'payments.budget.status',
  'payments.cards.list',
  'payments.cards.create',
  'payments.cards.delete',
  'payments.purchases.list',
  'payments.checkout.approve',
  'payments.checkout.begin',
  'payments.checkout.fillCard',
];

/**
 * The one descriptor in this family this PRODUCT authors, because the id is
 * product-owned: the SDK's catalog holds the seven `payments.*` verbs it
 * ships and no `payments.checkout.approve`, and the approve act is this
 * daemon's own composition (its store, its confirmation gate, its wire
 * shape). contracts.ts's never-author-a-descriptor rule is about not
 * RE-declaring an SDK id, which this is not; the parity test
 * (gateway-verb-family-parity.test.ts) pins this id the same way it pins the
 * rest, so it cannot drift in silently.
 */
const CHECKOUT_APPROVE_DESCRIPTOR: GatewayMethodDescriptor = {
  id: 'payments.checkout.approve',
  title: 'Approve One Purchase',
  description:
    'Record that a human approves one specific purchase, out of band from the conversation that will run '
    + 'it: the merchant\'s registrable domain, the item, and the amount (the same string a later begin call '
    + 'passes as requestedMax). Mints a persisted, single-use approval bound to exactly those fields, '
    + 'expiring in five minutes; payments.checkout.begin consumes it and refuses without one. Requires '
    + 'confirm: true and the explicit-user-request context, the same confirmation gate every destructive '
    + 'verb on this daemon uses. The response never carries card material; this verb never touches a card '
    + 'at all. ws-only invoke verb; no REST binding: the gateway REST table is the daemon-sdk\'s and this '
    + 'product cannot add rows to it, the same shape sessions.hosted.* already has.',
  category: 'payments',
  source: 'builtin',
  access: 'admin',
  transport: ['ws'],
  scopes: ['write:payments'],
  dangerous: true,
  inputSchema: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean' },
      merchantDomain: { type: 'string' },
      item: { type: 'string' },
      amount: { type: 'string' },
    },
    required: ['confirm', 'merchantDomain', 'item', 'amount'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      approved: { type: 'boolean' },
      action: { type: 'string' },
      merchantDomain: { type: 'string' },
      item: { type: 'string' },
      amount: { type: 'string' },
      expiresAt: { type: 'string' },
    },
    required: ['approved', 'action', 'merchantDomain', 'item', 'amount', 'expiresAt'],
    additionalProperties: false,
  },
};

/**
 * Kept, empty, rather than deleted: `gateway-payments-verbs.test.ts` and
 * `register.test.ts` iterate this to assert the unattached set, and an empty
 * array keeps that assertion meaningful (a future verb added here without a
 * handler still gets caught) instead of forcing every caller to delete the
 * loop. Nothing in this module's registration reads it any more.
 */
export const UNATTACHED_PAYMENTS_METHOD_IDS: readonly { readonly id: string; readonly reason: string }[] = [];

const DEFAULT_PURCHASE_LIST_LIMIT = 100;

export interface PaymentsHandlerDeps {
  readonly cards: DaemonCardStore;
  readonly purchases: DaemonPurchaseLedger;
  /** Today's pools. The checkout flow is the sole writer; the composition root is responsible for making this durable. */
  readonly budget: BudgetLedger;
  readonly config: PaymentsConfigReader;
  /**
   * Whether this node is the one allowed to spend.
   *
   * Reported, never defaulted, see the SDK's gates.ts: on a clustered install a
   * wrong answer here is a double-spend. The composition root supplies the
   * coordinator's own answer.
   */
  readonly isPaymentsLeader: () => boolean;
  readonly now?: (() => number) | undefined;
  readonly checkout: CheckoutComposition;
}

// ---------------------------------------------------------------------------
// Input readers
//
// Each names the FIELD and never the value, the property the SDK's own route
// module enforces: an error string is a read path like any other.
// ---------------------------------------------------------------------------

function invalid(field: string, requirement: string): HandlerError {
  return new HandlerError(`${field} ${requirement}`, 'INVALID_ARGUMENT', 400);
}

/**
 * Run a card-store call and refuse in the caller's terms.
 *
 * Two outcomes, and the difference is what the caller is allowed to be told:
 *
 *  - `CardStoreUnreadableError` is a message this codebase WROTE, naming the
 *    file and what to do about it. It is forwarded verbatim because the operator
 *    cannot fix a damaged card file they are not told about, and 409 says the
 *    honest thing: nothing is wrong with the request, the store is not in a
 *    state that can serve it.
 *  - Anything else came out of the secret store, and its message can name the
 *    store path, the key, or the value it was handling. It is DISCARDED and
 *    replaced here. Without this, `registerCatalogHandler`'s generic wrapper
 *    forwards the original as a 500 body, which put a store path in front of any
 *    caller holding read:payments.
 */
async function overStore<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CardStoreUnreadableError) {
      throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
    }
    void error;
    throw new HandlerError(`${what} failed.`, 'INTERNAL_ERROR', 500);
  }
}

function readString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(field, 'is required.');
  }
  return value.trim();
}

function readInteger(source: Record<string, unknown>, field: string, min: number, max: number): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalid(field, `must be a whole number between ${String(min)} and ${String(max)}.`);
  }
  return value;
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** A number that arrived as a query string (a GET) or as JSON (an invoke). */
function optionalCount(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    if (parsed > 0) return parsed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Response builders (allowlists, never spreads)
// ---------------------------------------------------------------------------

interface CardView {
  readonly id: string;
  readonly label: string;
  readonly brand: string;
  readonly last4: string;
  readonly kind: 'virtual' | 'real';
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly issuerCapMinorUnits: number | null;
  readonly addedAt: string;
  readonly materialComplete: boolean;
}

function cardView(card: CardMetadata, materialComplete: boolean): CardView {
  return {
    id: card.id,
    label: card.label,
    brand: card.brand,
    last4: card.last4,
    kind: card.kind,
    expiryMonth: card.expiryMonth,
    expiryYear: card.expiryYear,
    issuerCapMinorUnits: card.issuerCapMinorUnits,
    addedAt: card.addedAt,
    materialComplete,
  };
}

function purchaseView(row: StoredPurchase): PaymentPurchaseView {
  return {
    purchaseId: row.purchaseId,
    atUtc: row.atUtc,
    dayKey: row.dayKey,
    timezone: row.timezone,
    merchantDomain: row.merchantDomain,
    item: String(row.item),
    currency: String(row.currency),
    itemMinorUnits: row.itemMinorUnits,
    taxMinorUnits: row.taxMinorUnits,
    feesMinorUnits: row.feesMinorUnits,
    shippingMinorUnits: row.shippingMinorUnits,
    totalMinorUnits: row.totalMinorUnits,
    shippingTierRequested: row.shippingTierRequested,
    shippingTierUsed: row.shippingTierUsed,
    steppedDown: row.steppedDown === true,
    itemPoolDraw: row.itemPoolDraw,
    overagePoolDraw: row.overagePoolDraw,
    tolerancePoolDraw: row.tolerancePoolDraw,
    cardLast4: row.cardLast4,
    windowKind: row.windowKind,
    windowOutcome: row.windowOutcome,
    answeredBy: row.answeredBy ?? null,
    outcome: row.outcome,
    refusalReason: row.refusalReason ?? null,
    merchantOrderId: row.merchantOrderId ?? null,
    refundedAt: row.refundedAt ?? null,
    merchantRecognised: row.merchantRecognised === true,
    merchantQualifier: row.merchantQualifier ?? null,
    merchantDiscovered: row.merchantDiscovered === true,
  };
}

/**
 * A checkout verb reached through the service seam despite neither local
 * checkout handler below ever calling it: both call into the ONE
 * `PaymentsGatewayServiceImpl` this registration's checkout pair shares for
 * its whole life, held by `CheckoutServiceHolder` (checkout-handlers.ts), not
 * a fresh instance built per call. Only `begin` needs anything per-invocation,
 * the gate-input cell (`CheckoutGateInputsCell`) it writes just before each
 * call, since the shared service's `gates()` closure has no other way to see a
 * given call's `context.explicitUserRequest` or card/address facts; `fillCard`
 * reads nothing per-invocation at all, it types into fields the prior `begin`
 * already found. Either way, `PaymentsGatewayService`'s plain
 * `beginCheckout(input)`/`fillCardIntoCheckout(input)` shape has no room for
 * that context, which is the actual reason these two verbs are attached as
 * local wrappers rather than through this service (see this file's header).
 * The stub below exists only so `PaymentsGatewayService` stays fully
 * implemented for `registerPaymentsGatewayMethods`'s throwaway first
 * attachment, immediately replaced by `registerPaymentsMethods`.
 */
function checkoutNotWired(methodId: string): Error {
  return new Error(
    `${methodId} is served by this daemon's own local handler, never through this service. `
    + 'See registerPaymentsMethods in register.ts.',
  );
}

// ---------------------------------------------------------------------------

/**
 * The `PaymentsGatewayService` this daemon hands the SDK's registrar.
 *
 * `createCard` and `listPurchases` are real, not stubs: `payments.cards.create`
 * and `payments.purchases.list` keep their own thin local wrappers (below) for
 * the field-shape validation and the string-tolerant query reading the SDK's
 * generic route handlers do not do, and both wrappers call straight into these
 * same two methods for the store write and the response shape, so there is
 * exactly one place that talks to `DaemonCardStore.create` and to
 * `DaemonPurchaseLedger.list`.
 */
function buildPaymentsGatewayService(deps: PaymentsHandlerDeps): PaymentsGatewayService {
  const now = deps.now ?? Date.now;

  return {
    async budgetStatus() {
      const config = readPaymentsServiceConfig(deps.config);
      const nowMs = now();
      const pools = deps.budget.snapshot(config.limits, nowMs, config.timezone);
      const live = deps.budget.state().reservations.filter((entry) => entry.expiresAtMs > nowMs);
      return {
        enabled: readPaymentsEnabled(deps.config),
        currency: String(config.budgetCurrency),
        pools,
        reservationCount: live.length,
        isPaymentsLeader: deps.isPaymentsLeader(),
      };
    },

    async listCards() {
      return overStore('Listing the stored cards', async () => {
        const built: CardView[] = [];
        for (const card of deps.cards.list()) {
          built.push(cardView(card, await deps.cards.materialComplete(card.id)));
        }
        return { cards: built, defaultCardId: readDefaultCardId(deps.config) };
      });
    },

    async createCard(input) {
      let card: CardMetadata;
      try {
        card = await deps.cards.create(input);
      } catch (error) {
        // A damaged card file is the operator's to fix and its message says how,
        // so it is forwarded; see overStore. Everything else is discarded, because
        // the failing call had the card in its arguments.
        if (error instanceof CardStoreUnreadableError) {
          throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
        }
        void error;
        throw new HandlerError('Storing the card failed. Nothing was saved.', 'INTERNAL_ERROR', 500);
      }
      return cardView(card, await overStore('Reading the card back', () => deps.cards.materialComplete(card.id)));
    },

    async deleteCard(id) {
      return overStore('Deleting the card', () => deps.cards.remove(id));
    },

    async beginCheckout() {
      throw checkoutNotWired('payments.checkout.begin');
    },

    async fillCardIntoCheckout() {
      throw checkoutNotWired('payments.checkout.fillCard');
    },

    async listPurchases(input) {
      const result = deps.purchases.list(input);
      return { purchases: result.purchases.map(purchaseView), total: result.total };
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * What `registerPaymentsMethods` returns now that attachment has an async
 * phase. `unregister` is valid immediately, including before `ready` settles.
 * `ready` resolves once every handler is attached and REJECTS if attaching the
 * local handlers failed, so the caller that drops it must handle the
 * rejection (daemon-handler-composition.ts logs it; tests await it).
 */
export interface PaymentsRegistration {
  readonly ready: Promise<void>;
  readonly unregister: Unregister;
}

/**
 * Attach the eight `payments.*` handlers: seven to the descriptors the SDK
 * catalog already holds, and `payments.checkout.approve` to the one
 * descriptor this product authors (see `CHECKOUT_APPROVE_DESCRIPTOR` above).
 *
 * The SDK's `registerPaymentsGatewayMethods` runs its boot recovery sweep
 * before attaching, so it returns a promise and attaches a beat after this
 * function returns. This module's five local handlers MUST attach after that,
 * or the SDK's deferred attach would replace them, so they are chained on the
 * SDK's promise and `ready` is how a caller observes the whole sequence.
 *
 * NOT gated on `payments.enabled`. That key defaults to false, and
 * `payments.cards.*` is how a surface CONFIGURES the capability, so gating
 * registration on it would leave the configuration surface unreachable until the
 * capability was already configured, which is the shape of the defect this
 * module exists to fix. The setting is reported live by `budget.status` instead,
 * and it is `checkPaymentGates` at purchase time that stops a disabled daemon
 * from spending.
 */
export function registerPaymentsMethods(
  catalog: GatewayMethodCatalog,
  deps: PaymentsHandlerDeps,
): PaymentsRegistration {
  // Every descriptor this module attaches to, captured BEFORE any
  // registration runs. `registerCatalogHandlers`' own teardown (used below for
  // four of these) removes the DESCRIPTOR from the catalog entirely rather
  // than merely clearing its handler slot (`GatewayMethodCatalog.register`'s
  // returned teardown calls `unregister`, a `Map.delete`, not a handler
  // reset), so restoring a handler-less descriptor after THIS module's own
  // teardown, matching what the SDK's three descriptors are restored to below,
  // needs the descriptor object captured here rather than re-fetched from the
  // catalog afterward, when it may no longer be there to fetch.
  const descriptors = new Map<string, GatewayMethodDescriptor>();
  for (const id of ATTACHED_PAYMENTS_METHOD_IDS) {
    const descriptor = catalog.get(id);
    if (descriptor) descriptors.set(id, descriptor);
  }

  const service = buildPaymentsGatewayService(deps);

  // Attaches all seven `payments.*` descriptors once its boot recovery sweep
  // finishes. budget/list/delete stay attached through this; create/purchases-
  // list/checkout-begin/checkout-fillCard are transiently attached and then
  // replaced with this daemon's own local handlers in the chain below. The
  // hook payloads are the SDK's designed audit records: the failure callback
  // never carries a notice body and the sweep envelope exists to be logged.
  const sdkAttach = registerPaymentsGatewayMethods(catalog, service, {
    onRecoveryFailure: (error) => {
      logger.error('payments boot recovery failed', { error });
    },
    onRecoverySettled: (sweep) => {
      logger.info('payments boot recovery settled', { sweep });
    },
  });

  // The journal backing this registration's checkout pair's in-flight
  // registry (the SDK's own `CheckoutRegistry`, built inside
  // `PaymentsGatewayServiceImpl`'s constructor from whatever `CheckoutJournal`
  // it is handed, see checkout-handlers.ts's `buildCheckoutService`). It comes
  // from the composition (`deps.checkout.journal`), which in the real daemon
  // is `DurableCheckoutJournal` (checkout-journal-store.ts): every phase write
  // the registry makes, including the `submit-pending` flush checkout-flow.ts's
  // step 9 issues right before the merchant submit, lands on disk before the
  // submit happens, so a restart after a crash in that window can tell the
  // owner "this purchase may already have been submitted, do not resubmit it"
  // instead of having no record the purchase was ever in flight. Tests compose
  // the SDK's `MemoryCheckoutJournal` here instead, which is what the seam in
  // `CheckoutComposition` is for.
  //
  // The ONE checkout service instance this registration's approve/begin/
  // fillCard verbs share for their whole life; see checkout-handlers.ts's own
  // header.
  const checkoutServiceHolder = new CheckoutServiceHolder(deps, deps.checkout.journal);

  const cardsCreate: TypedHandler<unknown, Record<string, unknown>> = async ({ body }) => {
    const params = asRecord(body);
    const kind = readString(params, 'kind');
    if (kind !== 'virtual' && kind !== 'real') {
      throw invalid('kind', "must be 'virtual' or 'real'.");
    }
    const label = readString(params, 'label');
    const number = readString(params, 'number');
    // Narrower than the published input schema, which types these as a plain
    // string and a plain number. Each check below is a property of BEING a card
    // rather than a policy about one: a value that fails it could not be
    // charged, and storing it would produce a card the surface offers and the
    // checkout can never fill. None of them names anything but the field.
    if (number.replace(/\D/g, '').length < 12) {
      throw invalid('number', 'does not contain enough digits to be a card number.');
    }
    const expiryMonth = readInteger(params, 'expiryMonth', 1, 12);
    // A full four-digit year: `cardFieldValue` derives the two-digit form by
    // slicing this one, so a year stored as 29 would type as "29" in a
    // four-digit field and as "29" in a two-digit one, and only one of those is
    // right.
    const expiryYear = readInteger(params, 'expiryYear', 1000, 9999);
    const cvv = readString(params, 'cvv');
    if (!/^[0-9]{3,4}$/.test(cvv)) {
      throw invalid('cvv', 'must be the three or four digit code printed on the card.');
    }
    const cardholderName = readString(params, 'cardholderName');
    const rawCap = params['issuerCapMinorUnits'];

    const card = await service.createCard({
      label,
      kind,
      number,
      expiryMonth,
      expiryYear,
      cvv,
      cardholderName,
      issuerCapMinorUnits: typeof rawCap === 'number' && Number.isInteger(rawCap) ? rawCap : null,
    });
    return { card };
  };

  const purchasesList: TypedHandler<unknown, Record<string, unknown>> = async ({ body, query }) => {
    const params = { ...query, ...asRecord(body) };
    const requested = optionalCount(params['limit']);
    const rawDay = params['dayKey'];
    const dayKey = typeof rawDay === 'string' && rawDay.trim().length > 0 ? rawDay.trim() : undefined;
    return service.listPurchases({
      limit: Math.min(requested ?? DEFAULT_PURCHASE_LIST_LIMIT, MAX_PURCHASE_LIST_LIMIT),
      dayKey,
    });
  };

  // Restores EVERY descriptor this module attached to, handler-less, not
  // only the three `registerPaymentsGatewayMethods` still holds a live
  // handler on. The other four have their descriptor removed outright by
  // `localTeardown()` (see the `descriptors` capture at the top of this
  // function for why), so without this a re-registration on the SAME catalog
  // (a second `registerPaymentsMethods` call, as a restart-without-recompose
  // test does) would find those four ids gone from the catalog and throw
  // `METHOD_NOT_FOUND` trying to attach to them, rather than finding the
  // SDK's own builtin descriptor there to replace, exactly as it would on a
  // catalog this module had never touched.
  const restoreDescriptors = (): void => {
    for (const [, descriptor] of descriptors) {
      catalog.register(descriptor, undefined, { replace: true });
    }
  };

  let torn = false;
  let localTeardown: Unregister | undefined;

  const ready = sdkAttach.then(() => {
    // Teardown already ran: the SDK's attach (which resolved just before this
    // callback) put live handlers back on descriptors the teardown had
    // restored handler-less, so restore them again instead of attaching the
    // local handlers to a surface that was already released.
    if (torn) {
      restoreDescriptors();
      return;
    }
    // The approve descriptor is product-authored (see its declaration above),
    // so it is placed on the catalog here, handler-less, exactly where the
    // SDK's own descriptors already sit, and then attached through the same
    // `registerCatalogHandlers` path as the other local wrappers. `replace:
    // true` so a registration over a catalog that already carries it (a
    // recompose that skipped teardown) replaces rather than throws.
    catalog.register(CHECKOUT_APPROVE_DESCRIPTOR, undefined, { replace: true });

    localTeardown = registerCatalogHandlers(catalog, [
      { id: 'payments.cards.create', handler: cardsCreate as TypedHandler<unknown, unknown> },
      { id: 'payments.purchases.list', handler: purchasesList as TypedHandler<unknown, unknown> },
      // The confirmation gate (`confirm: true` AND the explicit-user-request
      // context) is what makes this verb owner-direct: the handler then passes
      // `surface: 'owner-direct'` from its own code path. See
      // checkout-handlers.ts's `checkoutApproveHandler`.
      { id: 'payments.checkout.approve', handler: checkoutApproveHandler(deps) as TypedHandler<unknown, unknown>, options: { confirm: true } },
      { id: 'payments.checkout.begin', handler: checkoutBeginHandler(deps, checkoutServiceHolder) as TypedHandler<unknown, unknown> },
      { id: 'payments.checkout.fillCard', handler: checkoutFillCardHandler(deps, checkoutServiceHolder) as TypedHandler<unknown, unknown> },
    ]);
  });

  return {
    ready,
    unregister: () => {
      torn = true;
      localTeardown?.();
      restoreDescriptors();
    },
  };
}
