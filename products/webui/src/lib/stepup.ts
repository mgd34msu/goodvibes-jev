/**
 * stepup.ts, the browser-side WebAuthn step-up ceremony.
 *
 * The daemon gates mutating relay calls behind a WebAuthn step-up assertion (see the SDK's
 * platform/relay/step-up-policy + daemon-wiring): a mutating call that arrives over the
 * relay without a fresh, valid assertion is answered 401 with `www-authenticate: WebAuthn`
 * and body `{ error: 'step-up-required' }`. This module is the operator's half of that
 * ceremony:
 *
 *   - registerPasskey()  → navigator.credentials.create (server accepts 'none' attestation),
 *                          producing the COSE public key the daemon persists so it can later
 *                          verify assertions. Registered via the stepup.credentials.register
 *                          gateway verb.
 *   - runAssertion()     → navigator.credentials.get against a server-minted challenge,
 *                          producing the assertion envelope that rides the step-up header on
 *                          the retried call.
 *
 * WIRE PRIMITIVES (STEP_UP_ASSERTION_HEADER, encodeAssertionHeader) are replicated here as
 * the small, stable wire contract they are, the SDK defines them in a Node/daemon module
 * (platform/relay), which is not browser-safe to import, so we mirror the exact format:
 *   - header name: 'x-goodvibes-stepup-assertion'      (STEP_UP_ASSERTION_HEADER)
 *   - header value: base64url(utf8(JSON.stringify(envelope)))   (encodeAssertionHeader)
 * These are asserted against the SDK's own values by stepup.test.ts.
 *
 * HONESTY: every failure path returns a specific, machine-readable StepUpError code and a
 * plain operator-facing message. Nothing silently "succeeds" without a real authenticator
 * signature, an unsupported browser, a missing platform authenticator, a user cancel, and
 * a not-yet-registered passkey are each surfaced distinctly, never swallowed.
 */

/** The request header a step-up assertion rides on. Mirrors the SDK's STEP_UP_ASSERTION_HEADER. */
export const STEP_UP_ASSERTION_HEADER = 'x-goodvibes-stepup-assertion';

/** localStorage key recording the credential id registered on THIS device/browser. */
const REGISTERED_CREDENTIAL_KEY = 'goodvibes.webui.stepup.credential';

// ---------------------------------------------------------------------------
// base64url <-> bytes
// ---------------------------------------------------------------------------

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// The assertion envelope + header encoding (mirrors the SDK wire contract)
// ---------------------------------------------------------------------------

/** The assertion envelope a surface sends in the step-up header (all base64url). */
export interface StepUpAssertionEnvelope {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

/** Encode an envelope into the `x-goodvibes-stepup-assertion` header value. */
export function encodeAssertionHeader(envelope: StepUpAssertionEnvelope): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
}

// ---------------------------------------------------------------------------
// Errors, every failure carries a specific, machine-readable code
// ---------------------------------------------------------------------------

export type StepUpErrorCode =
  | 'unsupported' // this browser has no WebAuthn / no navigator.credentials
  | 'no-authenticator' // no platform authenticator available (NotAllowed for create with no device)
  | 'user-cancelled' // operator dismissed the OS prompt
  | 'no-credential' // no passkey registered on this device to assert with
  | 'ceremony-failed'; // the authenticator/browser returned an unexpected error

export class StepUpError extends Error {
  readonly code: StepUpErrorCode;
  constructor(code: StepUpErrorCode, message: string) {
    super(message);
    this.name = 'StepUpError';
    this.code = code;
  }
}

