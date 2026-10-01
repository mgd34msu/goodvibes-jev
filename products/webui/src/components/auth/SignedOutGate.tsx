/**
 * SignedOutGate, the honest first-paint front door.
 *
 * Replaces the old behavior where the full operator shell rendered regardless of auth
 * and merely dropped a dismissible banner while every API call 401'd. When auth.current
 * reports signed-out, this screen is shown INSTEAD of the shell: the nav and views are
 * gated behind it.
 *
 * PRIMARY path: scan the QR shown by `goodvibes pair` in the terminal. That QR encodes
 * a link back here with the operator token in the URL fragment; opening it hands the
 * token off automatically (usePairingHandoff → setExplicitAuthToken), no copy/paste.
 * This screen leads with that flow and explains it prominently.
 *
 * The same section carries the IN-PAGE scanner (PairingQrScanner), which replaces the
 * retired Android companion app: a phone already looking at this screen can open its
 * own camera here instead of leaving for a separate app, and it also reads the
 * companion connection payload the desktop app and TUI print, which is a JSON object
 * rather than a link and so cannot be "opened" by a phone's camera app at all. A scan
 * does not get its own sign-in code path: it feeds the SAME tokenMutation /
 * loginMutation / relay-store calls the manual forms below use, so there is exactly one
 * place where a token is validated and one place where a rejection is reported.
 *
 * FALLBACK path: paste the operator token by hand (setExplicitAuthToken self-validates
 * via auth.current and auto-clears on failure). Password login is offered only as a
 * de-emphasized tertiary path, on hosts where the bootstrap credential was already
 * consumed it is structurally dead, so it must not be presented co-equal.
 *
 * `pairingError` is set when a pairing link's token was rejected by the daemon (an
 * expired or malformed QR); it surfaces as a banner so a failed scan is never a silent
 * bounce back to the token field.
 */

import { Camera, KeyRound, QrCode, Radio, ShieldCheck } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { GOODVIBES_BASE_URL, login, setExplicitAuthToken } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { decodeRelayPairingCode, storeRelayPairing } from '../../lib/relay-pairing';
import {
  describeScannedPairing,
  isDifferentOrigin,
  type ScannedPairing,
} from '../../lib/pairing-qr';
import { PairingQrScanner } from '../pairing/PairingQrScanner';
import { Disclosure } from '../data-view/DataView';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field, Input } from '../ui/Field';
import '../../styles/components/auth-gate.css';

export interface SignedOutGateProps {
  /** Set when a `#pair=…` hand-off token was rejected by the daemon (expired/invalid QR). */
  pairingError?: unknown;
  /** Set when a `#relay=…` hand-off code was malformed (see useRelayPairingHandoff). */
  relayPairingError?: unknown;
}

