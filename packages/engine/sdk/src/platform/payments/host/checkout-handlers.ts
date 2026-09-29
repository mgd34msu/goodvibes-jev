/**
 * checkout-handlers.ts, `payments.checkout.begin` / `payments.checkout.fillCard`.
 *
 * Split out of register.ts for the 800-line file cap, the same reason
 * daemon-handler-composition.ts/ci-watch-composition.ts exist as their own
 * modules; no behavioural change from being here rather than there.
 *
 * ── Why these two verbs are local wrappers, not the SDK's own route ───────
 *
 * `registerPaymentsGatewayMethods`'s own `createPaymentsCheckoutBeginHandler`/
 * `createPaymentsCheckoutFillCardHandler` call
 * `service.beginCheckout(input)`/`service.fillCardIntoCheckout(input)` with no
 * invocation context at all. This daemon's whole "approving a purchase is a
 * distinct act" ruling (see `checkoutBeginHandler` below) needs
 * `context.explicitUserRequest`, which only reaches a handler attached through
 * this daemon's own `registerCatalogHandlers` (register.ts). So both verbs are
 * attached there as local wrappers, reading and shaping the SAME wire shapes
 * `routes/payments.ts` does (ported here rather than imported, since the SDK
 * does not publish those parsing functions on their own), and calling into the
 * ONE `PaymentsGatewayServiceImpl` a registration's checkout pair shares for
 * its whole life (see `CheckoutServiceHolder` below for why one, not one per
 * call).
 */
import { checkAddress } from '../address.js';
import type { AddressStore } from '../address.js';
import { CheckoutRegistryError } from '../checkout-registry.js';
import type { CheckoutJournal } from '../checkout-registry.js';
import type { MerchantJudgePort } from '../merchant-recourse.js';
import type { PaymentNotifier } from '../payment-ports.js';
import { PaymentsGatewayServiceImpl } from '../payments-gateway-service.js';
import { readPaymentsEnabled, readPaymentsServiceConfig } from '../payments-config.js';
import { SHIPPING_TIERS } from '../types.js';
import type { ShippingTier } from '../types.js';
import type { UntrustedContentLedger } from '../../security/untrusted-content.js';
import type { BrowserCheckoutSeam } from '../../control-plane/routes/browser-composition.js';
import { HandlerError } from './handler-plumbing.js';
import type { TypedHandler } from './handler-plumbing.js';
import type { DaemonApprovalStore } from './approval-store.js';
import type { DaemonCardStore } from './card-store.js';
import type { PaymentsHandlerDeps } from './register.js';

/**
 * Everything the checkout pair needs beyond what the other five verbs use.
 *
 * Built by runtime/payments-composition.ts and handed here as one bundle
 * because every field is checkout-only: nothing else in register.ts reads an
 * address, sends a notice, judges a merchant, or reads the untrusted-content
 * ledger.
 */
export interface CheckoutComposition {
  /**
   * The browser-checkout seam, once `onBrowserCheckout` has fired.
   *
   * A GETTER, not a value: this composition is built and register.ts's
   * handlers are registered before the browser composition runs (see
   * runtime/browser-checkout-seam-holder.ts), so the seam is not there yet at
   * REGISTRATION time and must be read fresh at CALL time. `undefined` means
   * either "this daemon never builds a browser" (no home directory) or "not
   * wired yet"; by the time any real invocation reaches this handler the
   * daemon has finished booting and it is the former or nothing, and the
   * handler refuses honestly either way.
   */
  readonly seam: () => BrowserCheckoutSeam | undefined;
  readonly addresses: AddressStore;
  readonly notifier: PaymentNotifier;
  readonly merchantJudge: MerchantJudgePort;
  /** The process-wide ledger; see routes/browser-composition.ts's header for why it must be shared, not private. */
  readonly untrusted: UntrustedContentLedger;
  /**
   * The persisted, single-use approvals `payments.checkout.approve` mints and
   * `payments.checkout.begin` spends. See approval-store.ts for the four
   * properties the store keeps, and `checkoutBeginHandler` below for where
   * one is consumed.
   */
  readonly approvals: DaemonApprovalStore;
  /**
   * The journal the shared service's in-flight registry writes through. The
   * real daemon composes `DurableCheckoutJournal`
   * (checkout-journal-store.ts) so a `submit-pending` record survives a
   * restart; tests may compose the SDK's `MemoryCheckoutJournal`.
   */
  readonly journal: CheckoutJournal;
}

