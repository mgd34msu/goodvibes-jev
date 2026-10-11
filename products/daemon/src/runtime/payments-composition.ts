/**
 * The daemon-owned payments capability, adapted from pinned daemon 443e5ee.
 *
 * Stores retain the existing surface-scoped paths and daemon-tier secret port.
 * The browser seam is read lazily because browser composition runs later.
 * Merchant semantics use the registered Jev reading, never the retired prompt
 * adapter. The returned inbox is the exact source used by the notifier: the
 * root must pass it to DaemonConfig.paymentReplies for channel ingress.
 *
 * This composition owns that inbox. Stop ingress, then await close before
 * releasing the graph or registering replacement handlers. A facade listener
 * restart borrows the inbox and must not close it. close drains registration
 * and accepted reply readings; it does not claim to drain browser operations
 * already admitted by the gateway, which remain the root's responsibility.
 */
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { controlPlaneStorePath } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createJevMerchantJudge, readCvvHandling, PaymentReplyInbox } from '@goodvibes-jev/engine/sdk/platform/payments';
import type { BudgetLedger, PaymentsConfigReader } from '@goodvibes-jev/engine/sdk/platform/payments';
import { getProcessUntrustedContentLedger } from '@goodvibes-jev/engine/sdk/platform/security';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import type { SecretsManager } from '../config/secrets.js';
import type { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { ShellPathService } from './index.js';
import {
  DaemonApprovalStore,
  DaemonCardStore,
  DaemonPurchaseLedger,
  DurableBudgetLedger,
  DurableCheckoutJournal,
  channelBackedPaymentNotifier,
  configBackedAddressStore,
  registerPaymentsMethods,
  type CheckoutComposition,
  type PaymentsSecretStore,
} from '@goodvibes-jev/engine/sdk/platform/payments';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import type { BrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.js';

export interface PaymentsCompositionOptions {
  readonly configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'preparePostalAddress'>>;
  readonly shellPaths: ShellPathService;
  readonly secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete'>;
  /** Binding the catalog is what turns the family from a 501 facade into handlers. */
  readonly gatewayMethods: GatewayMethodCatalog;
  /**
   * Whether this node is the one currently allowed to spend.
   *
   * Reported by `payments.budget.status` and never defaulted, see the SDK's
   * gates.ts: on a clustered install the wrong answer is a double-spend.
   */
  readonly isPaymentsLeader: () => boolean;
  /** Where the checkout pair reads the browser-checkout seam; see this file's header. */
  readonly checkoutSeam: BrowserCheckoutSeamHolder['get'];
  /** Delivers a purchase notice; the SAME router every other channel send in this daemon uses. */
  readonly channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver'>;
}

export interface PaymentsServices {
  readonly cards: DaemonCardStore;
  readonly purchases: DaemonPurchaseLedger;
  readonly budget: BudgetLedger;
  /**
   * Resolves once every payments verb is attached; the SDK runs its boot
   * recovery sweep first, so attachment lands a beat after composition.
   * Rejects if attaching the daemon's local handlers failed, so whoever drops
   * this promise must handle that (daemon-handler-composition.ts logs it).
   */
  readonly ready: Promise<void>;
  /** Borrowed by DaemonConfig; this payment composition owns its lifetime. */
  readonly paymentReplies: PaymentReplyInbox;
  /** Await before handing this catalog to a replacement composition. */
  readonly close: () => Promise<void>;
  /** Legacy synchronous teardown; new composition roots must await close. */
  readonly unregister: () => void;
}

/**
 * The narrow secret port the card store gets: three operations over the daemon
 * tier, and no way to reach any other credential in the process. The same
 * treatment cluster-group-composition.ts gives the group key.
 */
function daemonScopedSecrets(secretsManager: Pick<SecretsManager, 'get' | 'set' | 'delete'>): PaymentsSecretStore {
  return {
    get: (key) => secretsManager.get(key),
    set: async (key, value) => {
      await secretsManager.set(key, value, { scope: 'daemon', medium: 'secure' });
    },
    delete: async (key) => {
      await secretsManager.delete(key, { scope: 'daemon' });
    },
  };
}

/** Read live, per call: a budget raised five minutes ago applies to the next read. */
function livePaymentsConfig(configManager: Pick<ConfigManager, 'get'>): PaymentsConfigReader {
  return { get: (key: string) => configManager.get(key as Parameters<ConfigManager['get']>[0]) };
}

/**
 * Build the payment stores and bind the answerable verbs to them.
 *
 * The card and purchase stores read lazily and write only when a verb asks
 * them to, so composing either by itself creates no file activity. The budget
 * ledger is different: `DurableBudgetLedger`'s constructor reads
 * `payments-budget.json` synchronously to load today's pools
 * (daemon/handlers/payments/budget-store.ts), so constructing the result of
 * THIS function does touch disk, once, for that one file, before any verb is
 * ever called.
 */
export function createPaymentsServices(options: PaymentsCompositionOptions): PaymentsServices {
  const config = livePaymentsConfig(options.configManager);
  const paymentReplies = new PaymentReplyInbox();
  const cards = new DaemonCardStore({
    filePath: controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-cards.json'),
    secrets: daemonScopedSecrets(options.secretsManager),
    cvvHandling: () => readCvvHandling(config),
  });
  const purchases = new DaemonPurchaseLedger({
    filePath: controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-purchases.json'),
  });
  const budget = new DurableBudgetLedger(
    controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-budget.json'),
  );
  const checkout: CheckoutComposition = {
    seam: options.checkoutSeam,
    addresses: configBackedAddressStore(config, options.configManager.preparePostalAddress?.bind(options.configManager)),
    notifier: channelBackedPaymentNotifier(config, options.channelDeliveryRouter, paymentReplies),
    merchantJudge: createJevMerchantJudge(),
    untrusted: getProcessUntrustedContentLedger(),
    // The persisted owner approvals `payments.checkout.approve` mints and
    // `begin` spends, beside the other payments stores. Constructing it reads
    // the file once, synchronously, the same one-touch boot cost the budget
    // ledger already pays.
    approvals: new DaemonApprovalStore(
      controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-approvals.json'),
    ),
    // The durable in-flight checkout journal. Every phase write the registry
    // makes, the `submit-pending` flush before the merchant submit included,
    // lands here before the flow proceeds, so a crash in the one ambiguous
    // window leaves a record a restart can disclose instead of nothing.
    journal: new DurableCheckoutJournal(
      controlPlaneStorePath(options.shellPaths, GOODVIBES_DAEMON_SURFACE_ROOT, 'payments-checkout-journal.json'),
    ),
  };
  const registration = registerPaymentsMethods(options.gatewayMethods, {
    cards,
    purchases,
    budget,
    config,
    isPaymentsLeader: options.isPaymentsLeader,
    checkout,
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    // Both stop admissions synchronously, before waiting for accepted work.
    const repliesClosed = paymentReplies.close();
    const errors: unknown[] = [];
    try { registration.unregister(); } catch (error) { errors.push(error); }
    closing = Promise.allSettled([registration.ready, repliesClosed]).then((results) => {
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      if (errors.length > 0) {
        // Fixed diagnostic only: underlying failures can contain owned paths.
        try { logger.warn('Payment composition did not close cleanly', { failureCount: errors.length }); } catch { /* Preserve the cleanup failure. */ }
        throw new AggregateError(errors, 'Payment composition did not close cleanly');
      }
    });
    // Legacy void callers must not cause unhandled rejection. Awaiting the
    // same promise still reports cleanup failures to the new composition root.
    void closing.catch(() => {});
    return closing;
  };
  return {
    cards, purchases, budget, paymentReplies, ready: registration.ready, close,
    unregister: () => { void close(); },
  };
}
