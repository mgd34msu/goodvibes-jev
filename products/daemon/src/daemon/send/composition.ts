/** One-shot delivery owners; no daemon graph, listener, poller or notification queue. */
import { ChannelDeliveryRouter } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ServiceRegistry, SubscriptionManager, sharedSubscriptionsPath } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { SecretsManager } from '../../config/secrets.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import type { DaemonCliConfiguration } from '../../cli/configuration.js';
import type { SendDeliver } from './command.js';

/** Call only after parsing, channel/gate admission and complete message acquisition. */
export function createSendStack(configuration: DaemonCliConfiguration): { readonly deliver: SendDeliver } {
  const { config, workingDirectory, homeDirectory, daemonHomeDirectory } = configuration;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const secretsManager = new SecretsManager({
    projectRoot: workingDirectory, globalHome: homeDirectory,
    daemonHome: daemonHomeDirectory, configManager: config, diagnosticMode: 'structural',
  });
  const serviceRegistry = new ServiceRegistry(shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'services.json'), {
    secretsManager, diagnosticMode: 'structural',
    // Secret resolution does not consult subscriptions. One-shot send must not
    // trigger an unrelated legacy subscription migration while acquiring them.
    subscriptionManager: new SubscriptionManager(sharedSubscriptionsPath(shellPaths)),
  });
  const router = new ChannelDeliveryRouter({ configManager: config, secretsManager, serviceRegistry,
    artifactStore: new ArtifactStore({ configManager: config }) });
  return { deliver: (request) => router.deliver(request) };
}