function invalid(field: string, requirement: string): HandlerError {
  return new HandlerError(`${field} ${requirement}`, 'INVALID_ARGUMENT', 400);
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw invalid(field, 'is required.');
  return value.trim();
}

function requireWholeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(field, 'must be a whole number.');
  return value;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Deliberately STRICTER than the sdk's own route (routes/payments.ts), which
 * passes any non-empty `preferredTier` string through unvalidated. This is a
 * deliberate pin, not an oversight relative to that route: a value outside
 * `SHIPPING_TIERS` could not have come from a tier this daemon actually
 * offers, so it is read as "not specified" rather than forwarded, and
 * `beginCheckout` falls back to the configured preferred tier when this is
 * undefined (payments-gateway-service.ts), the same safe default an absent
 * field already gets.
 */
function optionalShippingTier(value: unknown): ShippingTier | undefined {
  return typeof value === 'string' && (SHIPPING_TIERS as readonly string[]).includes(value)
    ? (value as ShippingTier)
    : undefined;
}

function readObjectRows(value: unknown, field: string, required: boolean): Record<string, unknown>[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw invalid(field, 'is required and must be a non-empty array.');
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid(`${field}[${String(index)}]`, 'must be an object.');
    }
    return entry as Record<string, unknown>;
  });
}

function readStringRows(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalid(field, 'must be an array of strings.');
  return value.map((entry, index) => requireString(entry, `${field}[${String(index)}]`));
}

