/** The shipped daemon's host capabilities; construction itself starts no work. */
import { createHostPowerSeam } from '@goodvibes-jev/engine/sdk/platform/power';
import { createProductionDaemonInboxFactory, type ProductionDaemonInboxOptions } from '../runtime/production-inbox-composition.js';
import type { DaemonCliRuntime } from './serve.js';

/** Trusted embedders may admit protected Slack/email accounts explicitly. */
export function createProductionDaemonRuntime(inbox: ProductionDaemonInboxOptions = {}): DaemonCliRuntime {
  return {
    inboxFactory: createProductionDaemonInboxFactory(inbox),
    // Preserve the pinned standalone daemon's host-only choices. One-shot
    // commands never construct the service graph or start these capabilities.
    observeExternalAgents: true,
    powerSeam: createHostPowerSeam(),
    provisionWakeModelsAtBoot: true,
    // Authentication and captured ordinary-Bun identity retain their canonical
    // selected-home/packaging defaults; never substitute this compiled binary.
  };
}
