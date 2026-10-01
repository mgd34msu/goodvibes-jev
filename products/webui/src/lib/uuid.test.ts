/**
 * uuid.test.ts: randomUuid must mint a well-formed v4 UUID on origins where
 * crypto.randomUUID does not exist at all (plain-HTTP LAN, the exact origin
 * where "crypto.randomUUID is not a function" crashed the hosted-sessions
 * view), not just where it does.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUuid } from './uuid';

const V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const originalRandomUUID = crypto.randomUUID;

afterEach(() => {
  Object.defineProperty(crypto, 'randomUUID', { value: originalRandomUUID, configurable: true, writable: true });
});

describe('randomUuid', () => {
  test('mints a v4 UUID when crypto.randomUUID exists', () => {
    expect(randomUuid()).toMatch(V4_SHAPE);
  });

  test('mints a v4 UUID when crypto.randomUUID is absent (insecure context)', () => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true, writable: true });
    const first = randomUuid();
    const second = randomUuid();
    expect(first).toMatch(V4_SHAPE);
    expect(second).toMatch(V4_SHAPE);
    expect(first).not.toBe(second);
  });
});