/** The exact shape `PaymentsGatewayServiceImpl.beginCheckout` wants, read off the wire. */
function parseBeginCheckoutInput(params: Record<string, unknown>): Parameters<PaymentsGatewayServiceImpl['beginCheckout']>[0] {
  const requestedLines = readObjectRows(params['requestedLines'], 'requestedLines', true).map((entry, index) => ({
    label: requireString(entry['label'], `requestedLines[${String(index)}].label`),
    quantity: requireWholeNumber(entry['quantity'], `requestedLines[${String(index)}].quantity`),
  }));
  const lines = readObjectRows(params['lines'], 'lines', true).map((entry, index) => ({
    label: requireString(entry['label'], `lines[${String(index)}].label`),
    quantity: requireString(entry['quantity'], `lines[${String(index)}].quantity`),
    unitPrice: requireString(entry['unitPrice'], `lines[${String(index)}].unitPrice`),
  }));
  const fees = readObjectRows(params['fees'], 'fees', false).map((entry, index) => ({
    label: requireString(entry['label'], `fees[${String(index)}].label`),
    amount: requireString(entry['amount'], `fees[${String(index)}].amount`),
  }));
  const shippingOptions = readObjectRows(params['shippingOptions'], 'shippingOptions', true).map((entry, index) => ({
    label: requireString(entry['label'], `shippingOptions[${String(index)}].label`),
    cost: requireString(entry['cost'], `shippingOptions[${String(index)}].cost`),
  }));
  const cardFields = readObjectRows(params['cardFields'], 'cardFields', true).map((entry, index) => ({
    field: requireString(entry['field'], `cardFields[${String(index)}].field`),
    ref: requireString(entry['ref'], `cardFields[${String(index)}].ref`),
  }));
  const addressFields = readObjectRows(params['addressFields'], 'addressFields', false).map((entry, index) => ({
    kind: requireString(entry['kind'], `addressFields[${String(index)}].kind`),
    field: requireString(entry['field'], `addressFields[${String(index)}].field`),
    ref: requireString(entry['ref'], `addressFields[${String(index)}].ref`),
  }));
  const twoDigit = params['twoDigitYear'];
  return {
    sessionId: requireString(params['sessionId'], 'sessionId'),
    pageId: requireString(params['pageId'], 'pageId'),
    merchantDomain: requireString(params['merchantDomain'], 'merchantDomain'),
    checkoutUrl: requireString(params['checkoutUrl'], 'checkoutUrl'),
    item: requireString(params['item'], 'item'),
    cardId: requireString(params['cardId'], 'cardId'),
    requestedLines,
    reading: {
      lines,
      tax: optionalNonEmptyString(params['tax']) ?? null,
      fees,
      shippingOptions,
      statedTotal: optionalNonEmptyString(params['statedTotal']) ?? null,
      currency: optionalNonEmptyString(params['currency']) ?? null,
      orderSummaryText: typeof params['orderSummaryText'] === 'string' ? params['orderSummaryText'] : '',
    },
    controls: {
      cardFields,
      addressFields,
      shippingTargets: readStringRows(params['shippingTargets'], 'shippingTargets'),
      placeOrderTarget: requireString(params['placeOrderTarget'], 'placeOrderTarget'),
      expirySeparator: optionalNonEmptyString(params['expirySeparator']),
      twoDigitYear: typeof twoDigit === 'boolean' ? twoDigit : undefined,
    },
    preferredTier: optionalShippingTier(params['preferredTier']),
    requestedMax: optionalNonEmptyString(params['requestedMax']),
    // The sdk's own route (routes/payments.ts) never reads this field off the
    // wire at all: `PaymentBeginCheckoutInput` has no `merchantDiscovered`
    // property, and `service.beginCheckout` is called with it simply absent,
    // which `checkout-flow.ts` then defaults to false. This daemon matches
    // that byte for byte rather than trusting a caller-supplied flag:
    // `merchantDiscovered` skips the taint check on the merchant and the
    // checkout url (taint-gate.ts), and nothing on this wire path can attest
    // that a page was actually browsed to rather than simply named by
    // whoever is calling. A future attested-discovery flow may reintroduce
    // this deliberately, with its own provenance, not as a bare wire field.
    merchantDiscovered: false,
  };
}

/** The exact shape `PaymentsGatewayServiceImpl.fillCardIntoCheckout` wants, read off the wire. */
function parseFillCardInput(params: Record<string, unknown>): Parameters<PaymentsGatewayServiceImpl['fillCardIntoCheckout']>[0] {
  const rawTargets = params['targets'];
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw invalid('targets', 'is required: name each card field you found and the ref to type it into.');
  }
  const targets = rawTargets.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw invalid(`targets[${String(index)}]`, 'must be an object.');
    }
    const record = entry as Record<string, unknown>;
    return {
      field: requireString(record['field'], `targets[${String(index)}].field`),
      ref: requireString(record['ref'], `targets[${String(index)}].ref`),
    };
  });
  // Deliberately a plain `typeof` check, not `optionalNonEmptyString`: the
  // sdk's own fillCard route (routes/payments.ts) keeps an EMPTY separator
  // distinct from an ABSENT one (a caller that says "" is asking for the
  // digits run together, `0729`, and one that says nothing gets the default
  // `/`), and `optionalNonEmptyString` would collapse both to `undefined`.
  // `parseBeginCheckoutInput`'s own `expirySeparator` field stays on
  // `optionalNonEmptyString`, matching the sdk's begin route instead, which
  // does the same collapse there.
  const separator = params['expirySeparator'];
  return {
    sessionId: requireString(params['sessionId'], 'sessionId'),
    pageId: requireString(params['pageId'], 'pageId'),
    targets,
    expirySeparator: typeof separator === 'string' ? separator : undefined,
    twoDigitYear: typeof params['twoDigitYear'] === 'boolean' ? params['twoDigitYear'] : undefined,
  };
}