/** Human copy for each code, plain, no jargon, tells the operator what to do next. */
export function describeStepUpError(error: unknown): string {
  if (error instanceof StepUpError) {
    switch (error.code) {
      case 'unsupported':
        return 'This browser does not support passkeys (WebAuthn), so step-up verification cannot run here.';
      case 'no-authenticator':
        return 'No passkey authenticator is available on this device. Add a platform passkey (Touch ID, Windows Hello, a security key) and try again.';
      case 'user-cancelled':
        return 'Verification was cancelled. The action was not completed.';
      case 'no-credential':
        return 'No passkey is registered on this device yet. Register one in Settings → Security before verifying.';
      case 'ceremony-failed':
      default:
        return error.message || 'The passkey ceremony did not complete.';
    }
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Support detection
// ---------------------------------------------------------------------------

export interface StepUpAvailability {
  readonly supported: boolean;
  /** When unsupported, a plain reason to render. */
  readonly reason?: string;
}

export function stepUpAvailability(): StepUpAvailability {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { supported: false, reason: 'Passkeys are only available in a browser.' };
  }
  const hasCredentials = typeof navigator.credentials?.create === 'function' && typeof navigator.credentials?.get === 'function';
  const hasPublicKey = typeof (window as { PublicKeyCredential?: unknown }).PublicKeyCredential !== 'undefined';
  if (!hasCredentials || !hasPublicKey) {
    return { supported: false, reason: 'This browser does not support passkeys (WebAuthn).' };
  }
  // WebAuthn also requires a secure context (HTTPS or localhost).
  if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
    return { supported: false, reason: 'Passkeys need a secure (HTTPS) connection. Open GoodVibes over HTTPS to use step-up verification.' };
  }
  return { supported: true };
}

// ---------------------------------------------------------------------------
// The relying-party id / origin this surface registers and asserts under.
// ---------------------------------------------------------------------------

/** The effective relying-party id, the page's own hostname (WebAuthn's rpId rule). */
export function relyingPartyId(): string {
  return typeof window === 'undefined' ? 'localhost' : window.location.hostname;
}

export function relyingPartyOrigin(): string {
  return typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
}

// ---------------------------------------------------------------------------
// Local record of the passkey registered on this device (no key material).
// ---------------------------------------------------------------------------

export interface RegisteredCredentialRecord {
  readonly credentialId: string;
  readonly label?: string;
  readonly registeredAt: number;
}

export function getRegisteredCredential(): RegisteredCredentialRecord | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(REGISTERED_CREDENTIAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RegisteredCredentialRecord;
    return typeof parsed?.credentialId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function setRegisteredCredential(record: RegisteredCredentialRecord): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(REGISTERED_CREDENTIAL_KEY, JSON.stringify(record));
  } catch {
    // A storage failure just means the assert step cannot pass allowCredentials; not fatal.
  }
}

