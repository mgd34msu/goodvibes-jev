/** Product host surfaces over canonical engine implementations. */
import type { EmailService } from '@goodvibes-jev/engine/sdk/platform/email';
import { registerOwnedMailInbox } from './owned-inbox-mail.js';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createDaemonCredentialStore } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ClusterCoordinator } from '@goodvibes-jev/engine/sdk/platform/cluster';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { registerRoutingMethods, registerDraftMethods, type ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import { registerRemoteSurface } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { InboxPollingControl, RegisterInboxSurfaceOptions } from '@goodvibes-jev/engine/sdk/platform/intake';
import { registerDaemonHandlers, type DaemonHandlerSurfaces, type RoutingRegistration } from '../daemon/handlers/index.js';
import type { HandlerContext, HandlerLogger, OwnedHandlerSurface } from '../daemon/handlers/context.js';
import { createPaymentsServices } from './payments-composition.js';
import { inboxPollerGate } from './cluster-composition.js';
import type { ShellPathService } from './index.js';
import type { SecretsManager } from '../config/secrets.js';
import type { BrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.js';

/**
 * Required while the built-in adapter/triage product port remains incomplete.
 * Tests supply fixture adapters to the real inbox registrar. There is no empty
 * production default and this seam is not evidence of built-in provider parity.
 */
export interface DaemonInboxControls extends Required<Pick<RegisterInboxSurfaceOptions, 'gatePolling'>> {
  /** Explicit awaitable election withdrawal for account-verified clustered owners. */
  readonly gatePollingOwned?: (providerId: string, control: InboxPollingControl) => () => Promise<void>;
  /** Subscribe to local config/credential revocation without exposing secrets. */
  readonly onAccountInvalidation?: (listener: () => void) => () => void;
  /** Trusted root-owned constructor; no credentials or generic secret access escape. */
  readonly createEmailService?: () => { readonly service: EmailService; close(): void };
}

export type DaemonInboxFactory = (
  context: HandlerContext,
  routing: RoutingRegistration,
  options: DaemonInboxControls,
) => OwnedHandlerSurface | Promise<OwnedHandlerSurface>;

export interface DaemonHandlerCompositionOptions {
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly secretsManager: SecretsManager;
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly shellPaths: ShellPathService;
  readonly distributedRuntime: NonNullable<Parameters<typeof registerRemoteSurface>[1]>['manager'];
  /** Startup is owned by the root, not by the borrowed remote surface. */
  readonly distributedRuntimeReady: Promise<void>;
  readonly clusterCoordinator: ClusterCoordinator;
  readonly checkoutSeam: BrowserCheckoutSeamHolder['get'];
  readonly channelDeliveryRouter: Pick<ChannelDeliveryRouter, 'deliver'>;
  readonly inboxFactory: DaemonInboxFactory;
}

/** Return only after each real surface is ready; failed acquisition rolls back. */
export async function createDaemonHandlerComposition(
  options: DaemonHandlerCompositionOptions,
): Promise<DaemonHandlerSurfaces> {
  if (typeof options.inboxFactory !== 'function') {
    throw new Error('An explicit daemon inbox factory is required until built-in provider composition is restored.');
  }
  const handlerLogger: HandlerLogger = {
    info: (message, meta) => console.info(message, meta ?? ''),
    warn: (message, meta) => console.warn(message, meta ?? ''),
    error: (message, meta) => console.error(message, meta ?? ''),
  };
  const handlerContext: HandlerContext = {
    catalog: options.gatewayMethods,
    credentials: createDaemonCredentialStore(options.secretsManager),
    configManager: options.configManager,
    workingDirectory: options.workingDirectory,
    homeDirectory: options.homeDirectory,
    logger: handlerLogger,
  };
  return registerDaemonHandlers(handlerContext, {
    registerRouting: registerRoutingMethods,
    registerInbox: (ctx, routing) => registerOwnedMailInbox(options.inboxFactory, ctx, routing, {
      // Each provider is elected separately; standby nodes still serve storage.
      gatePolling: (providerId, control) => options.clusterCoordinator.register(inboxPollerGate(providerId, control)),
      gatePollingOwned: (providerId, control) => options.clusterCoordinator.registerOwned(inboxPollerGate(providerId, control)),
    }, { configManager: options.configManager, secretsManager: options.secretsManager }),
    registerDrafts: registerDraftMethods,
    registerPayments: () => createPaymentsServices({
      gatewayMethods: options.gatewayMethods,
      configManager: options.configManager,
      secretsManager: options.secretsManager,
      shellPaths: options.shellPaths,
      // No payments election exists. Clustering off is the single-owner case;
      // a clustered node cannot claim spending leadership from inbox ownership.
      isPaymentsLeader: () => !options.clusterCoordinator.enabled,
      checkoutSeam: options.checkoutSeam,
      channelDeliveryRouter: options.channelDeliveryRouter,
    }),
    registerRemote: (ctx) => registerRemoteSurface(ctx, {
      manager: options.distributedRuntime,
      managerReady: options.distributedRuntimeReady,
    }),
  });
}