/**
 * Allowlisted, the same reason `sanitizeFillResult` exists in the SDK's own
 * route module: a service bug becomes a missing field here, never a leaked
 * one, and this wrapper bypasses that route entirely, so it is this file's job
 * to keep the property.
 */
function fillCardResultView(result: Awaited<ReturnType<PaymentsGatewayServiceImpl['fillCardIntoCheckout']>>): Record<string, unknown> {
  return {
    ok: result.ok === true,
    filled: (result.filled ?? []).map((field) => String(field)),
    failedField: result.failedField === null || result.failedField === undefined ? null : String(result.failedField),
    reason: result.reason === null || result.reason === undefined ? null : String(result.reason),
  };
}

/**
 * Whether the named card can actually be charged: configured, and its
 * material present in the secret store. Computed here, outside
 * `PaymentsGatewayServiceImpl`, because `GateInput` is a plain synchronous
 * record and this daemon's card-material check is async.
 */
async function hasUsableCard(cards: DaemonCardStore, cardId: string): Promise<boolean> {
  if (cardId.length === 0) return false;
  const metadata = await cards.metadata(cardId);
  if (metadata === null) return false;
  return cards.materialComplete(cardId);
}

/** Same reasoning as `hasUsableCard`: an async read, resolved before `GateInput` is built. */
async function hasShippingAddress(addresses: AddressStore): Promise<boolean> {
  const stored = await addresses.read('shipping');
  return checkAddress(stored, 'shipping').ok;
}

/**
 * The per-invocation gate facts the shared checkout service's `gates()`
 * closure reads. A mutable CELL, not a value passed at construction: the
 * service is built ONCE (see `CheckoutServiceHolder` below) and its `gates()`
 * closure is called synchronously, on every `beginCheckout` call, from deep
 * inside that one shared instance, so the only way for it to see THIS call's
 * facts is to read them from somewhere written just before this call and nowhere
 * held between calls.
 *
 * Safe under concurrent calls despite being shared, mutable state, because of
 * WHEN it is read: `checkoutBeginHandler` writes it and then, in the same
 * synchronous span with no `await` between the write and the call, invokes
 * `service.beginCheckout(input)`. `beginCheckout`'s own body runs synchronously
 * up to its first internal `await` (see payments-gateway-service.ts), and
 * `gates()` is invoked inside that synchronous prefix, so the value it reads is
 * always the one THIS call just wrote, captured into a plain `GateInput` object
 * before control ever returns to the event loop. A second call writing the cell
 * later cannot land between the write and the read of an earlier one; only
 * between two DIFFERENT calls' write-then-read pairs, which never interleave
 * with each other's.
 */
interface CheckoutGateInputsCell {
  current: { readonly hasUsableCard: boolean; readonly hasShippingAddress: boolean; readonly isOwnerDirectRequest: boolean };
}

const NO_GATE_INPUTS_YET = { hasUsableCard: false, hasShippingAddress: false, isOwnerDirectRequest: false };

/**
 * Build the ONE `PaymentsGatewayServiceImpl` a registration's checkout pair
 * shares for its whole life. See `CheckoutServiceHolder` for why one, not one
 * per call.
 */
function buildCheckoutService(
  deps: PaymentsHandlerDeps,
  seam: BrowserCheckoutSeam,
  journal: CheckoutJournal,
  gateInputs: CheckoutGateInputsCell,
): PaymentsGatewayServiceImpl {
  return new PaymentsGatewayServiceImpl({
    cards: deps.cards,
    addresses: deps.checkout.addresses,
    ledger: deps.budget,
    purchases: deps.purchases,
    notifier: deps.checkout.notifier,
    untrusted: deps.checkout.untrusted,
    journal,
    merchantJudge: deps.checkout.merchantJudge,
    driverFor: seam.driverFor,
    cardFieldGuard: seam.cardFieldGuard,
    gates: () => ({
      enabled: readPaymentsEnabled(deps.config),
      isPaymentsLeader: deps.isPaymentsLeader(),
      ...gateInputs.current,
    }),
    config: () => readPaymentsServiceConfig(deps.config),
    ...(deps.now ? { now: deps.now } : {}),
  });
}

