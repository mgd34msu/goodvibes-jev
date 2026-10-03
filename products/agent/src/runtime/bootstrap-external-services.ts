/**
 * Connected-host (daemon + HTTP listener) discovery for GoodVibes Agent.
 *
 * Split out of bootstrap.ts (which is near the 800-line architecture cap) to
 * keep this concern, and the Agent's daemon-lifecycle boundary, in one
 * small, readable place.
 *
 * Discovery routes through the SDK-shared adopt-or-spawn policy
 * (decideDaemonAdoption/classifyDaemonProbe) with `adoptOnly: true`, so a
 * reachable, version-compatible daemon is adopted and anything else (absent,
 * blocked, or on an incompatible wire version) is reported honestly. The
 * Agent never spawns or embeds a daemon of its own and never restarts a
 * running one. One bounded exception at boot: when discovery finds nothing
 * on the configured port but the host's service entry IS installed on this
 * machine, the Agent issues a single start through the platform service
 * manager, waits a bounded time for the daemon to answer, re-probes, and
 * reports what it did (the SDK's autostartInstalledDaemon decides and acts;
 * the wording below is the Agent's). A machine with the host installed but
 * stopped must not hand the user homework.
 */
import { startExternalServices } from '@/runtime/index.ts';
import {
  autostartInstalledDaemon,
  createDaemonServiceControl,
  type DaemonServiceControl,
} from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { SpineReachability } from '@goodvibes-jev/engine/sdk/platform/runtime/session-spine';
import type {
  DeferredStartupCoordinator,
  ExternalServicesHandle,
  HostServiceStatus,
  HostServicesConfig,
  RuntimeEventBus,
} from '@/runtime/index.ts';
import type { HookDispatcher } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { logger, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import type { RuntimeServices } from './services.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { connectedHostBaseUrl } from '../config/connected-host-dial.ts';

/**
 * This is a PROBE address, so it goes through the same wildcard→loopback
 * mapping every other dial site uses (config/connected-host-dial.ts) rather
 * than keeping a second, subtly different copy of it.
 */
function formatHostServiceBaseUrl(host: string, port: number): string {
  return connectedHostBaseUrl(host, port);
}

// Pending status shown before the deferred probe completes, honest
// 'unavailable', never a guessed 'external'.
function createPendingServiceStatus(
  configManager: HostServicesConfig,
  service: 'daemon' | 'httpListener',
): HostServiceStatus {
  const host = String(configManager.get(service === 'daemon' ? 'controlPlane.host' : 'httpListener.host') ?? '127.0.0.1');
  const port = Number(configManager.get(service === 'daemon' ? 'controlPlane.port' : 'httpListener.port') ?? (service === 'daemon' ? 3421 : 3422));
  return {
    mode: 'unavailable',
    host,
    port,
    baseUrl: formatHostServiceBaseUrl(host, port),
    reason: 'Connected-host discovery has not completed yet',
  };
}

const hostServiceIsActive = (status: HostServiceStatus): boolean => status.mode === 'embedded' || status.mode === 'external';

// 'blocked' (occupied by an unverified process) and 'incompatible' (a
// GoodVibes daemon on a wire-version band this Agent build refuses to adopt)
// both mean the configured port is held and unusable by this instance.
const hostServiceIsBlocked = (status: HostServiceStatus): boolean => status.mode === 'blocked' || status.mode === 'incompatible';

export interface AgentExternalServicesController {
  /** The most recently resolved (or pending) connected-host status. */
  getStatus(): ExternalServicesHandle;
  /**
   * Resolves once the deferred boot discovery (including any boot-time start
   * of an installed-but-stopped host) has settled. Later probes that reuse
   * the daemon's reachability (session/memory spine adoption) await this so
   * they see the post-discovery daemon state instead of racing it.
   */
  whenDiscovered(): Promise<void>;
  stop(): Promise<void>;
}

/** Test seams for the boot-time start of an installed-but-stopped host. */
export interface ConnectedHostAutostartSeams {
  readonly control?: DaemonServiceControl;
  readonly probeReachability?: () => Promise<SpineReachability>;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function wireAgentExternalServices(options: {
  readonly configManager: HostServicesConfig;
  readonly runtimeBus: RuntimeEventBus;
  readonly hookDispatcher: HookDispatcher;
  readonly services: RuntimeServices;
  readonly uiServices: UiRuntimeServices;
  readonly deferredStartup: DeferredStartupCoordinator;
  readonly systemMessageRouter: SystemMessageRouter;
  readonly requestRender: () => void;
  /** Injectable discovery implementation (tests); defaults to the SDK-shared policy. */
  readonly startServices?: typeof startExternalServices;
  readonly connectedHostAutostart?: ConnectedHostAutostartSeams;
}): AgentExternalServicesController {
  const { configManager, runtimeBus, hookDispatcher, services, uiServices, deferredStartup, systemMessageRouter, requestRender } = options;
  const startServices = options.startServices ?? startExternalServices;

  // Connected-host honesty receipts ("updated from X to Y", "restarted after
  // a crash at HH:MM", settings migrations) captured off the once-per-attach
  // ?receipts=consume /status read (bootstrap.ts's memory-spine onAttach):
  // delivery at the daemon is destructive (served once, to the consuming
  // reader), so every captured receipt renders here, buffered ones from before
  // this sink attaches flush immediately.
  services.daemonReceiptFeed.attach((receipt) => {
    systemMessageRouter.high(`[Connected host] ${receipt.text}`);
    requestRender();
  });

  // Idle-time memory-consolidation run receipts (services.ts's local
  // scheduler): the SAME buffered-until-attach, exactly-once idiom as the
  // connected-host receipts just above, on its own feed so a local
  // consolidation run is never mislabeled "[Connected host]".
  services.memoryConsolidationReceiptFeed.attach((receipt) => {
    systemMessageRouter.high(`[Memory] ${receipt.text}`);
    requestRender();
  });

  const inspectAgentDependencies = () => {
    const daemonStatus = externalServices.daemonStatus;
    const httpListenerStatus = externalServices.httpListenerStatus;
    return {
      connectedHostRunning: hostServiceIsActive(daemonStatus),
      connectedHostPortInUse: hostServiceIsBlocked(daemonStatus),
      httpListenerRunning: hostServiceIsActive(httpListenerStatus),
      httpListenerPortInUse: hostServiceIsBlocked(httpListenerStatus),
      connectedHostStatus: daemonStatus,
      httpListenerStatus,
    };
  };

  let externalServices: ExternalServicesHandle = {
    daemonServer: null,
    httpListener: null,
    daemonStatus: createPendingServiceStatus(configManager, 'daemon'),
    httpListenerStatus: createPendingServiceStatus(configManager, 'httpListener'),
    listRecentControlPlaneEvents: () => [],
    async stop(): Promise<void> {},
  };
  let externalServicesPromise: Promise<ExternalServicesHandle> | null = null;

  // Deliberately NOT passing the daemon facade's `updateArtifact` identity
  // ({version, execPath}): with adoptOnly the agent never constructs or embeds
  // a DaemonServer, so there is no daemon-side hourly update loop here to feed
  //, absent means host-managed, which is exactly the agent's stance toward
  // whichever host it adopts. The agent's OWN binary updates at launch through
  // its launch auto-update path instead (src/cli/launch-auto-update.ts).
  const startAgentExternalServices = (): Promise<ExternalServicesHandle> =>
    // The daemon-grade view, because this SDK entry point still takes that
    // whole shape. Under `adoptOnly: true` it reads `localUserAuthManager` and
    // `configManager` and never constructs a DaemonServer, see the view's own
    // doc comment in runtime/services.ts for exactly which two members it
    // substitutes and why neither is dereferenced here.
    startServices(configManager, runtimeBus, hookDispatcher, services.asDaemonGradeView(), { adoptOnly: true });

  // Boot-time start of an installed-but-stopped host: when discovery found
  // nothing on the configured port, check the platform service manager for an
  // installed host entry, start it once, wait a bounded time, and re-probe.
  // Every skip/failure path is honest; errors here never break discovery.
  const maybeStartInstalledConnectedHost = async (): Promise<void> => {
    const seams = options.connectedHostAutostart ?? {};
    try {
      const probeReachability = seams.probeReachability
        ?? (() => services.sessionSpineClient.probeReachability());
      const outcome = await autostartInstalledDaemon({
        daemonMode: externalServices.daemonStatus.mode,
        control: seams.control ?? createDaemonServiceControl({
          configManager: services.configManager,
          workingDirectory: services.workingDirectory,
          homeDirectory: services.homeDirectory,
        }),
        isReachable: async () => (await probeReachability()) === 'online',
        waitTimeoutMs: seams.waitTimeoutMs,
        pollIntervalMs: seams.pollIntervalMs,
        sleep: seams.sleep,
      });
      switch (outcome.action) {
        case 'started':
        case 'came-online': {
          externalServicesPromise = startAgentExternalServices();
          externalServices = await externalServicesPromise;
          const adopted = externalServices.daemonStatus.mode === 'external';
          const suffix = adopted
            ? ''
            : `, but adopting it still failed: ${externalServices.daemonStatus.reason ?? externalServices.daemonStatus.mode}`;
          systemMessageRouter.low(outcome.action === 'started'
            ? `[Startup] Connected host was installed but stopped; started it (service "${outcome.serviceName}")${suffix}.`
            : `[Startup] Connected host service "${outcome.serviceName}" was already starting; connected once it answered${suffix}.`);
          break;
        }
        case 'start-failed': {
          systemMessageRouter.high(`[Startup] Connected host is installed but not answering, and starting it did not succeed: ${outcome.reason}. Start it manually with: goodvibes service start`);
          break;
        }
        case 'not-installed':
        case 'none':
          break;
      }
    } catch (error) {
      logger.debug('Boot-time connected-host start check failed', { error: summarizeError(error) });
    }
  };

  const platformExternalServices = uiServices.platform as typeof uiServices.platform & {
    externalServices: NonNullable<typeof uiServices.platform.externalServices>;
  };
  platformExternalServices.externalServices = {
    inspect: inspectAgentDependencies,
    restart: async () => {
      if (externalServicesPromise) {
        try {
          externalServices = await externalServicesPromise;
        } catch {
          // A failed previous startup should not prevent a re-probe attempt.
        }
      }
      await externalServices.stop();
      externalServicesPromise = startAgentExternalServices();
      externalServices = await externalServicesPromise;
      systemMessageRouter.high('[Startup] GoodVibes Agent re-probed the connected GoodVibes host and adopted its current status; this route never starts or restarts the host itself.');
      requestRender();
      return inspectAgentDependencies();
    },
  };

  // Connected-host discovery OFF the interactive path: probe the configured
  // host/port through the shared adopt-or-spawn policy (adoptOnly, Agent
  // never spawns or embeds) and replace the pending status with an honest
  // one (adopted, incompatible, blocked, or unavailable). An unavailable
  // daemon then gets the one bounded installed-but-stopped start check.
  const discoveryComplete = deferredStartup.schedule({
    label: 'external-services',
    run: async () => {
      externalServicesPromise = startAgentExternalServices();
      externalServices = await externalServicesPromise;
      await maybeStartInstalledConnectedHost();
      requestRender();
    },
    onError: (error) => {
      const message = summarizeError(error);
      logger.error('Deferred connected-host discovery failed', { error: message });
      systemMessageRouter.high(`[Startup] Connected-host discovery failed: ${message}`);
      requestRender();
    },
  });

  return {
    getStatus: () => externalServices,
    whenDiscovered: () => discoveryComplete,
    stop: async () => {
      await externalServices.stop();
    },
  };
}
