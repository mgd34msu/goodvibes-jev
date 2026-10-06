import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import net from 'node:net';
import { isAbsolute, join } from 'node:path';
import { resolveConnectedHostDialEnabled, resolveDaemonEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigKey, ConfigManager } from '../config/index.ts';
import { resolveRuntimeEndpointBinding } from './endpoints.ts';
import type { RuntimeEndpointBinding, RuntimeEndpointId } from './endpoints.ts';
import { classifyBindPosture, isNetworkFacing } from '@goodvibes-jev/engine/terminal-shell';
import { redactText } from './redaction.ts';
import { dialHostForConfiguredHost } from '../config/connected-host-dial.ts';

export interface CliServiceRuntime {
  readonly configManager: ConfigManager;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
}

export interface CliServiceEndpointPosture {
  readonly id: RuntimeEndpointId;
  readonly label: string;
  readonly enabled: boolean;
  readonly binding: RuntimeEndpointBinding;
  readonly bindPosture: ReturnType<typeof classifyBindPosture>;
  readonly networkFacing: boolean;
  readonly reachable?: boolean;
}

export interface CliServiceLogPosture {
  readonly path: string | null;
  readonly exists: boolean;
  readonly size: number;
  readonly modifiedAt: number | null;
  readonly tail?: string;
  readonly readError?: string;
}

export interface CliExternalHostLifecyclePosture {
  readonly platform: 'manual';
  readonly path: string;
  readonly installed: false;
  readonly autostart: false;
  readonly running: false;
  readonly logPath?: string;
  readonly commandPreview: string;
  readonly suggestedCommands: readonly string[];
  readonly lastAction: 'status';
  readonly actionError?: string;
  readonly pidPath: string;
  readonly lastError: null;
}

export interface CliServicePosture {
  readonly config: {
    readonly enabled: boolean;
    readonly autostart: boolean;
    readonly restartOnFailure: boolean;
    /** `daemon.enabled`, whether this surface adopts a session daemon of its own. */
    readonly daemonEnabled: boolean;
    /**
     * `daemon.connectedHost.enabled`, whether this surface may DIAL the host
     * it is connected to. Reported separately because it is what the
     * daemon-backed features actually consult; reporting only the adopt flag
     * described a machine that was not the one running.
     */
    readonly connectedHostDialEnabled: boolean;
  };
  readonly managed: CliExternalHostLifecyclePosture;
  readonly endpoints: readonly CliServiceEndpointPosture[];
  readonly log: CliServiceLogPosture;
  readonly issues: readonly string[];
  /**
   * Observations that describe the INTENDED arrangement rather than a fault.
   *
   * Kept apart from `issues` because everything in that array is rendered as a
   * problem, with a cause and an impact that say something may be unavailable.
   * That is the wrong sentence for a posture that is working as designed, and
   * the difference matters at release time: an advisory must not be able to
   * turn a strict verification red.
   */
  readonly advisories: readonly string[];
}

const ENDPOINTS: readonly { readonly id: RuntimeEndpointId; readonly label: string; readonly enabledKey: ConfigKey }[] = [
  { id: 'controlPlane', label: 'runtime connection', enabledKey: 'controlPlane.enabled' },
  { id: 'httpListener', label: 'inbound events endpoint', enabledKey: 'danger.httpListener' },
  { id: 'web', label: 'browser companion route', enabledKey: 'web.enabled' },
];

interface CliServicePostureOptions {
  readonly probe?: boolean;
  readonly logTailBytes?: number;
}

/** A TCP probe from this process, so a wildcard bind resolves to loopback. */
const connectHostForBindHost = dialHostForConfiguredHost;

async function probeTcp(host: string, port: number, timeoutMs = 750): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: connectHostForBindHost(host), port });
    const finish = (value: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function readLogPosture(path: string | undefined, tailBytes: number): CliServiceLogPosture {
  if (!path) return { path: null, exists: false, size: 0, modifiedAt: null };
  if (!existsSync(path)) return { path, exists: false, size: 0, modifiedAt: null };
  try {
    const stat = statSync(path);
    const length = Math.min(stat.size, Math.max(0, tailBytes));
    if (length === 0) {
      return { path, exists: true, size: stat.size, modifiedAt: stat.mtimeMs, tail: '' };
    }
    const raw = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, raw, 0, length, Math.max(0, stat.size - length));
    } finally {
      closeSync(fd);
    }
    return {
      path,
      exists: true,
      size: stat.size,
      modifiedAt: stat.mtimeMs,
      tail: redactText(raw.toString('utf-8')),
    };
  } catch (error) {
    return {
      path,
      exists: true,
      size: 0,
      modifiedAt: null,
      readError: error instanceof Error ? error.message : String(error),
    };
  }
}

function endpointsConflict(a: CliServiceEndpointPosture, b: CliServiceEndpointPosture): boolean {
  if (a.binding.port !== b.binding.port) return false;
  const hostA = a.binding.host;
  const hostB = b.binding.host;
  return hostA === hostB || hostA === '0.0.0.0' || hostB === '0.0.0.0' || hostA === '::' || hostB === '::';
}

function resolveConfiguredLogPath(runtime: CliServiceRuntime): string | undefined {
  const value = runtime.configManager.get('service.logPath');
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return isAbsolute(trimmed) ? trimmed : join(runtime.homeDirectory, trimmed);
}