/**
 * Holds the ONE `PaymentsGatewayServiceImpl` a registration's checkout pair
 * shares for the life of the registration, and the gate-input cell its
 * `gates()` closure reads.
 *
 * ── Why one instance, not one per call ─────────────────────────────────────
 *
 * `PaymentsGatewayServiceImpl` builds its own `CheckoutRegistry` in its
 * constructor (`this.registry = new CheckoutRegistry(deps.journal)`,
 * payments-gateway-service.ts), and that registry's live "which page has a
 * purchase open" map (`byPage`) is IN-MEMORY, per-instance state, not
 * recovered from the journal at construction. The sdk's own header names the
 * property this holder exists to keep: "`begin` opens a checkout and
 * `fillCard` completes one, and they are separate verbs arriving as separate
 * control-plane calls. The in-flight registry has to outlive both, so it
 * lives here for the life of the service rather than being constructed per
 * call." A fresh service (and therefore a fresh, empty registry) built on
 * every call cannot keep that promise: two `begin` calls on the same page each
 * get their own empty map, so the registry's own duplicate guard
 * (`CheckoutRegistry.open` refuses a second open on a page already running
 * one) never fires, and a `fillCard` call afterward finds an empty map too, so
 * it always refuses "no purchase decision is in flight" even for a page that
 * genuinely has one, exactly the honest-sounding but wrong refusal a real
 * caller and a nonexistent one would both get.
 *
 * ── Why memoized on first use, not built at registration ───────────────────
 *
 * `PaymentsGatewayServiceImpl` needs a concrete `BrowserCheckoutSeam` (for
 * `driverFor` and `cardFieldGuard`) to construct, and `deps.checkout.seam()`
 * may still return `undefined` at the moment `registerPaymentsMethods` runs
 * (see `CheckoutComposition.seam`'s own doc comment: the browser composition
 * that fills it runs AFTER this daemon's handlers are registered). So the
 * instance is built lazily, on the first call that finds a real seam, and
 * cached from then on. Safe to cache permanently: `onBrowserCheckout` fires at
 * most once per daemon process (browser-checkout-seam-holder.ts), so once a
 * real seam has been seen it is THE seam for the rest of this registration's
 * life.
 */
export class CheckoutServiceHolder {
  private service: PaymentsGatewayServiceImpl | null = null;
  readonly gateInputs: CheckoutGateInputsCell = { current: NO_GATE_INPUTS_YET };

  constructor(
    private readonly deps: PaymentsHandlerDeps,
    private readonly journal: CheckoutJournal,
  ) {}

  serviceFor(seam: BrowserCheckoutSeam): PaymentsGatewayServiceImpl {
    this.service ??= buildCheckoutService(this.deps, seam, this.journal, this.gateInputs);
    return this.service;
  }
}

const CHECKOUT_UNAVAILABLE_MESSAGE =
  'Checkout is not available on this daemon right now: no browser is composed for it (no home directory '
  + 'configured, or the browser composition has not finished starting). Retry once the daemon has finished '
  + 'booting; if this persists, the daemon was started without a home directory to keep browser profiles in.';

/**
 * The action an owner approval authorizes: one `payments.checkout.begin`.
 * The approve verb mints against this constant and `begin` spends against it,
 * so the two can never drift into approving one verb and spending on another.
 */
export const CHECKOUT_APPROVAL_ACTION = 'payments.checkout.begin';

