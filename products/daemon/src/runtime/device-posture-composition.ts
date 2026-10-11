/**
 * device-posture-composition.ts, the paired-phone feature inside THIS daemon.
 *
 * A phone pairs with whichever daemon the person runs. Until this module
 * existed this daemon had no device posture at all: `device.nodes.maxPaired`
 * was enforced at the pairing path (SDK-side) and `device.capabilities.mode`
 * was an onboarding toggle, while the other eleven `device.*` keys were
 * recorded, read back, and governed nothing, the capability service they
 * describe was never built here, so there was nothing for them to govern.
 *
 * The feature itself is platform-owned (`platform/devices`): the settings→policy
 * mapping, the grants ledger, the capture store, the housekeeping sweeps, the
 * confirmation flow, and the `phone` tool. This module supplies the three seams
 * that are actually ours and nothing else:
 *
 *   - the peer transport, the same DistributedRuntimeManager the remote surface
 *     pairs devices onto, so a phone paired here is a node here,
 *   - the approval path, the shared approval broker, so the confirmation
 *     appears wherever the person is looking (terminal, web app, companion),
 *   - the storage root and the live config manager.
 *
 * Constructing this starts nothing. `startHousekeeping()` is called from the
 * bootstrap tail: grants and captures both outlive a restart, so a grant whose
 * phone is gone, or a capture torn by a crash, is reaped BEFORE the first
 * request of this run is served, and the periodic sweep after it is what keeps
 * a long-running daemon from going days without one. A failed sweep is logged
 * and the app still runs: housekeeping failing is a reason to say so, not a
 * reason to refuse to start.
 */
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { createDevicePostureRuntime, registerDevicePhoneTool } from '@goodvibes-jev/engine/sdk/platform/devices';
import type {
  DeviceApprovalBridge,
  DevicePeerTransport,
  DevicePhoneToolRegistry,
  DevicePostureRuntime,
} from '@goodvibes-jev/engine/sdk/platform/devices';
import { registerDevicesGatewayMethods } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { GatewayMethodCatalog } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';

/** Who this surface records in the device audit trail. */
export const DAEMON_DEVICE_ACTOR = 'daemon:phone-tool';

export interface DevicePostureCompositionOptions {
  readonly configManager: ConfigManager;
  readonly judgmentPort?: JudgmentPort | undefined;
  readonly signal?: AbortSignal | undefined;
  /** The runtime devices pair onto; its listPeers/invokePeer are the transport. */
  readonly distributedRuntime: DevicePeerTransport;
  readonly approvals: DeviceApprovalBridge;
  /** Surface-scoped directory the grants ledger, captures and disclosure live in. */
  readonly stateDirectory: string;
  /**
   * Binding the catalog turns the whole devices.* family from
   * cataloged-but-unhandled into real handlers: nodes.list, grants.*,
   * housekeeping.run, and, since a surface with no device runtime of its own
   * could read the grants and never open a camera, capability.request and
   * artifacts.list/read. That is what makes the paired phone usable from the web
   * app and the companion rather than only through this process's own tool.
   *
   * The runtime is handed over whole because the verbs and the tool must reach
   * the SAME service: a second path to a phone would be a second place the
   * confirmation prompt and the durable grants could be decided differently.
   */
  readonly gatewayMethods?: GatewayMethodCatalog | undefined;
  readonly getSessionId?: (() => string | undefined) | undefined;
}

export interface DevicePostureServices {
  readonly devicePosture: DevicePostureRuntime;
}

/** Build the device posture runtime and bind the device verbs to it. */
export function createDevicePostureServices(options: DevicePostureCompositionOptions): DevicePostureServices {
  const devicePosture = createDevicePostureRuntime({
    transport: options.distributedRuntime,
    approvals: options.approvals,
    config: options.configManager,
    stateDirectory: options.stateDirectory,
    actor: DAEMON_DEVICE_ACTOR,
    autonomous: { port: options.judgmentPort, signal: options.signal,
      onDidInvalidate: listener => options.configManager.onDidInvalidate(listener),
    },
    ...(options.getSessionId ? { getSessionId: options.getSessionId } : {}),
  });
  if (options.gatewayMethods) registerDevicesGatewayMethods(options.gatewayMethods, devicePosture);
  return { devicePosture };
}

/**
 * Everything a host with a tool registry has to do once it is up: register the
 * `phone` tool, the only path that reaches the capability service, so without it
 * the posture keys govern nothing a session can observe, and start housekeeping.
 *
 * One call, because these two belong to the same feature and a host that did the
 * first and forgot the second would serve requests while never reaping a grant
 * whose phone is gone.
 */
export function installDevicePosture(
  toolRegistry: DevicePhoneToolRegistry,
  devicePosture: DevicePostureRuntime,
): void {
  registerDevicePhoneTool(toolRegistry, devicePosture);
  startDeviceHousekeeping(devicePosture);
}

/**
 * The recovery sweep plus the periodic timer. Separate from construction so
 * composing a runtime in a test starts no timer and touches no disk, and
 * separate from the call above so this daemon, which registers no tools,
 * still sweeps.
 */
export function startDeviceHousekeeping(devicePosture: DevicePostureRuntime): void {
  void devicePosture.startHousekeeping().catch((error: unknown) => {
    logger.warn('Device housekeeping sweep failed at startup', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
