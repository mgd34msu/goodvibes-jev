/**
 * usePushSubscriptionReconcile, reconcile-on-open for Web Push.
 *
 * Fires reconcilePushSubscriptionOnOpen (lib/push/push-client.ts) once on every
 * rising edge into `enabled` (App.tsx passes `health.connection === 'connected'
 * && auth.isSuccess`, mirroring useSessionRealtime/useRealtimeInvalidation's own
 * gate). A rising edge covers both the ordinary app-open case and a daemon
 * reconnect after an outage, either is a legitimate moment to notice that the
 * browser's push endpoint drifted from what the daemon has on record.
 *
 * Also listens for the service worker's `goodvibes-push-subscription-changed`
 * message (public/sw.js's pushsubscriptionchange handler, fired when the
 * browser rotates the endpoint on its own while this tab IS open) and
 * re-reconciles immediately rather than waiting for the next app open, the SW
 * cannot authenticate to the daemon itself (no access to this page's
 * localStorage-held token), so this page is what actually completes the heal.
 * The message's own payload is intentionally ignored; reconcile re-reads the
 * live subscription from PushManager itself, which ordering-wise is guaranteed
 * to already be the rotated one (the SW awaited the resubscribe before
 * posting), so there is nothing to double-carry.
 *
 * Silent by design: this is a background self-heal, not a user-facing action,
 * a failure (daemon hiccup, push unsupported, never subscribed) is swallowed
 * rather than surfaced, exactly like the reconcile function's own honest
 * 'not-subscribed' no-op. Nothing here blocks first paint or shows a spinner.
 */
import { useEffect } from 'react';
import { reconcilePushSubscriptionOnOpen } from '../lib/push/push-client';

const PUSH_SUBSCRIPTION_CHANGED_MESSAGE = 'goodvibes-push-subscription-changed';

export function usePushSubscriptionReconcile(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    void reconcilePushSubscriptionOnOpen().catch(() => undefined);

    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown } | null | undefined;
      if (data?.type === PUSH_SUBSCRIPTION_CHANGED_MESSAGE) {
        void reconcilePushSubscriptionOnOpen().catch(() => undefined);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [enabled]);
}
