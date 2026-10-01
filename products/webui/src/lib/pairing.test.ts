/**
 * pairing.ts, fragment parse + history cleanup.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { parsePairingOffersFromHash, parsePairingTokenFromHash, stripPairingFragment } from './pairing';

afterEach(() => {
  // Reset the URL between cases (happy-dom carries it across tests).
  window.history.replaceState(null, '', '/');
});

describe('parsePairingTokenFromHash', () => {
  test('extracts the token from a bare pair fragment', () => {
    expect(parsePairingTokenFromHash('#pair=abc123')).toBe('abc123');
  });

  test('extracts the token when other fragment keys are present', () => {
    expect(parsePairingTokenFromHash('#view=chat&pair=tok_xyz')).toBe('tok_xyz');
  });

  test('tolerates a hash without the leading #', () => {
    expect(parsePairingTokenFromHash('pair=nohash')).toBe('nohash');
  });

  test('returns null for an empty or pair-less hash', () => {
    expect(parsePairingTokenFromHash('')).toBeNull();
    expect(parsePairingTokenFromHash('#')).toBeNull();
    expect(parsePairingTokenFromHash('#view=chat')).toBeNull();
  });

  test('treats a blank token as absent', () => {
    expect(parsePairingTokenFromHash('#pair=')).toBeNull();
    expect(parsePairingTokenFromHash('#pair=%20')).toBeNull();
  });
});

describe('stripPairingFragment', () => {
  test('removes only the pair key, preserving path, query, and other fragment keys', () => {
    window.history.replaceState(null, '', '/?view=chat#view=chat&pair=secret');
    stripPairingFragment();
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('?view=chat');
    expect(window.location.hash).toBe('#view=chat');
    expect(parsePairingTokenFromHash(window.location.hash)).toBeNull();
  });

  test('clears the fragment entirely when pair was the only key', () => {
    window.history.replaceState(null, '', '/#pair=secret');
    stripPairingFragment();
    expect(window.location.hash).toBe('');
  });

  test('is a no-op when there is no pair key', () => {
    window.history.replaceState(null, '', '/?view=chat');
    stripPairingFragment();
    expect(window.location.search).toBe('?view=chat');
    expect(window.location.hash).toBe('');
  });

  test('also strips the offers key when a hand-off link carried one', () => {
    window.history.replaceState(null, '', '/#pair=secret&offers=notifications,relay');
    stripPairingFragment();
    expect(window.location.hash).toBe('');
  });
});

describe('parsePairingOffersFromHash', () => {
  test('a plain token-only link (no offers key) carries no offers', () => {
    expect(parsePairingOffersFromHash('#pair=abc123')).toEqual([]);
  });

  test('extracts and normalizes the offer set in canonical order', () => {
    expect(parsePairingOffersFromHash('#pair=abc123&offers=passkey,notifications')).toEqual([
      'notifications',
      'passkey',
    ]);
  });

  test('dedupes and drops unrecognized kinds', () => {
    expect(parsePairingOffersFromHash('#pair=abc123&offers=relay,relay,bogus,passkey')).toEqual(['relay', 'passkey']);
  });

  test('an offers key with no pair key is meaningless, returns []', () => {
    expect(parsePairingOffersFromHash('#offers=notifications,relay')).toEqual([]);
  });

  test('an empty or offers-less hash returns []', () => {
    expect(parsePairingOffersFromHash('')).toEqual([]);
    expect(parsePairingOffersFromHash('#')).toEqual([]);
    expect(parsePairingOffersFromHash('#pair=abc123')).toEqual([]);
  });
});
