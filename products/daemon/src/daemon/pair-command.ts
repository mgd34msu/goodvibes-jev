/**
 * pair-command.ts, `goodvibes-daemon pair`.
 *
 * Two forms.
 *
 * LOCAL FORM, `pair` with no `--host`, or one naming this machine, reprints
 * the pairing block a daemon prints once as it starts: the web origin, the
 * offers a new device can accept, what it will be able to do, and a QR code
 * encoding the deep link that opens the web app already signed in. It reads
 * from THIS machine's own token store (the shared companion token in
 * `<daemon home>/operator-tokens.json` plus the web origin its settings
 * resolve to) and reprints the EXISTING token rather than minting a new one,
 * so a link printed here and the one printed at boot are the same link.
 *
 * REMOTE FORM, `pair --host <name> [--port] [--token]`, asks THAT daemon to
 * MINT A NEW per-device pairing token over `pairing.handoff.create` and prints
 * the pairing block for it. Minting is a different act than reprinting: it is
 * a fresh token, and every token that daemon already issued (its own shared
 * token included) is left exactly as it was. Because it changes state on a
 * daemon that may not be this process's own, it states the plan and asks for
 * confirmation before acting, `-y`/`--yes` satisfies that non-interactively,
 * the same convention `migrate-service` uses. An unreachable daemon, a
 * rejected token, and a daemon too old to serve the verb are each refused by
 * name (see `callDaemonWsVerb`), never a stack trace.
 *
 * The remote form's mint call carries no `--name` flag of its own: the token
 * is named with the SDK's `defaultPairingTokenName()`, the same date-stamped
 * default every other pairing producer uses when the operator did not supply
 * one. The name is user-visible and editable later in device management.
 */
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  availablePairingOffers,
  defaultPairingTokenName,
  formatPairingOffers,
  resolvePairingWebOrigin,
  type PairingHandoffOfferKind,
} from '@goodvibes-jev/engine/sdk/platform/pairing';
import { renderPairingBanner } from '../core/pairing-banner.js';
import {
  extractOperatorToken,
  resolveRemoteDaemonTarget,
  resolveRuntimeEndpointBinding,
  type RemoteDaemonTarget,
} from '@goodvibes-jev/engine/terminal-shell';
import { callDaemonWsVerb, type DaemonWebSocketFactory } from '@goodvibes-jev/engine/terminal-shell';
import type { DaemonCommandResult, RemoteCommandFlags } from './status-command.js';

export interface PairCommandDeps {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  readonly version: string;
  /** Injected in tests so nothing reads a real token file. */
  readonly readToken: (daemonHomeDir: string) => string | undefined;
  /** Process-local override, never adopted into the stored companion identity. */
  readonly operatorToken?: string | undefined;
  /** Injected in tests so the remote mint path never opens a real socket. */
  readonly socketFactory?: DaemonWebSocketFactory | undefined;
}

export interface PairCommandFlags extends RemoteCommandFlags {
  /** `-y`/`--yes`: consent to minting a new per-device token on a remote daemon. */
  readonly yes: boolean;
}

export interface RunPairCommandInput extends PairCommandDeps {
  readonly flags: PairCommandFlags;
}

/** The hosts that mean "this machine", matching the remote-target convention. */
function namesThisMachine(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === ''
    || normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0';
}

function failure(error: string, fix: string, json: boolean): DaemonCommandResult {
  return {
    exitCode: 1,
    lines: json ? [JSON.stringify({ ok: false, error, fix }, null, 2)] : [error, `  ${fix}`],
  };
}

/**
 * The web origin a remote handoff's deep link opens, recovered from the link
 * itself. `buildPairingHandoffLink` in the SDK builds the link as exactly
 * `<webOrigin, trailing slashes stripped>/#<params>`, so slicing at the
 * first `/#` is the precise inverse, and feeding the result back into
 * `renderPairingBanner` (which rebuilds the SAME link from origin + token +
 * offers) reproduces byte-for-byte what the remote daemon already returned.
 */
function originFromDeepLink(deepLink: string): string {
  const cut = deepLink.indexOf('/#');
  return cut === -1 ? deepLink : deepLink.slice(0, cut);
}

function isPairingOfferKind(value: string): value is PairingHandoffOfferKind {
  return value === 'notifications' || value === 'relay' || value === 'passkey';
}

interface PairingHandoffOfferDetail {
  readonly kind: string;
  readonly available?: boolean;
}

/** The shape `pairing.handoff.create` returns, see routes/pairing-handoff.ts. */
interface PairingHandoffCreateResult {
  readonly token: {
    readonly id: string;
    readonly name: string;
    /** The plaintext secret, returned exactly once. */
    readonly token: string;
    readonly createdAt: number;
  };
  readonly offers: readonly PairingHandoffOfferDetail[];
  /** `#pair=<token>&offers=...`, present even when no web origin is configured. */
  readonly fragment: string;
  /** `<webOrigin>/#pair=...`, present only when that daemon has a web origin configured. */
  readonly deepLink?: string;
}