function createExternalHostLifecycle(logPath: string | undefined): CliExternalHostLifecyclePosture {
  return {
    platform: 'manual',
    path: 'connected GoodVibes host',
    installed: false,
    autostart: false,
    running: false,
    ...(logPath ? { logPath } : {}),
    commandPreview: 'managed outside goodvibes-agent',
    suggestedCommands: [],
    lastAction: 'status',
    pidPath: 'connected GoodVibes host',
    lastError: null,
  };
}

export async function buildCliServicePosture(
  runtime: CliServiceRuntime,
  options: CliServicePostureOptions = {},
): Promise<CliServicePosture> {
  const endpoints = await Promise.all(ENDPOINTS.map(async (endpoint): Promise<CliServiceEndpointPosture> => {
    const enabled = runtime.configManager.get(endpoint.enabledKey) === true;
    const binding = resolveRuntimeEndpointBinding(runtime.configManager, endpoint.id);
    return {
      id: endpoint.id,
      label: endpoint.label,
      enabled,
      binding,
      bindPosture: classifyBindPosture(binding),
      networkFacing: isNetworkFacing(enabled, binding),
      ...(options.probe && enabled && resolveConnectedHostDialEnabled(runtime.configManager) ? { reachable: await probeTcp(binding.host, binding.port) } : {}),
    };
  }));

  const config = {
    enabled: runtime.configManager.get('service.enabled') === true,
    autostart: runtime.configManager.get('service.autostart') === true,
    restartOnFailure: runtime.configManager.get('service.restartOnFailure') === true,
    daemonEnabled: resolveDaemonEnabled(runtime.configManager),
    connectedHostDialEnabled: resolveConnectedHostDialEnabled(runtime.configManager),
  };
  // Dialing is what the daemon-backed features consult, so a machine that does
  // not adopt a daemon but does dial a connected one is server-backed, which
  // is exactly the topology this product is designed for.
  const serverBackedEnabled = config.daemonEnabled
    || config.connectedHostDialEnabled
    || endpoints.some((endpoint) => endpoint.enabled);
  const issues: string[] = [];
  const advisories: string[] = [];

  if (serverBackedEnabled && !config.enabled) {
    // Not a fault. The Agent is designed not to own the host, a connected
    // GoodVibes daemon does, so this is the normal topology, and it became
    // visible here only once the Agent began reading the shared daemon tier.
    advisories.push('Connected-host settings are present, but Agent host ownership is disabled by design.');
  }
  for (const endpoint of endpoints) {
    if (endpoint.enabled && options.probe && endpoint.reachable === false) {
      issues.push(`${endpoint.label} is enabled but not reachable on ${endpoint.binding.host}:${endpoint.binding.port}.`);
    }
  }
  const enabledEndpoints = endpoints.filter((endpoint) => endpoint.enabled);
  for (let outer = 0; outer < enabledEndpoints.length; outer += 1) {
    for (let inner = outer + 1; inner < enabledEndpoints.length; inner += 1) {
      const left = enabledEndpoints[outer]!;
      const right = enabledEndpoints[inner]!;
      if (endpointsConflict(left, right)) {
        issues.push(`${left.label} and ${right.label} are configured to bind the same host/port envelope (${left.binding.host}:${left.binding.port}, ${right.binding.host}:${right.binding.port}).`);
      }
    }
  }
  const configuredLogPath = resolveConfiguredLogPath(runtime);
  const log = readLogPosture(configuredLogPath, options.logTailBytes ?? 4096);
  if (log.readError) {
    issues.push(`Service log exists but could not be read: ${log.readError}`);
  }

  return {
    config,
    managed: createExternalHostLifecycle(configuredLogPath),
    endpoints,
    log,
    issues,
    advisories,
  };
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

export function formatCliServicePosture(posture: CliServicePosture, json = false): string {
  if (json) return JSON.stringify(posture, null, 2);
  return [
    'GoodVibes Agent connected-host diagnostics',
    '  lifecycle owner: outside goodvibes-agent',
    '  Agent starts connected host: only at boot, when it is installed but stopped',
    `  external host config present: ${yesNo(posture.config.enabled)}`,
    '  external host lifecycle config: only the service name is read, for the boot start check',
    `  adopts a daemon of its own: ${yesNo(posture.config.daemonEnabled)}`,
    `  may dial the connected host: ${yesNo(posture.config.connectedHostDialEnabled)}`,
    `  log: ${posture.log.path ?? 'n/a'} (${posture.log.exists ? 'present' : 'missing'})`,
    ...(posture.log.readError ? [`  log read error: ${posture.log.readError}`] : []),
    '',
    'Connected API checks',
    ...posture.endpoints.map((endpoint) =>
      `  ${endpoint.label} enabled ${yesNo(endpoint.enabled)}  ${endpoint.binding.hostMode} ${endpoint.binding.host}:${endpoint.binding.port}  posture ${endpoint.bindPosture.label}${endpoint.reachable === undefined ? '' : `  reachable ${yesNo(endpoint.reachable)}`}`,
    ),
    '',
    posture.issues.length === 0 ? 'Readiness ready' : 'Readiness needs attention',
    ...posture.issues.map((issue) => `  - ${issue}`),
  ].join('\n');
}
