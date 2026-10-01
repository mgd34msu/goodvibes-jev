import { describe, expect, test } from 'bun:test';
import {
  detectPushSupport,
  readNotificationPermission,
  urlBase64ToUint8Array,
  type PushEnv,
} from './push-support';

const secureFull: PushEnv = {
  isSecureContext: true,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
};

describe('detectPushSupport', () => {
  test('a secure context with all APIs is ok', () => {
    expect(detectPushSupport(secureFull)).toBe('ok');
  });

  test('an insecure context (plain-HTTP LAN) reports insecure-context, the actionable state', () => {
    expect(detectPushSupport({ ...secureFull, isSecureContext: false })).toBe('insecure-context');
  });

  test('missing APIs over insecure http still point at the secure-context fix', () => {
    expect(detectPushSupport({ isSecureContext: false, hasServiceWorker: false, hasPushManager: false, hasNotification: false })).toBe('insecure-context');
  });

  test('a secure context missing PushManager is unsupported', () => {
    expect(detectPushSupport({ ...secureFull, hasPushManager: false })).toBe('unsupported');
  });

  test('a secure context missing Notification is unsupported', () => {
    expect(detectPushSupport({ ...secureFull, hasNotification: false })).toBe('unsupported');
  });

  test('a secure context missing service workers is unsupported', () => {
    expect(detectPushSupport({ ...secureFull, hasServiceWorker: false })).toBe('unsupported');
  });
});

describe('readNotificationPermission', () => {
  test('maps granted/denied/default through, unsupported when the API is absent', () => {
    expect(readNotificationPermission({ permission: 'granted' })).toBe('granted');
    expect(readNotificationPermission({ permission: 'denied' })).toBe('denied');
    expect(readNotificationPermission({ permission: 'default' })).toBe('default');
    expect(readNotificationPermission(undefined)).toBe('unsupported');
    expect(readNotificationPermission({})).toBe('unsupported');
  });
});

describe('urlBase64ToUint8Array', () => {
  test('decodes a base64url VAPID key to bytes, handling missing padding and -/_ chars', () => {
    // "hello" is aGVsbG8 in base64url (no padding); classic base64 is aGVsbG8=.
    const bytes = urlBase64ToUint8Array('aGVsbG8');
    expect(Array.from(bytes)).toEqual([...'hello'].map((c) => c.charCodeAt(0)));
  });

  test('round-trips a value using the url-safe alphabet (- and _)', () => {
    // 0xFB 0xFF encodes to "-_8" in base64url (+/ would be "+/8" in classic).
    const bytes = urlBase64ToUint8Array('-_8');
    expect(Array.from(bytes)).toEqual([0xfb, 0xff]);
  });
});
