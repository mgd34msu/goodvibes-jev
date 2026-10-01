/**
 * push-client.ts, the browser half of Web Push.
 *
 * Ties the browser's PushManager to the daemon's push.* verbs (via the
 * src/lib/goodvibes.ts facade): read the public VAPID key, subscribe this
 * device with PushManager, register that subscription with the daemon, and the
 * reverse to unsubscribe. The capability URL + key material live in the browser
 * only long enough to hand to push.subscriptions.create; the daemon stores them
 * and never hands them back (it returns the redacted view).
 *
 * Every failure is a named PushSubscribeError.reason, never a silent false,
 * the settings UI renders each one honestly (insecure context → the HTTPS
 * pointer; denied → how to re-enable in browser settings; unsupported → plain).
 */

import { sdk } from '../goodvibes';
import type { PublicPushSubscription, PushReconcileDrift } from '../goodvibes';
import { formatError } from '../errors';
import { randomUuid } from '../uuid';
import { detectPushSupport, urlBase64ToUint8Array } from './push-support';

export type PushSubscribeFailure =
  | 'insecure-context'
  | 'unsupported'
  | 'permission-denied'
  | 'no-registration'
  | 'subscribe-failed';

export class PushSubscribeError extends Error {
  readonly reason: PushSubscribeFailure;
  constructor(reason: PushSubscribeFailure, message: string) {
    super(message);
    this.name = 'PushSubscribeError';
    this.reason = reason;
  }
}

/**
 * Plain-language message for a push-subscription failure, shared by
 * NotificationSettings (the settings toggle) and PairingHandoffOffers (the
 * hand-off bundle's notifications offer), so the same failure reads the same
 * way regardless of which surface triggered it.
 */
export function describePushSubscribeError(error: unknown): string {
  if (error instanceof PushSubscribeError) {
    switch (error.reason) {
      case 'insecure-context':
        return 'Web Push needs a secure (HTTPS) connection. Open this app over HTTPS, for a home machine, `tailscale serve` fronts the daemon with an HTTPS hostname.';
      case 'permission-denied':
        return 'Notifications are blocked for this site. Re-enable them in your browser’s site settings, then try again.';
      case 'unsupported':
        return 'This browser does not support Web Push. On iOS, install the app to the Home Screen first (iOS 16.4+ delivers push only to an installed app).';
      case 'no-registration':
        return 'The service worker is not ready yet. Reload the page and try again.';
      default:
        return 'Could not complete the push subscription. Please try again.';
    }
  }
  return formatError(error);
}

/** The endpoint + key material extracted from a browser PushSubscription. */
export interface PushSubscriptionPayload {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

// The redacted daemon-side subscription id this device registered, kept so
// unsubscribe removes exactly this device's record (never every device the
// operator has, push.subscriptions.list is scoped to all of their devices).
const STORE_KEY = 'goodvibes.webui.push.subscriptionId';

function rememberSubscriptionId(id: string): void {
  try {
    window.localStorage.setItem(STORE_KEY, id);
  } catch {
    /* storage may be unavailable (private mode); non-fatal */
  }
}
function recallSubscriptionId(): string | null {
  try {
    return window.localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}
function forgetSubscriptionId(): void {
  try {
    window.localStorage.removeItem(STORE_KEY);
  } catch {
    /* non-fatal */
  }
}

// A stable per-install device identity (SDK 1.8.0's deviceId), so a browser
// whose push endpoint rotates presents the SAME identity with a NEW endpoint,
// the daemon heals its one record in place (push.subscriptions.reconcile)
// instead of accumulating a stale duplicate. Generated once and persisted;
// unlike STORE_KEY (the daemon-assigned record id) this is minted client-side
// and never changes for the life of this browser profile. Exported (not just
// the constant, its NAME) so tests can seed/assert a specific device identity
// rather than depend on an unpredictable generated uuid.
export const PUSH_DEVICE_ID_STORAGE_KEY = 'goodvibes.webui.push.deviceId';
const DEVICE_ID_KEY = PUSH_DEVICE_ID_STORAGE_KEY;

export function ensureDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const minted = randomUuid();
    window.localStorage.setItem(DEVICE_ID_KEY, minted);
    return minted;
  } catch {
    // Storage unavailable (private mode): fall back to a per-call id. Reconcile
    // still functions this session; it just cannot recognize itself across a
    // reload, so a later reload registers as a distinct device.
    return randomUuid();
  }
}

