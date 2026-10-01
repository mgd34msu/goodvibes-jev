/**
 * register-sw.ts, install the service worker (public/sw.js) at the root scope.
 *
 * Called once from main.tsx. Registration is gated on:
 *   - a production build (the SW caches immutable /assets/*, pointless and
 *     HMR-hostile in a normal dev session), OR the VITE_ENABLE_SW=1 escape
 *     hatch the Playwright harness sets so the SW can be exercised headlessly
 *     against the dev server;
 *   - service-worker support in the browser;
 *   - a secure context (HTTPS or localhost), a service worker cannot register
 *     over plain HTTP to a LAN IP, so we simply skip it there rather than
 *     throwing. The push settings surface explains the HTTPS requirement.
 *
 * Registration never blocks or breaks the app: a failure is logged and swallowed.
 */

export function shouldRegisterServiceWorker(): boolean {
  const enabled = import.meta.env.PROD || import.meta.env.VITE_ENABLE_SW === '1';
  if (!enabled) return false;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  if (typeof window !== 'undefined' && !window.isSecureContext) return false;
  return true;
}

export function registerServiceWorker(): void {
  if (!shouldRegisterServiceWorker()) return;

  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
      // A registration failure must never take the app down, it only means the
      // offline shell + push are unavailable this session.
      console.warn('Service worker registration failed:', error);
    });
  };

  // Defer to the load event so registration never contends with first paint, but if the
  // document has ALREADY loaded, register straight away. This function now runs after a
  // dynamic import (see bootstrap.ts / mount-app.tsx), so on a fast load the 'load' event
  // can have fired before we get here; a bare addEventListener('load') would then never
  // run and the service worker would silently never register.
  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}