/**
 * The exact fields an approval binds, built the same way on both sides.
 *
 * On the approve side the values are what the owner typed; on the begin side
 * they are read from the begin call itself (`merchantDomain`, `item`,
 * `requestedMax`). One builder for both is what makes the fingerprint a
 * comparison of the deed rather than two modules' ideas of it.
 */
export function checkoutApprovalContent(input: {
  readonly merchantDomain: string;
  readonly item: string;
  readonly amount: string | undefined;
}): Readonly<Record<string, string | undefined>> {
  return { merchant: input.merchantDomain, item: input.item, amount: input.amount };
}

/** How a begin call names the approve verb when it refuses, per mismatch. */
function approvalRefusalMessage(mismatch: string): string {
  if (mismatch === 'expired') {
    return 'The owner approval for this purchase has expired. Approvals last five minutes: call '
      + 'payments.checkout.approve again with the same merchantDomain, item and amount, then begin promptly.';
  }
  if (mismatch === 'different-content' || mismatch === 'no-content-binding') {
    return 'The owner approval on file was for a different purchase: its merchant, item or amount does not '
      + 'match this begin call (the amount is compared against requestedMax). Call payments.checkout.approve '
      + 'with exactly what this begin call names, then begin again.';
  }
  return 'This purchase has no owner approval on file. A human approves it first, out of band from this '
    + 'call: invoke payments.checkout.approve with this purchase\'s merchantDomain, item and amount (the '
    + 'begin call\'s requestedMax), then begin within five minutes.';
}

/**
 * Spend the one approval matching this begin call, or refuse naming the
 * approve verb. Consuming before the service runs is the sdk store's own
 * safe direction: an approval taken for a begin that then refuses on a later
 * gate is spent, never silently reusable.
 */
function consumeCheckoutApproval(
  approvals: DaemonApprovalStore,
  input: { readonly merchantDomain: string; readonly item: string; readonly requestedMax?: string | undefined },
): void {
  let taken: ReturnType<DaemonApprovalStore['take']>;
  try {
    taken = approvals.take({
      action: CHECKOUT_APPROVAL_ACTION,
      content: checkoutApprovalContent({
        merchantDomain: input.merchantDomain,
        item: input.item,
        amount: input.requestedMax,
      }),
    });
  } catch (error) {
    // A store that could not persist the removal rolled it back and threw
    // (approval-store.ts): the approval is still on file and nothing was
    // submitted. Contained: the raw error can name the store path.
    void error;
    throw new HandlerError(
      'Recording the spent approval failed. The approval was not consumed and nothing was submitted.',
      'INTERNAL_ERROR',
      500,
    );
  }
  if (taken.approval === null) {
    throw new HandlerError(approvalRefusalMessage(taken.mismatch), 'OWNER_APPROVAL_REQUIRED', 403);
  }
}

/**
 * `payments.checkout.approve`.
 *
 * The distinct act the sdk's owner-approval ruling requires: a HUMAN, on a
 * surface with command authority, names one purchase and approves it. The
 * registration (register.ts) puts this handler behind the same confirmation
 * gate every destructive verb in this daemon uses (`confirm: true` in the
 * body AND the explicit-user-request context flag), and the handler passes
 * `surface: 'owner-direct'` from its own code path, never from an argument,
 * which is the property `grantOwnerApproval` exists to enforce.
 *
 * The minted record is persisted (approval-store.ts), single-use, bound to
 * the exact merchant + item + amount fields named here, and expires in five
 * minutes. `payments.checkout.begin` spends it; see `checkoutBeginHandler`.
 */