/**
 * Base64url-encode raw digest bytes, no padding, `+`/`/` swapped for `-`/`_`.
 * Matches Node's `Buffer.from(digest).toString('base64url')`, which is how the
 * daemon computes `endpointHash` (subscription-store.ts), this must produce
 * byte-identical output or every comparison would report false drift.
 */
function base64UrlFromDigest(digest: ArrayBuffer): string {
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The short, stable hash a client computes over its OWN live endpoint to
 * compare against the daemon's redacted `endpointHash`, reproduces
 * subscription-store.ts's `endpointHash()` (sha256, base64url, first 16 chars)
 * exactly, so a match here means the daemon's record is genuinely current, not
 * an artifact of a different hashing scheme.
 */
export async function computeEndpointHash(endpoint: string): Promise<string> {
  const data = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlFromDigest(digest).slice(0, 16);
}

/**
 * Pull the wire payload out of a browser PushSubscription's JSON. Pure and
 * browser-free so it is unit-testable; throws a named error when the browser
 * handed back a subscription missing its key material (never send a half one).
 */
export function extractSubscriptionPayload(json: PushSubscriptionJSON): PushSubscriptionPayload {
  const endpoint = json.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new PushSubscribeError('subscribe-failed', 'The browser returned an incomplete push subscription.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    throw new PushSubscribeError('unsupported', 'This browser has no service worker support.');
  }
  // serviceWorker.ready resolves once the SW controlling this page is active.
  return navigator.serviceWorker.ready;
}

/** True when this browser already has an active push subscription. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (detectPushSupport() !== 'ok') return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return (await registration.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Prompt for notification permission if needed, then create (or reuse) a
 * PushManager subscription against the daemon's VAPID key and return the
 * extracted endpoint/keys. Pure browser-side work, does NOT register
 * anything with the daemon; callers decide how (subscribeToPush registers via
 * push.subscriptions.create, the pairing hand-off flow hands the same payload
 * to pairing.handoff.complete's notifications accept instead).
 */
export async function ensureBrowserPushSubscription(): Promise<PushSubscriptionPayload> {
  const support = detectPushSupport();
  if (support === 'insecure-context') {
    throw new PushSubscribeError('insecure-context', 'Web Push needs a secure (HTTPS) connection.');
  }
  if (support === 'unsupported') {
    throw new PushSubscribeError('unsupported', 'This browser does not support Web Push.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushSubscribeError('permission-denied', 'Notifications are blocked for this site.');
  }

  const registration = await ensureRegistration();

  // Reuse an existing browser subscription if one is already present; only mint
  // a new one against the daemon's VAPID key otherwise.
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const { publicKey } = await sdk.operator.push.vapidKey();
    if (!publicKey) {
      throw new PushSubscribeError('subscribe-failed', 'The daemon returned no VAPID key.');
    }
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch {
      throw new PushSubscribeError('subscribe-failed', 'The browser refused to create a push subscription.');
    }
  }

  return extractSubscriptionPayload(subscription.toJSON());
}

/**
 * Subscribe this device: prompt for notification permission if needed, create
 * (or reuse) a PushManager subscription against the daemon's VAPID key, and
 * register it with the daemon. Returns the redacted daemon-side view.
 */
export async function subscribeToPush(): Promise<PublicPushSubscription> {
  const payload = await ensureBrowserPushSubscription();
  const { subscription: stored } = await sdk.operator.push.subscribe({ ...payload, deviceId: ensureDeviceId() });
  rememberSubscriptionId(stored.id);
  return stored;
}

/**
 * Unsubscribe this device: drop the browser PushManager subscription and remove
 * exactly this device's daemon-side record (by the id remembered at subscribe
 * time). Idempotent, safe to call when already unsubscribed.
 */
export async function unsubscribeFromPush(): Promise<void> {
  const storedId = recallSubscriptionId();
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    /* the browser side may already be gone; continue to the daemon side */
  }
  if (storedId) {
    try {
      await sdk.operator.push.unsubscribe(storedId);
    } finally {
      forgetSubscriptionId();
    }
  }
}

