/**
 * LAN-scan consent gate.
 *
 * The SDK's background provider-discovery pass (`startBackgroundProviderDiscovery`
 * in `@goodvibes-jev/engine/sdk/platform/runtime`) probes every host on this
 * computer's local subnet (254 addresses per non-internal network interface)
 * looking for local model servers such as Ollama or LM Studio, then dumps one
 * raw "[Scan] Found <name> at <host>:<port>" line per server straight into the
 * activity feed. It ran unconditionally, with no consent step, and no way to
 * turn it off.
 *
 * This module is the only place in the Agent that is allowed to call the SDK
 * discovery entry point. It:
 *   1. Gates the call behind a persisted, explicit consent decision. The very
 *      first time the Agent starts, nothing is scanned; the user is told what
 *      the feature does, what it touches (the local subnet, nothing beyond
 *      it), and what it stores, then the decision defaults to "off" until the
 *      user turns it on.
 *   2. Reframes whatever the SDK emits when consent has been granted: instead
 *      of one raw host:port line per server, the Agent surfaces a single
 *      framed summary ("Discovered N local model servers ..."), with full
 *      detail available on demand via /provider.
 *
 * The platform scanner itself is not modified, it lives behind the
 * `platform/discovery` and `platform/runtime` subpaths, which is also how this
 * file reaches it. Named by subpath rather than by build-output path on
 * purpose: `dist/` is not a public entry point, an exports map is entitled to
 * stop resolving it, and a comment that names one reads to an audit like an
 * import that would fail against a published package.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  startBackgroundProviderRegistration,
  type BackgroundProviderDiscoveryOptions,
  type BackgroundRuntimeTaskHandle,
  type HostSystemMessageSink,
  type ShellPathService,
} from '@/runtime/index.ts';

export type LanScanDecision = 'granted' | 'declined';

export interface LanScanConsentState {
  readonly decision: LanScanDecision;
  readonly decidedAt: string;
}

type ConsentRoots = Pick<ShellPathService, 'resolveUserPath'>;

const CONSENT_FILE_NAME = 'network-discovery-consent.json';
const DISCOVERED_PROVIDERS_FILE = 'discovered-providers.json';

function consentFilePath(roots: ConsentRoots, surfaceRoot: string): string {
  return roots.resolveUserPath(surfaceRoot, CONSENT_FILE_NAME);
}

/**
 * The path the SDK persists discovered servers to, for display in user-facing
 * copy (this module does not read or write that file, the SDK owns it).
 */
export function discoveredProvidersFilePath(roots: ConsentRoots, surfaceRoot: string): string {
  return roots.resolveUserPath(surfaceRoot, DISCOVERED_PROVIDERS_FILE);
}

/**
 * Load the persisted LAN-scan consent decision.
 * Returns undefined when no decision has ever been recorded (true first run).
 */
export function loadLanScanConsent(roots: ConsentRoots, surfaceRoot: string): LanScanConsentState | undefined {
  const path = consentFilePath(roots, surfaceRoot);
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<LanScanConsentState> | null;
    if (!parsed || (parsed.decision !== 'granted' && parsed.decision !== 'declined')) {
      logger.warn('[LanScanConsent] ignoring invalid consent file', { path });
      return undefined;
    }
    return {
      decision: parsed.decision,
      decidedAt: typeof parsed.decidedAt === 'string' ? parsed.decidedAt : new Date(0).toISOString(),
    };
  } catch (err) {
    logger.warn('[LanScanConsent] load failed; treating as undecided', { path, error: summarizeError(err) });
    return undefined;
  }
}

/** Persist the user's LAN-scan consent decision (explicit grant, decline, or the first-run default). */
export function saveLanScanConsent(roots: ConsentRoots, surfaceRoot: string, decision: LanScanDecision): void {
  const path = consentFilePath(roots, surfaceRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const state: LanScanConsentState = { decision, decidedAt: new Date().toISOString() };
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  } catch (err) {
    logger.warn('[LanScanConsent] save failed; decision will not persist', { path, error: summarizeError(err) });
  }
}

// ── Wording ──────────────────────────────────────────────────────────────

export const NETWORK_SCAN_ENABLE_COMMAND = '/network-scan on';
export const NETWORK_SCAN_DISABLE_COMMAND = '/network-scan off';
export const NETWORK_SCAN_STATUS_COMMAND = '/network-scan';

/** Shown exactly once, the very first time the Agent starts and no decision has been recorded yet. */
export function firstRunConsentMessage(roots: ConsentRoots, surfaceRoot: string): string {
  const storePath = discoveredProvidersFilePath(roots, surfaceRoot);
  return (
    '[Scan] Local network scanning for model servers is off by default. ' +
    'If turned on, it checks other devices on this computer\'s local network (your subnet only, nothing beyond it) ' +
    'for model servers such as Ollama or LM Studio, so they can be added as chat providers. ' +
    `Servers it finds are saved to ${storePath}. ` +
    `Turn it on with ${NETWORK_SCAN_ENABLE_COMMAND}; nothing is scanned until you do.`
  );
}

