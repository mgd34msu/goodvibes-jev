/**
 * mockPushApis, install a fake serviceWorker + PushManager + Notification
 * before the app loads, so the push client runs its REAL logic (VAPID fetch →
 * subscribe → register with the daemon) against controllable fakes. Shared by
 * pwa.e2e.ts (the settings toggle) and pairing-handoff.e2e.ts (the hand-off
 * bundle's notifications offer), both drive the same browser-side ceremony.
 */
import type { Page } from '@playwright/test';

export interface MockPushApisOptions {
  /**
   * Seed an ALREADY-ACTIVE browser subscription (as if a prior session had
   * subscribed) so a test can drive the reconcile-on-open path,
   * usePushSubscriptionReconcile fires only when getSubscription() already
   * returns something; the plain subscribe flow covers the empty case.
   */
  preSubscribed?: boolean;
  endpoint?: string;
}

export async function mockPushApis(
  page: Page,
  permission: 'granted' | 'denied' | 'default',
  options: MockPushApisOptions = {},
): Promise<void> {
  const { preSubscribed = false, endpoint = 'https://push.example.test/endpoint-abc' } = options;
  await page.addInitScript(
    ({ perm, preSub, ep }) => {
      let current: unknown = null;
      const fakeSubscription = {
        endpoint: ep,
        toJSON() {
          return {
            endpoint: ep,
            keys: { p256dh: 'fake-p256dh-key', auth: 'fake-auth-key' },
          };
        },
        async unsubscribe() {
          current = null;
          return true;
        },
      };
      if (preSub) current = fakeSubscription;
      const fakeRegistration = {
        active: {},
        pushManager: {
          async getSubscription() {
            return current;
          },
          async subscribe() {
            current = fakeSubscription;
            return fakeSubscription;
          },
        },
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {
          ready: Promise.resolve(fakeRegistration),
          controller: {},
          async register() {
            return fakeRegistration;
          },
          addEventListener() {
            /* the stand-in service worker never emits events */
          },
        },
      });
      // A stand-in PushManager + Notification so detectPushSupport() reports 'ok'.
      (window as unknown as { PushManager: unknown }).PushManager = function () {
        /* presence-only stand-in, detectPushSupport checks the constructor exists */
      };
      (window as unknown as { Notification: unknown }).Notification = Object.assign(
        function () {
          /* presence-only stand-in, never constructed by the shell */
        },
        {
          permission: perm,
          async requestPermission() {
            return perm;
          },
        },
      );
    },
    { perm: permission, preSub: preSubscribed, ep: endpoint },
  );
}