/** The outcome of a reconcile-on-open pass, for a caller that wants to react to it (e.g. a debug log). */
export interface PushReconcileOnOpenOutcome {
  /** 'not-subscribed' when this browser holds no live PushManager subscription at all, not an error. */
  readonly drift: PushReconcileDrift | 'not-subscribed';
  readonly subscription: PublicPushSubscription | null;
}

/**
 * Reconcile-on-open: called once per connected+signed-in edge (see
 * usePushSubscriptionReconcile). Compares this browser's LIVE PushManager
 * subscription against the daemon's served record for this device (deviceId +
 * endpointHash, both on the redacted PublicPushSubscription view) and calls
 * push.subscriptions.reconcile only when they actually differ, heal-in-place,
 * never a duplicate record, and no needless daemon write when nothing drifted.
 *
 * This is the DURABLE convergence point for the self-heal story: a real
 * `pushsubscriptionchange` rotation (public/sw.js) re-subscribes the browser
 * side and best-effort notifies any already-open tab, but the browser can also
 * rotate the endpoint while this app is fully closed, with no tab to notify,
 * the next time the operator opens the app, this catches that drift by
 * comparing against the daemon's own record, which the SW alone cannot
 * authenticate to update. A closed-app rotation with no reconcile is a real gap
 * this function does not fully close (see public/sw.js's header), it converges
 * as soon as the app is next opened, which is the same "durable eventually,
 * not instantly" promise the rest of the self-heal story keeps.
 *
 * A missing/unreadable live subscription is not an error (never subscribed, or
 * the permission was revoked), it reports 'not-subscribed' and does nothing.
 */
export async function reconcilePushSubscriptionOnOpen(): Promise<PushReconcileOnOpenOutcome> {
  if (detectPushSupport() !== 'ok') return { drift: 'not-subscribed', subscription: null };

  let subscription: PushSubscription | null;
  try {
    const registration = await navigator.serviceWorker.ready;
    subscription = await registration.pushManager.getSubscription();
  } catch {
    return { drift: 'not-subscribed', subscription: null };
  }
  if (!subscription) return { drift: 'not-subscribed', subscription: null };

  const deviceId = ensureDeviceId();
  const payload = extractSubscriptionPayload(subscription.toJSON());

  // Read the daemon's own record for this device before writing anything, an
  // unchanged device costs one read, never a needless reconcile write. A list
  // failure (e.g. a transient daemon hiccup) falls through to reconcile itself,
  // which is the authoritative call either way.
  let served: PublicPushSubscription | undefined;
  try {
    served = (await sdk.operator.push.list()).subscriptions.find((s) => s.deviceId === deviceId);
  } catch {
    served = undefined;
  }
  if (served) {
    const liveHash = await computeEndpointHash(payload.endpoint);
    if (liveHash === served.endpointHash) {
      rememberSubscriptionId(served.id);
      return { drift: 'unchanged', subscription: served };
    }
  }

  const { subscription: stored, drift } = await sdk.operator.push.reconcile({ ...payload, deviceId });
  rememberSubscriptionId(stored.id);
  return { drift, subscription: stored };
}

/** Send a live test push to this device's registered subscription. */
export async function sendTestPush(): Promise<void> {
  const storedId = recallSubscriptionId();
  if (!storedId) {
    throw new PushSubscribeError('no-registration', 'This device is not registered for push yet.');
  }
  await sdk.operator.push.verify(storedId);
}
