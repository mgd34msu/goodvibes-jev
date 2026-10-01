/**
 * push-support.ts, can this browser receive Web Push here, and may it?
 *
 * Two separate honest questions, mirroring the microphone surface's stance
 * (src/lib/voice/stt-recorder.ts): a CAPABILITY question (does the platform
 * support service workers + Push + Notifications, in a secure context) and a
 * PERMISSION question (has the user granted notifications). Every "no" is a
 * named, actionable state, never a dead toggle:
 *
 *   - 'insecure-context'  the page is plain HTTP on a LAN IP, so the browser
 *                         refuses service workers / Push. The fix is to reach
 *                         it over HTTPS, the same Tailscale-serve pointer the
 *                         dictation surface uses.
 *   - 'unsupported'       the browser lacks the APIs even over HTTPS (e.g. an
 *                         iOS build too old for web push, or Push disabled).
 *   - 'ok'                service workers + Push + Notifications are available.
 *
 * base64url helpers: the daemon's public VAPID key is a base64url string;
 * PushManager.subscribe wants it as a Uint8Array applicationServerKey.
 */

export type PushSupport = 'ok' | 'insecure-context' | 'unsupported';

/** The browser's Notification permission, plus 'unsupported' when the API is absent. */
export type NotificationPermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

export interface PushEnv {
  readonly isSecureContext: boolean;
  readonly hasServiceWorker: boolean;
  readonly hasPushManager: boolean;
  readonly hasNotification: boolean;
}

function browserPushEnv(): PushEnv {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return { isSecureContext: false, hasServiceWorker: false, hasPushManager: false, hasNotification: false };
  }
  const w = window as unknown as { isSecureContext?: boolean; PushManager?: unknown; Notification?: unknown };
  return {
    // Browsers treat localhost as a secure context even over plain http.
    isSecureContext: w.isSecureContext === true,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: typeof w.PushManager !== 'undefined',
    hasNotification: typeof w.Notification !== 'undefined',
  };
}

/** Classify whether Web Push can be used here, before any subscribe is attempted. */
export function detectPushSupport(env: PushEnv = browserPushEnv()): PushSupport {
  const hasApis = env.hasServiceWorker && env.hasPushManager && env.hasNotification;
  if (!hasApis) {
    // On plain HTTP to a non-localhost host the APIs are simply absent, report
    // the actionable insecure-context state (open it over HTTPS) rather than a
    // bare 'unsupported', so the pointer tells the operator how to fix it.
    if (!env.isSecureContext) return 'insecure-context';
    return 'unsupported';
  }
  if (!env.isSecureContext) return 'insecure-context';
  return 'ok';
}

/** Read the current Notification permission without prompting. */
export function readNotificationPermission(
  notification: { permission?: string } | undefined =
    typeof window !== 'undefined' ? (window as unknown as { Notification?: { permission?: string } }).Notification : undefined,
): NotificationPermissionState {
  if (!notification || typeof notification.permission !== 'string') return 'unsupported';
  if (notification.permission === 'granted') return 'granted';
  if (notification.permission === 'denied') return 'denied';
  return 'default';
}

/**
 * Decode a base64url VAPID key into the Uint8Array PushManager.subscribe wants.
 * Pure and environment-free so it is unit-testable without a browser.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // Back the view with a concrete ArrayBuffer (not the generic ArrayBufferLike)
  // so it satisfies the BufferSource applicationServerKey expects.
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}