export function clearRegisteredCredential(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(REGISTERED_CREDENTIAL_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// authenticatorData parsing, extract the COSE public key for registration
// ---------------------------------------------------------------------------

/**
 * Slice the COSE_Key public-key bytes out of an attestation's authenticatorData. The
 * fixed layout: 32 rpIdHash | 1 flags | 4 signCount | [16 aaguid | 2 credIdLen | credId |
 * COSE key]. Returns the COSE key bytes (the rest of the buffer) and the signature counter.
 * Returns null if the attested-credential-data (AT) flag is not set or the buffer is short.
 */
export function extractCosePublicKey(authData: ArrayBuffer): { publicKeyCose: Uint8Array; signCount: number } | null {
  const bytes = new Uint8Array(authData);
  if (bytes.length < 37) return null;
  const view = new DataView(authData);
  const flags = bytes[32];
  const signCount = view.getUint32(33, false);
  const attestedDataPresent = (flags & 0x40) !== 0;
  if (!attestedDataPresent) return null;
  // 37: aaguid(16), 53: credIdLen(2), 55: credId(credIdLen), then COSE key.
  if (bytes.length < 55) return null;
  const credIdLen = view.getUint16(53, false);
  const coseStart = 55 + credIdLen;
  if (bytes.length < coseStart) return null;
  return { publicKeyCose: bytes.slice(coseStart), signCount };
}

// ---------------------------------------------------------------------------
// Registration ceremony
// ---------------------------------------------------------------------------

export interface RegisterPasskeyResult {
  readonly credentialId: string;
  readonly publicKeyCose: string;
  readonly signCount: number;
  readonly rpId: string;
  readonly origin: string;
}

function normalizeCeremonyError(error: unknown, forCreate: boolean): StepUpError {
  if (error instanceof StepUpError) return error;
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError') {
    // Ambiguous by spec, either the user dismissed it or no matching authenticator.
    return new StepUpError(
      forCreate ? 'no-authenticator' : 'user-cancelled',
      forCreate
        ? 'No passkey could be created. The request was declined or no authenticator is available.'
        : 'Verification was cancelled or timed out.',
    );
  }
  if (name === 'InvalidStateError') {
    return new StepUpError('ceremony-failed', 'A passkey is already registered for this account on this authenticator.');
  }
  if (name === 'NotSupportedError' || name === 'SecurityError') {
    return new StepUpError('unsupported', 'This browser or connection cannot run the passkey ceremony.');
  }
  return new StepUpError('ceremony-failed', error instanceof Error ? error.message : String(error));
}

/**
 * Register a passkey on this device. Uses 'none' attestation (the daemon accepts it and only
 * stores the COSE public key). A random local challenge is used because the daemon does not
 * verify registration attestation, it trusts the first-registered public key on this device.
 */
export async function registerPasskey(options: { userName: string; userDisplayName?: string; label?: string }): Promise<RegisterPasskeyResult> {
  const availability = stepUpAvailability();
  if (!availability.supported) throw new StepUpError('unsupported', availability.reason ?? 'Passkeys are not supported here.');

  const rpId = relyingPartyId();
  const origin = relyingPartyOrigin();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { id: rpId, name: 'GoodVibes' },
        user: { id: userId, name: options.userName, displayName: options.userDisplayName ?? options.userName },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 / P-256
        authenticatorSelection: { userVerification: 'required' },
        attestation: 'none',
        timeout: 60_000,
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    throw normalizeCeremonyError(error, true);
  }
  if (!credential) throw new StepUpError('ceremony-failed', 'The authenticator returned no credential.');

  const response = credential.response as AuthenticatorAttestationResponse;
  if (typeof response.getAuthenticatorData !== 'function') {
    throw new StepUpError('ceremony-failed', 'This browser cannot expose the passkey public key needed to register it.');
  }
  const authData = response.getAuthenticatorData();
  const extracted = extractCosePublicKey(authData);
  if (!extracted) throw new StepUpError('ceremony-failed', 'The passkey did not include a usable public key.');

  return {
    credentialId: bytesToBase64Url(credential.rawId),
    publicKeyCose: bytesToBase64Url(extracted.publicKeyCose),
    signCount: extracted.signCount,
    rpId,
    origin,
  };
}

// ---------------------------------------------------------------------------
// Assertion ceremony
// ---------------------------------------------------------------------------

/**
 * Run navigator.credentials.get against a server-minted challenge and return the assertion
 * envelope + the ready-to-attach header value. `challenge` is the base64url the mint verb
 * returned. When a credentialId is known (registered on this device) it is passed as an
 * allowCredentials hint so the OS shows the right passkey.
 */
export async function runAssertion(options: { challenge: string; credentialId?: string }): Promise<{ envelope: StepUpAssertionEnvelope; headerValue: string }> {
  const availability = stepUpAvailability();
  if (!availability.supported) throw new StepUpError('unsupported', availability.reason ?? 'Passkeys are not supported here.');

  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: base64UrlToBytes(options.challenge),
    rpId: relyingPartyId(),
    userVerification: 'required',
    timeout: 60_000,
    ...(options.credentialId
      ? { allowCredentials: [{ type: 'public-key' as const, id: base64UrlToBytes(options.credentialId) }] }
      : {}),
  };

  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  } catch (error) {
    throw normalizeCeremonyError(error, false);
  }
  if (!assertion) throw new StepUpError('user-cancelled', 'No assertion was produced.');

  const response = assertion.response as AuthenticatorAssertionResponse;
  const envelope: StepUpAssertionEnvelope = {
    credentialId: bytesToBase64Url(assertion.rawId),
    authenticatorData: bytesToBase64Url(response.authenticatorData),
    clientDataJSON: bytesToBase64Url(response.clientDataJSON),
    signature: bytesToBase64Url(response.signature),
  };
  return { envelope, headerValue: encodeAssertionHeader(envelope) };
}
