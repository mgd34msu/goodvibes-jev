import { describe, expect, test } from 'bun:test';
import { extractSubscriptionPayload, PushSubscribeError } from './push-client';

describe('extractSubscriptionPayload', () => {
  test('pulls endpoint + p256dh/auth out of a browser PushSubscription JSON', () => {
    const payload = extractSubscriptionPayload({
      endpoint: 'https://push.example/abc',
      expirationTime: null,
      keys: { p256dh: 'PKEY', auth: 'AKEY' },
    });
    expect(payload).toEqual({ endpoint: 'https://push.example/abc', keys: { p256dh: 'PKEY', auth: 'AKEY' } });
  });

  test('a subscription missing key material is refused, never sent half-formed', () => {
    expect(() => extractSubscriptionPayload({ endpoint: 'https://push.example/abc', keys: {} } as PushSubscriptionJSON))
      .toThrow(PushSubscribeError);
    expect(() => extractSubscriptionPayload({ keys: { p256dh: 'P', auth: 'A' } } as PushSubscriptionJSON))
      .toThrow(PushSubscribeError);
  });

  test('the refusal carries the subscribe-failed reason', () => {
    try {
      extractSubscriptionPayload({ endpoint: '', keys: { p256dh: '', auth: '' } } as PushSubscriptionJSON);
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PushSubscribeError);
      expect((error as PushSubscribeError).reason).toBe('subscribe-failed');
    }
  });
});
