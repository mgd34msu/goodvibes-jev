/**
 * The host side of the `payments.*` surface: the card store, the purchase
 * ledger, the durable budget, approval and checkout-journal stores, the address
 * store, and the handler registration that binds them to the gateway
 * descriptors.
 *
 * The composition root is the only module that decides where the files live and
 * which secret tier the material lands in. The merchant judge and the payment
 * notifier are supplied by it as injected ports (`CheckoutComposition`): the
 * engine's are `createJevMerchantJudge` (the Jev merchant reading) and
 * `channelBackedPaymentNotifier` over the daemon's `PaymentReplyInbox`.
 */
export {
  CARD_MATERIAL_FIELDS,
  CardStoreUnreadableError,
  DaemonCardStore,
  cardBrand,
  cardSecretKey,
  newCardId,
} from './card-store.js';
export type {
  CardCreateInput,
  CardMaterialField,
  CvvHandling,
  DaemonCardStoreOptions,
  PaymentsSecretStore,
} from './card-store.js';

export { DaemonPurchaseLedger, MAX_PURCHASE_LIST_LIMIT } from './purchase-ledger.js';
export type { DaemonPurchaseLedgerOptions, PurchaseListQuery, StoredPurchase } from './purchase-ledger.js';

export { DurableBudgetLedger } from './budget-store.js';

export { DaemonApprovalStore } from './approval-store.js';
export type { ApprovalTakeHit, ApprovalTakeMiss } from './approval-store.js';

export { DurableCheckoutJournal } from './checkout-journal-store.js';

export { CHECKOUT_APPROVAL_ACTION, checkoutApprovalContent } from './checkout-handlers.js';

export { configBackedAddressStore } from './address-store.js';

export { channelBackedPaymentNotifier } from './notifier.js';

export {
  HandlerError,
  REQUIRE_CONFIRM,
  assertConfirmed,
  normalizeContext,
  registerCatalogHandler,
  registerCatalogHandlers,
} from './handler-plumbing.js';
export type {
  CatalogHandlerEntry,
  HandlerContextEnvelope,
  HandlerInvocation,
  RegisterHandlerOptions,
  TypedHandler,
  Unregister,
} from './handler-plumbing.js';

export {
  ATTACHED_PAYMENTS_METHOD_IDS,
  UNATTACHED_PAYMENTS_METHOD_IDS,
  registerPaymentsMethods,
} from './register.js';
export type { CheckoutComposition, PaymentsHandlerDeps, PaymentsRegistration } from './register.js';