/** `goodvibes-daemon pair` with no `--host`, or one naming this machine. */
function runLocalReprint(input: RunPairCommandInput): DaemonCommandResult {
  const { flags } = input;
  if (flags.port !== undefined && (!Number.isInteger(flags.port) || flags.port < 1 || flags.port > 65535)) {
    return failure('the local pairing port must identify a concrete listener', 'use the nonzero port reported by the running daemon', flags.json);
  }

  const token = flags.token ?? input.operatorToken ?? extractOperatorToken(input.readToken(input.daemonHomeDir));
  if (token === undefined) {
    return failure(
      'no operator token was found for this machine, so there is no link to print',
      'start the daemon once; it creates the token as it starts: goodvibes-daemon serve',
      flags.json,
    );
  }

  // A local reprint is a non-writing configured view. It cannot observe an
  // unrelated process's runtime overrides; an explicit --port carries that
  // choice through for the bundled control-plane surface.
  const binding = flags.port === undefined ? undefined
    : { ...resolveRuntimeEndpointBinding(input.configManager, 'controlPlane'), port: flags.port };
  const origin = resolvePairingWebOrigin(input.configManager, undefined, binding);
  const offers = availablePairingOffers({
    relayEnabled: input.configManager.get('relay.enabled') === true,
    stepUpAvailable: true,
  });

  const banner = renderPairingBanner({
    version: input.version,
    origin: origin.origin,
    token,
    offers,
    includeQr: !flags.json,
  });

  if (flags.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          origin: origin.origin,
          deepLink: banner.deepLink,
          offers,
          capabilities: banner.capabilities,
          ...(banner.notice === undefined ? {} : { notice: banner.notice }),
          originFromPublicBaseUrl: origin.fromPublicBaseUrl,
        },
      }, null, 2)],
    };
  }

  return { exitCode: 0, lines: banner.lines };
}

/** The plan `pair --host <target>` prints before it will act, absent `-y`. Nothing is called yet. */
function mintPlanResult(target: RemoteDaemonTarget, json: boolean): DaemonCommandResult {
  const plan = [
    `pair --host: this will MINT A NEW per-device pairing token on the daemon at ${target.baseUrl}`,
    'and print the pairing link/QR for that new token.',
    '',
    "That daemon's existing tokens (its shared token and every other paired device) are",
    'left exactly as they are: minting is a different act than reprinting, and this is a',
    'fresh token, not a link to one that already exists.',
    '',
    'Nothing has been changed. Re-run with -y (or --yes) to mint it.',
  ];
  if (json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: { confirmed: false, target: target.baseUrl, plan },
      }, null, 2)],
    };
  }
  return { exitCode: 0, lines: plan };
}

/** The remote form, once `-y` has consented: mint and render. */
async function runRemoteMint(input: RunPairCommandInput, target: RemoteDaemonTarget): Promise<DaemonCommandResult> {
  const { flags } = input;

  const outcome = await callDaemonWsVerb<PairingHandoffCreateResult>(target, 'pairing.handoff.create', {
    body: { name: defaultPairingTokenName() },
    ...(input.socketFactory ? { socketFactory: input.socketFactory } : {}),
  });
  if (!outcome.ok) return failure(outcome.error, outcome.fix, flags.json);

  const data = outcome.data;
  const offerKinds = data.offers.map((offer) => offer.kind).filter(isPairingOfferKind);
  const mintedLine = `minted a new per-device pairing token ("${data.token.name}") on the daemon at ${target.baseUrl}.`;

  if (data.deepLink === undefined) {
    // Honest degraded path: the mint itself succeeded, the token is real and
    // usable, but that daemon has no web origin configured, and this process
    // has no way to read or fabricate one for it. `resolvePairingWebOrigin` is
    // what the local form reads instead, and it is exactly the thing this
    // process cannot ask a REMOTE daemon for outside this verb's own reply.
    const lines = [
      mintedLine,
      '',
      'that daemon has no web origin configured, so no deep link or QR could be built; only',
      'the raw token and pairing fragment:',
      '',
      `  token:    ${data.token.token}`,
      `  fragment: ${data.fragment}`,
      '',
      ...(offerKinds.length > 0 ? ['Offers (each declinable in the web app):', ...formatPairingOffers(offerKinds), ''] : []),
      'Configure a web origin on that daemon, then pair again for a scannable link.',
    ];
    if (flags.json) {
      return {
        exitCode: 0,
        lines: [JSON.stringify({
          ok: true,
          data: {
            minted: true,
            target: target.baseUrl,
            tokenId: data.token.id,
            tokenName: data.token.name,
            token: data.token.token,
            fragment: data.fragment,
            offers: offerKinds,
          },
        }, null, 2)],
      };
    }
    return { exitCode: 0, lines };
  }

  const origin = originFromDeepLink(data.deepLink);
  const banner = renderPairingBanner({
    version: `remote build at ${target.baseUrl}`,
    origin,
    token: data.token.token,
    offers: offerKinds,
    includeQr: !flags.json,
  });

  if (flags.json) {
    return {
      exitCode: 0,
      lines: [JSON.stringify({
        ok: true,
        data: {
          minted: true,
          target: target.baseUrl,
          tokenId: data.token.id,
          tokenName: data.token.name,
          token: data.token.token,
          origin,
          deepLink: banner.deepLink,
          offers: offerKinds,
          capabilities: banner.capabilities,
          ...(banner.notice === undefined ? {} : { notice: banner.notice }),
        },
      }, null, 2)],
    };
  }

  return { exitCode: 0, lines: [mintedLine, '', ...banner.lines] };
}

export async function runPairCommand(input: RunPairCommandInput): Promise<DaemonCommandResult> {
  const { flags } = input;

  if (flags.host !== undefined && !namesThisMachine(flags.host)) {
    const resolved = resolveRemoteDaemonTarget({
      flags: {
        host: flags.host,
        ...(flags.port === undefined ? {} : { port: flags.port }),
        ...(flags.token === undefined ? {} : { token: flags.token }),
      },
      configManager: input.configManager,
      daemonHomeDir: input.daemonHomeDir,
      readToken: input.readToken,
    });
    if (!resolved.ok) return failure(resolved.error, resolved.fix, flags.json);
    if (!flags.yes) return mintPlanResult(resolved.target, flags.json);
    return runRemoteMint(input, resolved.target);
  }

  return runLocalReprint(input);
}