export function checkoutApproveHandler(deps: PaymentsHandlerDeps): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body }) => {
    const params = asRecord(body);
    const merchantDomain = requireString(params['merchantDomain'], 'merchantDomain');
    const item = requireString(params['item'], 'item');
    const amount = requireString(params['amount'], 'amount');
    let approval;
    try {
      approval = deps.checkout.approvals.grant({
        action: CHECKOUT_APPROVAL_ACTION,
        content: checkoutApprovalContent({ merchantDomain, item, amount }),
      });
    } catch (error) {
      // Contained for the same reason as `consumeCheckoutApproval`: the raw
      // write failure can name the store path, and an approval that never
      // reached disk was deliberately rolled back rather than left spendable.
      void error;
      throw new HandlerError('Recording the approval failed. Nothing was approved.', 'INTERNAL_ERROR', 500);
    }
    // Named fields, never a spread, the same containment rule as every other
    // response in this family.
    return {
      approved: true,
      action: CHECKOUT_APPROVAL_ACTION,
      merchantDomain,
      item,
      amount,
      expiresAt: approval.expiresAt,
    };
  };
}

/** The sdk's own explicit nine-field projection (routes/payments.ts's `createPaymentsCheckoutBeginHandler`), not a spread. */
function beginResultView(result: Awaited<ReturnType<PaymentsGatewayServiceImpl['beginCheckout']>>): Record<string, unknown> {
  return {
    outcome: String(result.outcome),
    purchaseId: result.purchaseId ?? null,
    reason: result.reason ?? null,
    merchantOrderId: result.merchantOrderId ?? null,
    totalMinorUnits: result.totalMinorUnits ?? null,
    currency: result.currency ?? null,
    shippingTierUsed: result.shippingTierUsed ?? null,
    steppedDown: result.steppedDown === true,
    challengeStep: result.challengeStep ?? null,
  };
}

/**
 * `payments.checkout.begin`.
 *
 * ── What actually gates a purchase here ────────────────────────────────────
 *
 * `context.explicitUserRequest` is a caller-set header/frame field
 * (`x-goodvibes-explicit-user-request`; see the sdk's
 * `routes/explicit-user-request.ts` and `normalizeContext` in
 * `daemon/handlers/register.ts`), no stronger a claim than `confirm: true` on
 * any other confirmation-gated verb in this daemon. It gates ENTRY to this
 * verb, `isOwnerDirectRequest` in the `GateInput` `checkPaymentGates` reads
 * (gates.ts), and nothing about the submit itself. It also resets the
 * untrusted-content watermark the taint gates read
 * (`security/turn-boundary.ts`), a second, separate effect of the same
 * caller-set claim, not something this handler arranges.
 *
 * ── The genuine owner-approval record, consumed here ───────────────────────
 *
 * Behind that outer gate sits the distinct-act approval the sdk's
 * owner-approval ruling describes (platform/security/owner-approval.ts): a
 * persisted record that a human called `payments.checkout.approve`, out of
 * band from whatever conversation produced this begin call, naming ONE
 * purchase by merchant, item and amount. This handler spends exactly one
 * matching record per begin (`DaemonApprovalStore.take`, approval-store.ts:
 * single-use, content-bound via the sdk's own fingerprint, five-minute TTL)
 * and refuses, naming the approve verb, when none matches. The record is
 * consumed BEFORE the service runs, which is the sdk store's own safe
 * direction: a taken approval whose begin then refuses on a later gate is
 * spent, never quietly retried.
 *
 * The binding fields are `merchantDomain`, `item` and `requestedMax`, read
 * from THIS begin call and fingerprinted the same way the approve verb
 * fingerprinted what the owner typed, so a begin whose merchant, item or
 * amount differs from what was approved is `different-content`, not a match.
 * An earlier mechanism that armed `seam.armSubmitApproval` with a
 * content-free approval was deleted rather than shipped, because an approval
 * with no content binding clears nothing real; this record is the strong
 * form, minted with the exact fields.
 *
 * The money controls downstream of both gates are unchanged: the budget
 * ledger (RESERVE, step 5), the purchase notices and their approval/veto
 * decision windows (NOTICE + WINDOW, step 6), and the card-material guard
 * (`cardFieldGuard`, armed only immediately before typing, never before).
 * See `checkout-flow.ts`'s own header for the full order.
 */
