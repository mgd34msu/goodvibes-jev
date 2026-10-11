/** CI gateway composition. Every repair uses a live source owner and recorded Jev admission. */
import { startAdmittedCiRepair } from '../../ci-watch/autonomous.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { ConfigKey } from '../../config/schema.js';
import { registerCiGatewayMethods } from './ci.js';
import { startCiFixSession } from './seeded-sessions.js';
import {
  CiWatchAutoMinter,
  CiWatchService,
  CiWatchStore,
  createGhCliCiSource,
  registerCiWatchPolling,
} from '../../ci-watch/index.js';
import { parseChannelDeliveryTarget } from '../../channels/delivery/types.js';
import { logger } from '../../utils/logger.js';
import type { GatewayVerbGroupDeps } from './register-gateway-verb-groups.js';
import { controlPlaneStorePath } from '../control-plane-store-paths.js';

/** Exactly the deps this composition reads, a slice of the registrar's own. */
export type CiWatchCompositionDeps = Pick<
  GatewayVerbGroupDeps,
  | 'shellPaths'
  | 'surfaceRoot'
  | 'channelDeliveryRouter'
  | 'automationManager'
  | 'stampFixSessionOnApproval'
  | 'requestApproval'
  | 'ciAutonomousHost'
  | 'ciNativeContinuationOwner'
  | 'ciNativeContinuationRevocation'
  | 'onCiAutoWatch'
  | 'workingDirectory'
  | 'watcherRegistry'
  | 'configManager'
>;

/**
 * CI-watch: the per-job status tool + standing subscriptions. The gh-CLI
 * source and the watch store are always available; the completion notifier
 * binds to the channel delivery router when present. Missing source ownership,
 * judgment, or automation refuses repair without creating an approval ask.
 */
export function composeCiWatchGatewayVerbs(catalog: GatewayMethodCatalog, deps: CiWatchCompositionDeps): void {
  const ciWatchService = new CiWatchService({
    recoverOwner: deps.ciNativeContinuationOwner,
    revokeOwner: deps.ciNativeContinuationRevocation,
    source: createGhCliCiSource(),
    store: new CiWatchStore(controlPlaneStorePath(deps.shellPaths, deps.surfaceRoot, 'ci-watches.json')),
    ...(deps.channelDeliveryRouter
      ? {
        notifier: async (channel: string, title: string, body: string): Promise<string | undefined> =>
          deps.channelDeliveryRouter!.deliver({
            target: parseChannelDeliveryTarget(channel),
            body,
            title,
            jobId: 'ci-watch',
            runId: `ci-${Date.now()}`,
            includeLinks: false,
          }),
      }
      : {}),
    autonomousRepair: input => startAdmittedCiRepair(deps.ciAutonomousHost?.(), input,
      brief => deps.automationManager ? startCiFixSession(deps.automationManager, brief)
        : Promise.resolve({ error: 'CI repair automation is unavailable' })),
  });
  registerCiGatewayMethods(catalog, ciWatchService);
  // Self-minting at the push seam: a successful exec containing `git push` /
  // `gh pr create` mints a watch for the pushed branch (delivery defaults to
  // the operator web surface; the watch retires itself after its verdict).
  if (deps.onCiAutoWatch && deps.workingDirectory) {
    const autoMinter = new CiWatchAutoMinter({ service: ciWatchService, workingDirectory: deps.workingDirectory });
    deps.onCiAutoWatch((toolName, args, success) => autoMinter.onToolExecuted(toolName, args, success));
  }
  // The daemon polls registered watches on the watchers.ciPollIntervalMs
  // cadence (15s floor, sequential passes, overlap-guarded) via the existing
  // watcher-registry polling machinery, a standing watch no longer stands
  // still until someone runs the manual verb. When the watcher framework is
  // turned off (watchers.enabled false) the poll is honestly skipped: the
  // manual ci.watches.run verb still works, so nothing is silently faked.
  // Defensive config access: some conformance/composition callers pass a
  // partial deps object at runtime (see terminal-shell's ws-only attachment).
  const readConfig = (key: string): unknown => deps.configManager?.get(key as ConfigKey);
  const watchersEnabled = readConfig('watchers.enabled') !== false;
  if (deps.watcherRegistry && watchersEnabled) {
    const configuredCadence = readConfig('watchers.ciPollIntervalMs');
    try {
      registerCiWatchPolling(deps.watcherRegistry, ciWatchService, {
        ...(typeof configuredCadence === 'number' ? { intervalMs: configuredCadence } : {}),
      });
    } catch (error) {
      // A gated/refusing watcher registry must never fail daemon composition,
      // CI watches degrade to the manual verb, stated honestly in the log.
      logger.warn('[ci-watch] recurring poll not registered; watches run via the manual verb only', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