/**
 * F3 fix: the first-run explanation (firstRunConsentMessage) already told the
 * user this is off and how to turn it on. Printing that reminder again on
 * EVERY subsequent boot forever, with no way to quiet it short of turning
 * the feature on, was the friction: an indefinitely repeating notice for a
 * state the user already chose. The off state is still fully discoverable on
 * demand via `/network-scan status`; boot itself stays silent about it from
 * the second run onward. The granted-path behavior (framed scan summary) is
 * unchanged.
 */

// ── Output framing ───────────────────────────────────────────────────────

const FOUND_OR_RESTORED_RE = /\bat\s+\S+:\d+\s+\(\d+\s+models?\)/;
const REMOVED_RE = /\bat\s+\S+:\d+\s+is no longer reachable\b/;
const RAW_IP_PAREN_RE = /\s*\(\d{1,3}(?:\.\d{1,3}){3}\)/g;

/** Strips a bare "(1.2.3.4)" parenthetical from an otherwise-fine message, defense in depth. */
function stripRawIpMention(message: string): string {
  return message.replace(RAW_IP_PAREN_RE, '');
}

/**
 * Wraps the real system-message sink + requestRender callback so that the raw
 * per-server "[Scan] Found X at host:port" / "[Local] X at host:port ... from
 * last session" / "[Scan] X at host:port is no longer reachable" lines the SDK
 * emits are never forwarded verbatim. Instead they are counted, and a single
 * framed summary line is emitted the next time requestRender fires, which the
 * SDK reliably calls exactly once per batch of emitted messages (see
 * bootstrap-background.js), so this stays in lockstep with the underlying
 * scan/restore passes without needing to touch the SDK.
 */
function createFramedDiscoverySink(
  realRouter: HostSystemMessageSink,
  realRequestRender: () => void,
): { readonly sink: HostSystemMessageSink; readonly requestRender: () => void } {
  let foundCount = 0;
  let removedCount = 0;

  const sink: HostSystemMessageSink = {
    low(message: string) {
      if (FOUND_OR_RESTORED_RE.test(message)) {
        foundCount += 1;
        return;
      }
      if (REMOVED_RE.test(message)) {
        removedCount += 1;
        return;
      }
      realRouter.low(stripRawIpMention(message));
    },
    high(message: string) {
      realRouter.high(stripRawIpMention(message));
    },
  };

  const requestRender = () => {
    if (foundCount > 0) {
      realRouter.low(
        `[Scan] Discovered ${foundCount} local model server${foundCount === 1 ? '' : 's'} on this network, run /provider to see them.`,
      );
    }
    if (removedCount > 0) {
      realRouter.low(
        `[Scan] ${removedCount} previously found server${removedCount === 1 ? '' : 's'} no longer reachable, removed.`,
      );
    }
    foundCount = 0;
    removedCount = 0;
    realRequestRender();
  };

  return { sink, requestRender };
}

function noopHandle(): BackgroundRuntimeTaskHandle {
  let stopped = false;
  return {
    get stopped() {
      return stopped;
    },
    stop() {
      stopped = true;
    },
  };
}

export interface LanScanGateOptions extends BackgroundProviderDiscoveryOptions {
  readonly shellPaths: BackgroundProviderDiscoveryOptions['shellPaths'] & ConsentRoots;
  /**
   * Injectable seam for tests. Defaults to the real SDK discovery pass
   * (`startBackgroundProviderRegistration`, which performs a real subnet
   * scan). Tests must supply a fake here instead of exercising the real
   * network, never let a test fall through to the default.
   */
  readonly startDiscovery?: (opts: BackgroundProviderDiscoveryOptions) => BackgroundRuntimeTaskHandle;
}

/**
 * The single gated entry point to LAN provider discovery. Bootstrap's Phase 8
 * and the /network-scan command are the only two callers; neither calls the
 * SDK's startBackgroundProviderRegistration/startBackgroundProviderDiscovery
 * directly.
 *
 * - No decision recorded (first run): shows the full consent explanation,
 *   persists "declined" as the honest first-run default, and returns without
 *   scanning.
 * - Decision is "declined" (F3): stays silent and returns without scanning,
 *   the first-run boot already explained the off state and how to turn it
 *   on; the ongoing state is discoverable on demand via `/network-scan
 *   status`, not repeated on every boot.
 * - Decision is "granted": runs the SDK discovery pass through a framing
 *   wrapper that replaces the raw per-server feed dump with a single summary
 *   line.
 */
export function runGatedLanScan(options: LanScanGateOptions): BackgroundRuntimeTaskHandle {
  const { shellPaths, surfaceRoot, systemMessageRouter, requestRender, startDiscovery = startBackgroundProviderRegistration } = options;
  const existing = loadLanScanConsent(shellPaths, surfaceRoot);

  if (!existing) {
    saveLanScanConsent(shellPaths, surfaceRoot, 'declined');
    systemMessageRouter.low(firstRunConsentMessage(shellPaths, surfaceRoot));
    return noopHandle();
  }

  if (existing.decision === 'declined') {
    return noopHandle();
  }

  const framed = createFramedDiscoverySink(systemMessageRouter, requestRender);
  return startDiscovery({
    ...options,
    systemMessageRouter: framed.sink,
    requestRender: framed.requestRender,
  });
}
