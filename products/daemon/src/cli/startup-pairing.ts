/** Credential-bearing local pairing output, separate from startup diagnostics. */
import { accessSync, constants, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { availablePairingOffers, resolvePairingWebOrigin } from '@goodvibes-jev/engine/sdk/platform/pairing';
import { renderPairingBanner } from '../core/pairing-banner.js';

/** This equality is the webui command's placeholder rule, not authorship evidence. */
const SHIPPED_PUBLIC_BASE_URL = 'http://127.0.0.1:3423';

export function renderDaemonStartupPairing(
  config: Pick<ConfigManager, 'get'>,
  bound: { readonly host: string; readonly port: number },
  token: string,
  version: string,
): string {
  const publicUrl = String(config.get('web.publicBaseUrl') ?? '').trim().replace(/\/+$/, '');
  const explicitOrigin = publicUrl !== '' && publicUrl !== SHIPPED_PUBLIC_BASE_URL;
  if (!explicitOrigin) {
    if (config.get('controlPlane.webui.serve') !== true) {
      return 'Device pairing link unavailable: enable a WebUI bundle or configure its public URL.';
    }
    // Match the router's directory precedence and process-relative resolution.
    const bundle = String(config.get('controlPlane.webui.bundleDir') ?? '').trim()
      || String(config.get('web.staticAssetsDir') ?? '').trim();
    try {
      if (!bundle || !statSync(resolve(bundle, 'index.html')).isFile()) throw new Error('Unavailable bundle');
      accessSync(resolve(bundle, 'index.html'), constants.R_OK);
    } catch {
      return 'Device pairing link unavailable: the configured WebUI bundle has no readable app shell.';
    }
  }
  const { origin } = resolvePairingWebOrigin(config, undefined, bound);
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password
      || origin.includes('?') || origin.includes('#') || /[\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(origin)
      || parsed.hostname === '0.0.0.0' || parsed.hostname === '[::]') throw new Error('Invalid origin');
  } catch {
    return 'Device pairing link unavailable: the configured WebUI URL is not a usable HTTP(S) origin.';
  }
  return [...renderPairingBanner({ version, origin, token,
    offers: availablePairingOffers({ relayEnabled: config.get('relay.enabled') === true, stepUpAvailable: true }),
  }).lines, '(print again with the same process overrides: goodvibes-daemon pair)'].join('\n');
}
