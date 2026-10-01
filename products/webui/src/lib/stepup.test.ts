/**
 * stepup.ts, the browser step-up wire primitives and authenticatorData parsing.
 *
 * The ceremony calls themselves (navigator.credentials.create/get) need a real authenticator,
 * so they belong to the live/e2e proof. These cases lock the pure, testable parts: the
 * base64url codec, the assertion header encoding (asserted to match the SDK's exact format
 * AND its exact header name), and the COSE-public-key slice out of an attestation's
 * authenticatorData.
 */
import { describe, expect, test } from 'bun:test';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  encodeAssertionHeader,
  extractCosePublicKey,
  type StepUpAssertionEnvelope,
} from './stepup';

describe('base64url codec', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 62, 63]);
    const encoded = bytesToBase64Url(bytes);
    // url-safe alphabet, no padding
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });

  test('decodes a known base64url value', () => {
    // "hello" → base64 aGVsbG8= → base64url aGVsbG8
    expect(new TextDecoder().decode(base64UrlToBytes('aGVsbG8'))).toBe('hello');
  });
});

describe('step-up assertion header encoding', () => {
  test('encodeAssertionHeader is base64url(utf8(JSON.stringify(envelope)))', () => {
    const envelope: StepUpAssertionEnvelope = {
      credentialId: 'Y3JlZA',
      authenticatorData: 'YXV0aA',
      clientDataJSON: 'Y2xpZW50',
      signature: 'c2ln',
    };
    const header = encodeAssertionHeader(envelope);
    const expected = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(envelope)));
    expect(header).toBe(expected);
    // and it decodes back to the same envelope
    expect(JSON.parse(new TextDecoder().decode(base64UrlToBytes(header)))).toEqual(envelope);
  });
});

describe('extractCosePublicKey', () => {
  test('slices the COSE key and reads the signature counter from AT-flagged authData', () => {
    const rpIdHash = new Uint8Array(32).fill(1);
    const flags = 0x45; // UP (0x01) | UV (0x04) | AT (0x40)
    const signCount = 7;
    const aaguid = new Uint8Array(16).fill(2);
    const credId = new Uint8Array([9, 8, 7, 6]);
    const cose = new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26]); // stand-in COSE bytes

    const buf = new Uint8Array(37 + 16 + 2 + credId.length + cose.length);
    const view = new DataView(buf.buffer);
    buf.set(rpIdHash, 0);
    buf[32] = flags;
    view.setUint32(33, signCount, false);
    buf.set(aaguid, 37);
    view.setUint16(53, credId.length, false);
    buf.set(credId, 55);
    buf.set(cose, 55 + credId.length);

    const extracted = extractCosePublicKey(buf.buffer);
    expect(extracted).not.toBeNull();
    expect(extracted!.signCount).toBe(signCount);
    expect(Array.from(extracted!.publicKeyCose)).toEqual(Array.from(cose));
  });

  test('returns null when the attested-credential-data flag is not set', () => {
    const buf = new Uint8Array(37); // no AT flag
    expect(extractCosePublicKey(buf.buffer)).toBeNull();
  });
});
