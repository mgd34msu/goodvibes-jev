/**
 * relay-pairing.ts, fragment parse/strip, decode, and local persistence.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  RELAY_PAIRING_STORAGE_KEY,
  clearStoredRelayPairing,
  decodeRelayPairingCode,
  encodeRelayPairingString,
  getStoredRelayPairing,
  parseRelayPairingFromHash,
  storeRelayPairing,
  stripRelayPairingFragment,
  takeRelayPairingCorruptionNotice,
  type RelayPairingPayload,
} from './relay-pairing';

const SAMPLE_PAYLOAD: RelayPairingPayload = {
  protocol: 1,
  relayUrl: 'wss://relay.example.com',
  rid: 'rid_abc123',
  daemonPublicKey: 'daemon-pubkey-base64url',
  label: 'My Daemon',
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
  window.localStorage.removeItem(RELAY_PAIRING_STORAGE_KEY);
});

describe('parseRelayPairingFromHash', () => {
  test('extracts the code from a bare relay fragment', () => {
    expect(parseRelayPairingFromHash('#relay=gvrelay1.abc')).toBe('gvrelay1.abc');
  });

  test('extracts the code when other fragment keys are present', () => {
    expect(parseRelayPairingFromHash('#view=chat&relay=gvrelay1.xyz')).toBe('gvrelay1.xyz');
  });

  test('tolerates a hash without the leading #', () => {
    expect(parseRelayPairingFromHash('relay=nohash')).toBe('nohash');
  });

  test('returns null for an empty or relay-less hash', () => {
    expect(parseRelayPairingFromHash('')).toBeNull();
    expect(parseRelayPairingFromHash('#')).toBeNull();
    expect(parseRelayPairingFromHash('#view=chat')).toBeNull();
  });

  test('treats a blank code as absent', () => {
    expect(parseRelayPairingFromHash('#relay=')).toBeNull();
    expect(parseRelayPairingFromHash('#relay=%20')).toBeNull();
  });

  test('does not pick up the unrelated `pair` key', () => {
    expect(parseRelayPairingFromHash('#pair=sometoken')).toBeNull();
  });
});

describe('stripRelayPairingFragment', () => {
  test('removes only the relay key, preserving path, query, and other fragment keys', () => {
    window.history.replaceState(null, '', '/?view=chat#view=chat&relay=gvrelay1.secret');
    stripRelayPairingFragment();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?view=chat');
    expect(window.location.hash).toBe('#view=chat');
    expect(parseRelayPairingFromHash(window.location.hash)).toBeNull();
  });

  test('clears the fragment entirely when relay was the only key', () => {
    window.history.replaceState(null, '', '/#relay=gvrelay1.secret');
    stripRelayPairingFragment();
    expect(window.location.hash).toBe('');
  });

  test('is a no-op when there is no relay key', () => {
    window.history.replaceState(null, '', '/?view=chat');
    stripRelayPairingFragment();
    expect(window.location.search).toBe('?view=chat');
    expect(window.location.hash).toBe('');
  });

  test('leaves an existing pair key untouched', () => {
    window.history.replaceState(null, '', '/#pair=tok&relay=gvrelay1.secret');
    stripRelayPairingFragment();
    expect(window.location.hash).toBe('#pair=tok');
  });
});

describe('decodeRelayPairingCode / encodeRelayPairingString round trip', () => {
  test('round-trips a payload through encode/decode', () => {
    const encoded = encodeRelayPairingString(SAMPLE_PAYLOAD);
    expect(encoded.startsWith('gvrelay1.')).toBe(true);
    const decoded = decodeRelayPairingCode(encoded);
    expect(decoded).toEqual(SAMPLE_PAYLOAD);
  });

  test('tolerates surrounding whitespace (paste artifacts)', () => {
    const encoded = encodeRelayPairingString(SAMPLE_PAYLOAD);
    const decoded = decodeRelayPairingCode(`  ${encoded}\n`);
    expect(decoded).toEqual(SAMPLE_PAYLOAD);
  });

  test('throws on a malformed code', () => {
    expect(() => decodeRelayPairingCode('not-a-relay-code')).toThrow();
  });

  test('throws on a code with a recognizable prefix but corrupt payload', () => {
    expect(() => decodeRelayPairingCode('gvrelay1.not-valid-base64url-json!!!')).toThrow();
  });
});

describe('local persistence', () => {
  test('getStoredRelayPairing returns null when nothing is stored', () => {
    expect(getStoredRelayPairing()).toBeNull();
  });

  test('storeRelayPairing then getStoredRelayPairing round-trips', () => {
    storeRelayPairing(SAMPLE_PAYLOAD);
    expect(getStoredRelayPairing()).toEqual(SAMPLE_PAYLOAD);
  });

  test('clearStoredRelayPairing removes it', () => {
    storeRelayPairing(SAMPLE_PAYLOAD);
    clearStoredRelayPairing();
    expect(getStoredRelayPairing()).toBeNull();
  });

  test('getStoredRelayPairing returns null for corrupt JSON rather than throwing', () => {
    window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, '{not json');
    expect(getStoredRelayPairing()).toBeNull();
  });

  test('getStoredRelayPairing returns null for a well-formed but incomplete object', () => {
    window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, JSON.stringify({ relayUrl: 'wss://x' }));
    expect(getStoredRelayPairing()).toBeNull();
  });

  test('corrupt JSON is actually cleared from storage (reset, not just a null read)', () => {
    window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, '{not json');
    getStoredRelayPairing();
    expect(window.localStorage.getItem(RELAY_PAIRING_STORAGE_KEY)).toBeNull();
  });

  test('an incomplete object is also cleared from storage', () => {
    window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, JSON.stringify({ relayUrl: 'wss://x' }));
    getStoredRelayPairing();
    expect(window.localStorage.getItem(RELAY_PAIRING_STORAGE_KEY)).toBeNull();
  });

  test('corrupt JSON surfaces a one-time notice', () => {
    window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, '{not json');
    getStoredRelayPairing();
    const notice = takeRelayPairingCorruptionNotice();
    expect(notice).not.toBeNull();
    // Consumed once, a second take is empty even though nothing new happened.
    expect(takeRelayPairingCorruptionNotice()).toBeNull();
  });

  test('an incomplete object surfaces the same one-time notice', () => {
    window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, JSON.stringify({ relayUrl: 'wss://x' }));
    getStoredRelayPairing();
    expect(takeRelayPairingCorruptionNotice()).not.toBeNull();
  });

  test('a well-formed stored pairing never produces a corruption notice', () => {
    storeRelayPairing(SAMPLE_PAYLOAD);
    getStoredRelayPairing();
    expect(takeRelayPairingCorruptionNotice()).toBeNull();
  });

  test('re-reading after the corrupt entry was cleared does not re-fire the notice', () => {
    window.localStorage.setItem(RELAY_PAIRING_STORAGE_KEY, '{not json');
    getStoredRelayPairing();
    takeRelayPairingCorruptionNotice();
    getStoredRelayPairing();
    expect(takeRelayPairingCorruptionNotice()).toBeNull();
  });
});
