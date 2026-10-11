/** Original startup maintenance, scoped to the admitted CLI owner. */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ConfigManager, daemonConfigPathForHome } from '@goodvibes-jev/engine/sdk/platform/config';
import { ensurePublicBaseUrl, pruneStaleOperatorTokens } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { workspaceOperatorTokenCandidates } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import { resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { reconcileRedundantLegacyUnit } from '../runtime/legacy-daemon-reconcile.js';
import { resolveConfiguredServiceName } from '../runtime/legacy-daemon-migration.js';
import type { DaemonCliConfiguration } from './configuration.js';

export function pruneDaemonStartupTokens(configuration: DaemonCliConfiguration): number {
  return pruneStaleOperatorTokens({
    daemonHomeDir: configuration.daemonHomeDirectory,
    candidatePaths: workspaceOperatorTokenCandidates(configuration.workingDirectory, GOODVIBES_DAEMON_SURFACE_ROOT),
  }).failedPaths.length;
}

export async function reconcileDaemonStartup(
  configuration: DaemonCliConfiguration, env: NodeJS.ProcessEnv, signal: AbortSignal,
) {
  // Relocated data homes are isolated invocations, never authority over the
  // login user's installed service. Other platforms do not have systemd units.
  if (signal.aborted || configuration.isOverridden || process.platform !== 'linux') return undefined;
  const client = new ConfigManager({
    workingDir: configuration.workingDirectory, homeDir: configuration.homeDirectory,
    surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    daemonTierPath: daemonConfigPathForHome(configuration.daemonHomeDirectory), readOnly: true,
  });
  const endpoint = resolveRuntimeEndpointBinding(client, 'controlPlane');
  if (!endpoint.recognized || signal.aborted) return undefined;
  return reconcileRedundantLegacyUnit({
    homeDir: env.HOME?.trim() || homedir(), trackedServiceName: resolveConfiguredServiceName(client),
    configuredEndpoint: { host: endpoint.host, port: endpoint.port }, signal,
  });
}

export function persistDaemonStartupPublicUrl(
  configuration: DaemonCliConfiguration,
  bound: { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' },
): void {
  const { config } = configuration;
  // Preserve the original empty-only rule. The shipped placeholder and every
  // explicit public URL remain untouched; webui enable owns its separate rule.
  if (String(config.get('web.publicBaseUrl') ?? '').trim() || !config.get('controlPlane.webui.serve')) return;
  // A one-invocation override (including an ephemeral port) cannot become a
  // durable URL. The settled binding must still match the declared endpoint.
  const originKeys = ['web.publicBaseUrl', 'controlPlane.webui.serve', 'controlPlane.webui.bundleDir',
    'web.staticAssetsDir', 'controlPlane.hostMode', 'controlPlane.host', 'controlPlane.port', 'controlPlane.tls.mode'] as const;
  if (originKeys.some((key) => ['runtime', 'runtime-default'].includes(config.describeConfigKeySource(key).effectiveOrigin ?? ''))) return;
  const declared = resolveRuntimeEndpointBinding(config, 'controlPlane');
  if (!declared.recognized || declared.host !== bound.host || declared.port !== bound.port
    || (config.get('controlPlane.tls.mode') === 'direct' ? 'https' : 'http') !== bound.scheme) return;
  const bundle = String(config.get('controlPlane.webui.bundleDir') ?? '').trim()
    || String(config.get('web.staticAssetsDir') ?? '').trim();
  try {
    if (!bundle || !statSync(resolve(bundle, 'index.html')).isFile()) return;
    accessSync(resolve(bundle, 'index.html'), constants.R_OK);
  } catch { return; }
  ensurePublicBaseUrl(config, undefined, bound);
}