export function SignedOutGate({ pairingError, relayPairingError }: SignedOutGateProps = {}) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showRelayPaste, setShowRelayPaste] = useState(false);
  const [relayCode, setRelayCode] = useState('');
  const [relayPasteError, setRelayPasteError] = useState<unknown>(null);
  const [relayStored, setRelayStored] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  const [scanOriginNote, setScanOriginNote] = useState<string | null>(null);

  // Both credentials arrive as mutation VARIABLES rather than being read off
  // component state, so a scan and a typed entry run the identical call. Reading
  // state here instead would have forced the scanner to stage its token in the
  // visible input first, which would both render the secret and race the submit.
  const tokenMutation = useMutation({
    mutationFn: (value: string) => setExplicitAuthToken(value.trim()),
    onSuccess: async () => {
      setToken('');
      // Revalidate everything, auth/boot/health flip to signed-in and the shell reveals.
      await queryClient.invalidateQueries();
    },
  });

  const loginMutation = useMutation({
    mutationFn: (credentials: { username: string; password: string }) =>
      login(credentials.username, credentials.password),
    onSuccess: async () => {
      setPassword('');
      await queryClient.invalidateQueries();
    },
  });

  function submitToken(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (token.trim()) tokenMutation.mutate(token);
  }

  // Relay pairing is transport-only, it never signs anyone in, so this is a plain
  // synchronous decode + local store (lib/relay-pairing.ts), no useMutation/network
  // round trip. decodeRelayPairingCode throws the SDK's own GoodVibesSdkError on a
  // malformed code; formatError renders that the same honest way as every other
  // rejection on this screen.
  function submitRelayCode(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setRelayPasteError(null);
    setRelayStored(false);
    if (!relayCode.trim()) return;
    try {
      const decoded = decodeRelayPairingCode(relayCode);
      storeRelayPairing(decoded);
      setRelayCode('');
      setRelayStored(true);
    } catch (err) {
      setRelayPasteError(err);
    }
  }

  function submitLogin(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (username && password) loginMutation.mutate({ username, password });
  }

  function storeScannedRelay(code: string) {
    setRelayPasteError(null);
    setRelayStored(false);
    try {
      storeRelayPairing(decodeRelayPairingCode(code));
      setRelayStored(true);
    } catch (err) {
      setRelayPasteError(err);
    }
  }

  // The one place a scan turns into an action. Every branch hands off to the
  // same call the corresponding manual form uses; nothing new signs anyone in,
  // and the scanned secret is never written to component state or rendered.
  // Plain function, not useCallback: PairingQrScanner reads this through a ref
  // precisely so an unstable identity cannot restart its camera.
  function acceptScan(scanned: ScannedPairing) {
    setScanOpen(false);
    setScanNotice(describeScannedPairing(scanned));
    setScanOriginNote(
      isDifferentOrigin(scanned.url, GOODVIBES_BASE_URL) ? (scanned.url ?? null) : null,
    );
    switch (scanned.kind) {
      case 'token':
        tokenMutation.mutate(scanned.token);
        break;
      case 'password':
        loginMutation.mutate({ username: scanned.username, password: scanned.password });
        break;
      case 'relay':
        storeScannedRelay(scanned.relayCode);
        // A relay pairing is transport-only, so the sign-in step still has to
        // happen; opening the relay section points at what is left to do.
        setShowRelayPaste(true);
        break;
    }
  }

  return (
    <div className="signed-out-gate" role="main">
      <div className="signed-out-card">
        <div className="signed-out-mark">
          <ShieldCheck size={24} aria-hidden="true" />
        </div>
        <h1>Sign in to GoodVibes</h1>
        <p className="signed-out-lede">
          This operator shell talks to a daemon that requires an operator token. The
          quickest way in is to scan a QR from your terminal, no copy/paste.
        </p>

        {pairingError != null && (
          <div className="banner warning" role="alert">
            The pairing link was rejected: {formatError(pairingError)}. Its token was
            cleared; scan a fresh QR from <code>goodvibes pair</code>, or paste a token below.
          </div>
        )}

        {relayPairingError != null && (
          <div className="banner warning" role="alert">
            The relay pairing link was not recognized: {formatError(relayPairingError)}.
            Scan a fresh relay QR, or paste a relay code below.
          </div>
        )}

        <section className="signed-out-pair" aria-labelledby="signed-out-pair-title">
          <div className="signed-out-pair__mark">
            <QrCode size={20} aria-hidden="true" />
          </div>
          <div className="signed-out-pair__copy">
            <h2 id="signed-out-pair-title">Scan the QR from your terminal</h2>
            <p>
              Run <code>goodvibes pair</code> in the terminal where the daemon is running.
              It prints a QR code, scan it with this device&rsquo;s camera and the link
              signs you in automatically.
            </p>
            <Button
              size="sm"
              className="signed-out-pair__scan"
              icon={<Camera aria-hidden="true" />}
              onClick={() => {
                setScanNotice(null);
                setScanOriginNote(null);
                setScanOpen(true);
              }}
            >
              Scan with this device&rsquo;s camera
            </Button>
          </div>
        </section>

        {scanNotice != null && (
          <div className="banner" role="status">
            {scanNotice}.
          </div>
        )}

        {scanOriginNote != null && (
          <div className="banner warning" role="status">
            That QR names the daemon at <code>{scanOriginNote}</code>, but this page is
            served from <code>{GOODVIBES_BASE_URL}</code>. Often that is the same daemon
            reached by another address and everything works; if sign-in is rejected, that
            mismatch is the first thing to check.
          </div>
        )}

        <Dialog open={scanOpen} onClose={() => setScanOpen(false)} title="Scan a pairing QR">
          <PairingQrScanner onScanned={acceptScan} onCancel={() => setScanOpen(false)} />
        </Dialog>

        <div className="signed-out-or" role="separator" aria-label="or paste a token">
          <span>or paste a token</span>
        </div>

        <form className="signed-out-form" onSubmit={submitToken}>
          <Field label="Operator token">
            <Input
              value={token}
              onChange={(event) => setToken(event.target.value)}
              type="password"
              autoComplete="off"
              placeholder="Paste an operator token"
              // eslint-disable-next-line jsx-a11y/no-autofocus -- primary action on a dedicated sign-in screen
              autoFocus
            />
          </Field>
          <Button variant="primary" type="submit" disabled={tokenMutation.isPending || !token.trim()}>
            {tokenMutation.isPending ? 'Validating…' : 'Sign in with token'}
          </Button>
        </form>

        {tokenMutation.error && (
          <div className="banner warning" role="alert">
            {formatError(tokenMutation.error)}: the token was rejected and cleared. Paste a fresh one.
          </div>
        )}

        <div className="signed-out-secondary">
          <Button
            variant="ghost"
            size="sm"
            className="signed-out-toggle"
            icon={<Radio aria-hidden="true" />}
            onClick={() => setShowRelayPaste((current) => !current)}
            aria-expanded={showRelayPaste}
          >
            Connecting from outside the LAN?
          </Button>
          {showRelayPaste && (
            <form className="signed-out-form signed-out-password" onSubmit={submitRelayCode}>
              <p className="signed-out-note">
                If this device cannot reach the daemon directly, scan or paste the relay
                pairing code the daemon shows (a separate QR from the sign-in one). It
                lets this device reach the daemon through the relay instead. It does
                not sign you in by itself; still scan or paste an operator token above (or
                after) to sign in. Live updates (chat streaming, fleet events) are not
                available over the relay, so those views fall back to periodic refresh.
              </p>
              <Field label="Relay pairing code">
                <Input
                  value={relayCode}
                  onChange={(event) => setRelayCode(event.target.value)}
                  type="text"
                  autoComplete="off"
                  placeholder="gvrelay1.…"
                />
              </Field>
              <Button type="submit" disabled={!relayCode.trim()}>
                Save relay pairing
              </Button>
              {relayStored && (
                <div className="banner" role="status">
                  Relay pairing saved. This device will use it automatically when the
                  direct connection is unavailable.
                </div>
              )}
              {relayPasteError != null && (
                <div className="banner warning" role="alert">
                  {formatError(relayPasteError)}: not a recognizable relay pairing code.
                </div>
              )}
            </form>
          )}
        </div>

        <Disclosure summary="Where do I find a token?">
          <ul className="signed-out-help">
            <li>
              Easiest: run <code>goodvibes pair</code> and scan the QR: it carries the
              token for you, no copy/paste.
            </li>
            <li>
              The daemon prints an operator token in its startup output when it boots.
            </li>
            <li>
              It is also written to the daemon&rsquo;s <code>operator-tokens.json</code>, or
              mint one from the TUI.
            </li>
            <li>
              Operator tokens are typically ephemeral, if sign-in stops working, the token
              likely expired; grab the current one from the daemon output.
            </li>
          </ul>
        </Disclosure>

        <div className="signed-out-secondary">
          <Button
            variant="ghost"
            size="sm"
            className="signed-out-toggle"
            icon={<KeyRound aria-hidden="true" />}
            onClick={() => setShowPassword((current) => !current)}
            aria-expanded={showPassword}
          >
            Use a username &amp; password instead
          </Button>
          {showPassword && (
            <form className="signed-out-form signed-out-password" onSubmit={submitLogin}>
              <p className="signed-out-note">
                Password login only works on hosts where the daemon still holds a bootstrap
                credential. If it was already consumed, this path will not work, use a token.
              </p>
              <Field label="Username">
                <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
              </Field>
              <Field label="Password">
                <Input
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type="password"
                  autoComplete="current-password"
                />
              </Field>
              <Button type="submit" disabled={loginMutation.isPending || !username || !password}>
                {loginMutation.isPending ? 'Signing in…' : 'Sign in with password'}
              </Button>
              {loginMutation.error && (
                <div className="banner warning" role="alert">{formatError(loginMutation.error)}</div>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
