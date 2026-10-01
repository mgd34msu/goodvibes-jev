/**
 * pairing-banner.ts, the pairing block, in one place.
 *
 * A daemon prints this once, as it finishes starting. That was the ONLY way to
 * see it: scroll it off the screen, start the daemon as a service where nothing
 * reads stdout, or come back to the box tomorrow, and there was no way to get
 * the link back short of restarting the daemon. `goodvibes-daemon pair` prints
 * it again, and prints exactly THIS, because both callers render from here.
 *
 * It reprints the daemon's existing shared token rather than minting a new one.
 * Minting is a different act with a different consequence (a per-device token,
 * one more record in the token store, a link the boot banner's QR no longer
 * matches), and `pair` is not the command for it, `pairing.handoff.create` is.
 */
import {
  buildPairingHandoffLink,
  describeOriginPosture,
  formatPairingOffers,
  formatPostureCapabilities,
  generateQrMatrix,
  pairingPostureNotice,
  renderQrToString,
  type PairingHandoffOfferKind,
} from '@goodvibes-jev/engine/sdk/platform/pairing';

export interface PairingBannerInput {
  /** The daemon version, stated so a scanned link is attributable to a build. */
  readonly version: string;
  /** The web-app origin the deep link opens. */
  readonly origin: string;
  /** The token the link carries, the daemon's existing shared companion token. */
  readonly token: string;
  readonly offers: readonly PairingHandoffOfferKind[];
  /** False to print the link and the offers without the QR block. */
  readonly includeQr?: boolean | undefined;
}

export interface PairingBanner {
  readonly lines: readonly string[];
  /** The exact `<origin>/#pair=<token>` URL the QR encodes. */
  readonly deepLink: string;
  /** The capability list, already worded, for a caller rendering its own shape. */
  readonly capabilities: readonly string[];
  /** The one honest posture line, when the posture carries one. */
  readonly notice: string | undefined;
}

/**
 * Render the block. Pure: it takes an origin and a token and returns lines, so
 * the boot path and the `pair` command cannot drift, and a test can assert the
 * exact text without a daemon, a socket or a token file.
 */
export function renderPairingBanner(input: PairingBannerInput): PairingBanner {
  const deepLink = buildPairingHandoffLink({
    webOrigin: input.origin,
    token: input.token,
    offers: input.offers,
  });
  // The banner renders the SAME SDK posture the pairing verb carries: the
  // labeled capability list, and the one honest LAN line only when the posture
  // holds it.
  const posture = describeOriginPosture(input.origin);
  const capabilities = formatPostureCapabilities(posture);
  const notice = pairingPostureNotice(posture) ?? undefined;
  const qr = input.includeQr === false ? [] : [renderQrToString(generateQrMatrix(deepLink))];

  return {
    deepLink,
    capabilities,
    notice,
    lines: [
      `GoodVibes daemon ${input.version}: scan to pair a device (opens the web app signed in):`,
      '',
      `  ${input.origin}`,
      '',
      ...(input.offers.length > 0 ? ['Offers (each declinable in the web app):', ...formatPairingOffers(input.offers), ''] : []),
      ...(capabilities.length > 0 ? ['This device will get:', ...capabilities, ''] : []),
      ...(notice ? [notice, ''] : []),
      ...qr,
    ],
  };
}
