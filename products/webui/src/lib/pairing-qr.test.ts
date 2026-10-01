/**
 * pairing-qr, the scanner's parse boundary.
 *
 * The payload shapes asserted here are the ones the GoodVibes family actually
 * mints, not invented examples:
 *
 *   - COMPANION_JSON mirrors @goodvibes-jev/engine/sdk/platform/pairing's
 *     encodeConnectionPayload output field for field (url, token, username,
 *     version, surface). That is what goodvibes-app's /app/pairing/connection
 *     route serves and what the retired Android companion existed to read, so
 *     if this drifts the scanner has stopped replacing the app.
 *   - The `#pair=` links are built the way pairing.ts documents them.
 *   - The relay codes are produced by the transport package's own encoder
 *     rather than hand-written, so the `gvrelay1.` prefix under test is the
 *     real one.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { encodeRelayPairingString } from './relay-pairing';
import {
  describeScannedPairing,
  isDifferentOrigin,
  parseScannedPairing,
} from './pairing-qr';

const TOKEN = `op_tok_${randomUUID()}`;
const COMPANION_JSON = JSON.stringify({
  url: 'http://127.0.0.1:3421',
  token: TOKEN,
  username: 'admin',
  version: '2.0.17',
  surface: 'daemon',
});

const RELAY_CODE = encodeRelayPairingString({
  protocol: 1,
  relayUrl: 'wss://relay.example/ws',
  rid: 'rendezvous-abc',
  daemonPublicKey: 'ZGFlbW9uLWtleQ',
});

describe('parseScannedPairing: the SDK companion connection payload', () => {
  test('reads the token and the daemon address out of the JSON form', () => {
    const scanned = parseScannedPairing(COMPANION_JSON);
    expect(scanned.kind).toBe('token');
    expect(scanned).toMatchObject({ token: TOKEN, url: 'http://127.0.0.1:3421' });
  });

  test('tolerates the whitespace a scanner can pick up around the payload', () => {
    expect(parseScannedPairing(`  ${COMPANION_JSON}\n`)).toMatchObject({ kind: 'token', token: TOKEN });
  });

  test('the token wins over the "admin" username the payload always carries', () => {
    // Every companion payload ships username: 'admin' alongside the token. If
    // the username were allowed to decide, every scan would take the password
    // path and fail against a daemon whose bootstrap credential is long gone.
    const withPassword = JSON.stringify({ url: 'https://d.example', token: TOKEN, username: 'admin', password: 'pw' });
    expect(parseScannedPairing(withPassword)).toMatchObject({ kind: 'token', token: TOKEN });
  });

  test('falls to the password form when the payload carries no token', () => {
    const payload = JSON.stringify({ url: 'https://d.example', username: 'admin', password: 'hunter2' });
    expect(parseScannedPairing(payload)).toEqual({
      kind: 'password',
      username: 'admin',
      password: 'hunter2',
      url: 'https://d.example',
    });
  });

  test('accepts the alias keys the retired companion app minted', () => {
    const payload = JSON.stringify({ baseUrl: 'https://d.example', accessToken: TOKEN });
    expect(parseScannedPairing(payload)).toEqual({ kind: 'token', token: TOKEN, url: 'https://d.example' });
  });
});

describe('parseScannedPairing: the `goodvibes pair` hand-off link', () => {
  test('reads the token out of the fragment and the daemon from the origin', () => {
    const scanned = parseScannedPairing(`https://box.tailnet.ts.net/#pair=${TOKEN}`);
    expect(scanned).toEqual({ kind: 'token', token: TOKEN, url: 'https://box.tailnet.ts.net' });
  });

  test('ignores the offers key that rides alongside the token', () => {
    const scanned = parseScannedPairing(`https://box.tailnet.ts.net/?view=chat#pair=${TOKEN}&offers=notifications,relay`);
    expect(scanned).toMatchObject({ kind: 'token', token: TOKEN });
  });

  test('a link with an empty pair key is not a usable payload', () => {
    expect(() => parseScannedPairing('https://box.tailnet.ts.net/#pair=')).toThrow();
  });
});

describe('parseScannedPairing: relay pairing codes', () => {
  test('reads a bare gvrelay1 code', () => {
    expect(parseScannedPairing(RELAY_CODE)).toEqual({ kind: 'relay', relayCode: RELAY_CODE, url: undefined });
  });

  test('reads a relay code carried in a link fragment', () => {
    const scanned = parseScannedPairing(`https://box.tailnet.ts.net/#relay=${RELAY_CODE}`);
    expect(scanned).toMatchObject({ kind: 'relay', relayCode: RELAY_CODE });
  });

  test('a payload with both a token and a relay code signs in with the token', () => {
    const scanned = parseScannedPairing(`https://box.tailnet.ts.net/#pair=${TOKEN}&relay=${RELAY_CODE}`);
    expect(scanned).toMatchObject({ kind: 'token', token: TOKEN });
  });
});

describe('parseScannedPairing: the retired app custom scheme', () => {
  test('reads goodvibes://connect with a token', () => {
    const scanned = parseScannedPairing(`goodvibes://connect?baseUrl=https%3A%2F%2Fd.example&token=${TOKEN}`);
    expect(scanned).toEqual({ kind: 'token', token: TOKEN, url: 'https://d.example' });
  });

  test('reads goodvibes://connect with a username and password', () => {
    const scanned = parseScannedPairing('goodvibes://connect?baseUrl=https%3A%2F%2Fd.example&username=ada&password=lovelace');
    expect(scanned).toEqual({ kind: 'password', username: 'ada', password: 'lovelace', url: 'https://d.example' });
  });

  test('does not invent an origin for a custom-scheme payload that named no daemon', () => {
    expect(parseScannedPairing(`goodvibes://connect?token=${TOKEN}`)).toEqual({
      kind: 'token',
      token: TOKEN,
      url: undefined,
    });
  });

  test('reads a bare query string with no scheme at all', () => {
    expect(parseScannedPairing(`token=${TOKEN}&baseUrl=https%3A%2F%2Fd.example`)).toMatchObject({
      kind: 'token',
      token: TOKEN,
    });
  });
});

describe('parseScannedPairing: rejections', () => {
  test('an empty QR is rejected', () => {
    expect(() => parseScannedPairing('   ')).toThrow();
  });

  test('plain text that is not a payload at all is rejected', () => {
    expect(() => parseScannedPairing('WIFI:S=coffee;T=WPA;P=letmein;;')).toThrow();
  });

  test('a truncated JSON payload is rejected rather than half-read', () => {
    expect(() => parseScannedPairing('{"url":"https://d.example","token":"op_')).toThrow();
  });

  test('a JSON array is not a payload', () => {
    expect(() => parseScannedPairing('["token","abc"]')).toThrow();
  });

  test('someone else\'s https link with no GoodVibes fields is rejected', () => {
    expect(() => parseScannedPairing('https://example.com/promo?utm_source=poster')).toThrow();
  });

  test('a payload with a username but no password is rejected', () => {
    expect(() => parseScannedPairing('goodvibes://connect?username=ada')).toThrow();
  });

  test('a payload whose credential fields are all blank is rejected', () => {
    expect(() => parseScannedPairing('{"url":"https://d.example","token":"   "}')).toThrow();
  });
});

describe('describeScannedPairing: safe to render', () => {
  test('names the kind and the daemon without repeating the token', () => {
    const line = describeScannedPairing(parseScannedPairing(COMPANION_JSON));
    expect(line).toContain('http://127.0.0.1:3421');
    expect(line).not.toContain(TOKEN);
  });

  test('never repeats a scanned password', () => {
    const scanned = parseScannedPairing('goodvibes://connect?username=ada&password=lovelace');
    const line = describeScannedPairing(scanned);
    expect(line).toContain('ada');
    expect(line).not.toContain('lovelace');
  });

  test('describes a relay code without reproducing it', () => {
    const line = describeScannedPairing(parseScannedPairing(RELAY_CODE));
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toContain(RELAY_CODE);
  });
});

describe('isDifferentOrigin', () => {
  test('the same daemon on the same origin is not a mismatch', () => {
    expect(isDifferentOrigin('https://box.ts.net/', 'https://box.ts.net')).toBe(false);
  });

  test('a genuinely different host is a mismatch', () => {
    expect(isDifferentOrigin('http://127.0.0.1:3421', 'https://box.ts.net')).toBe(true);
  });

  test('a payload that named no daemon is never a mismatch', () => {
    expect(isDifferentOrigin(undefined, 'https://box.ts.net')).toBe(false);
  });

  test('an unparseable address is not reported as a mismatch', () => {
    expect(isDifferentOrigin('not-a-url', 'https://box.ts.net')).toBe(false);
  });
});