export function checkoutBeginHandler(deps: PaymentsHandlerDeps, holder: CheckoutServiceHolder): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body, context }) => {
    const params = asRecord(body);
    const input = parseBeginCheckoutInput(params);

    const seam = deps.checkout.seam();
    if (seam === undefined) {
      throw new HandlerError(CHECKOUT_UNAVAILABLE_MESSAGE, 'FAILED_PRECONDITION', 409);
    }

    // The approval is only consulted INSIDE the outer explicitUserRequest
    // layer: a call that never claimed to be owner-direct falls through to
    // the service, whose own gate refuses it `refused:not-owner-request`
    // exactly as before this record existed. Consuming an approval for a
    // call that outer layer was always going to refuse would spend the
    // owner's answer on nothing.
    if (context.explicitUserRequest) {
      consumeCheckoutApproval(deps.checkout.approvals, input);
    }

    const [usableCard, shippingAddress] = await Promise.all([
      hasUsableCard(deps.cards, input.cardId),
      hasShippingAddress(deps.checkout.addresses),
    ]);

    // Written immediately before the call it applies to, with no `await`
    // between: see `CheckoutGateInputsCell`'s own doc comment for why that
    // ordering is what keeps this safe under concurrent calls.
    holder.gateInputs.current = {
      hasUsableCard: usableCard,
      hasShippingAddress: shippingAddress,
      isOwnerDirectRequest: context.explicitUserRequest,
    };
    const service = holder.serviceFor(seam);

    try {
      const result = await service.beginCheckout(input);
      return beginResultView(result);
    } catch (error) {
      // `CheckoutRegistryError` (a second `begin` finding one already in
      // flight on this page) is the owner's business and carries no card
      // material, so it is forwarded, the same containment shape
      // `checkoutFillCardHandler` gives `FillCardRefusal` below. Anything else
      // is discarded: the failing call had the card in its arguments, and an
      // error string is a read path like any other.
      if (error instanceof CheckoutRegistryError) {
        throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
      }
      void error;
      throw new HandlerError('Beginning this checkout failed. Nothing was submitted.', 'INTERNAL_ERROR', 500);
    }
  };
}

/**
 * `payments.checkout.fillCard`.
 *
 * No submit approval and no `gates()` reasoning: `fillCardIntoCheckout` never
 * consults either (it types into fields, it does not click a submit control),
 * so this handler's only checkout-specific concern is the same seam
 * availability check `checkoutBeginHandler` makes. It never writes
 * `holder.gateInputs`: whatever a prior `begin` call on this same holder left
 * there (or the `NO_GATE_INPUTS_YET` default, if none ever ran) is simply
 * never read by a fill.
 */
export function checkoutFillCardHandler(deps: PaymentsHandlerDeps, holder: CheckoutServiceHolder): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body }) => {
    const params = asRecord(body);
    const input = parseFillCardInput(params);

    const seam = deps.checkout.seam();
    if (seam === undefined) {
      throw new HandlerError(CHECKOUT_UNAVAILABLE_MESSAGE, 'FAILED_PRECONDITION', 409);
    }

    const service = holder.serviceFor(seam);

    try {
      const result = await service.fillCardIntoCheckout(input);
      return fillCardResultView(result);
    } catch (error) {
      // A `FillCardRefusal` is the owner's business and carries no material
      // (fill-card.ts's own contract), so it is forwarded; anything else is
      // discarded, the failing call had the card in its stack, and an error
      // string is a read path like any other.
      if (error instanceof Error && error.name === 'FillCardRefusal') {
        throw new HandlerError(error.message, 'INVALID_ARGUMENT', 400);
      }
      void error;
      throw new HandlerError('Filling the card into this checkout failed. Nothing was submitted.', 'INTERNAL_ERROR', 500);
    }
  };
}
