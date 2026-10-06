import { createHash } from 'node:crypto';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveControlPlaneBaseUrl } from './operator-endpoint.ts';
import { canonicalizePairingHost, readTuiHostPairing } from '../tui-host-credential-store.ts';

export interface NativeHostCredentialOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}
/** Preserve explicit syntax for validation instead of silently stripping paths. */
export function resolveTuiHostOrigin(config: ConfigManager): string | null {
  const explicit: unknown = config.get('controlPlane.publicBaseUrl' as never);
  const selected = typeof explicit === 'string' && explicit.length > 0 ? explicit : resolveControlPlaneBaseUrl(config);
  return selected === null ? null : canonicalizePairingHost(selected);
}
export type NativeHostCredential =
  | { readonly available: true; readonly baseUrl: string; readonly token: string; readonly identity: string }
  | { readonly available: false; readonly identity: string; readonly reason: string };

/** Passive snapshot only. Native operations never borrow another product's secret,
 * read the daemon-global token, honor unbound environment credentials, or mint.
 * Live scopes are enforced by each operation; a read does not require write/admin.
 */
export function resolveNativeHostCredential(options: NativeHostCredentialOptions): NativeHostCredential {
  try {
    const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const enabled = resolveDaemonEnabled(options.configManager);
    const selected = resolveControlPlaneBaseUrl(options.configManager);
    const baseUrl = resolveTuiHostOrigin(options.configManager);
    const pairing = baseUrl ? readTuiHostPairing(home, baseUrl) : null;
    // Full state, not merely the bearer: replacement and indeterminate state
    // invalidate queued reads, permits and mutation preflights as well.
    const identity = createHash('sha256').update(JSON.stringify([home, enabled, selected, baseUrl, pairing])).digest('hex');
    if (!enabled) return { available: false, identity, reason: 'Selected daemon is disabled.' };
    if (!baseUrl) return { available: false, identity, reason: 'Select an exact HTTP(S) daemon origin without a path, query, fragment or user information.' };
    if (pairing?.status === 'paired') return { available: true, baseUrl, token: pairing.token, identity };
    if (pairing?.status === 'unknown') return { available: false, identity, reason: 'A TUI host pairing outcome is unknown. Inspect this host before further action; no credential fallback or automatic remint is allowed.' };
    if (pairing?.status === 'unavailable') return { available: false, identity, reason: 'The TUI host credential store could not be read safely. Native work is unavailable.' };
    return { available: false, identity, reason: 'No TUI credential is bound to this exact daemon origin. Run goodvibes host pair --bootstrap-shared to review pairing, then use --apply in an owner terminal.' };
  } catch {
    return { available: false, identity: 'tui-host-credential-unavailable', reason: 'The selected TUI host credential is unavailable.' };
  }
}
