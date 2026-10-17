/**
 * mount-app.tsx, the normal (secure-context) app boot: QueryClient + <App/> + SW.
 *
 * Split out of main.tsx so it is imported DYNAMICALLY, only after the entry guard
 * (src/lib/insecure-origin.ts) has cleared the origin. App's import graph pulls in
 * src/lib/goodvibes.ts, which constructs the SDK transport and THROWS at module
 * evaluation on an insecure non-local origin, importing it eagerly is exactly what made
 * that failure a silent white screen. Keeping this behind a dynamic import means the
 * throwing graph is never evaluated on the origins where the guard shows its message.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IdentityBoundary } from './components/auth/IdentityBoundary';
import App from './App';
import { registerServiceWorker } from './lib/pwa/register-sw';

export function mountApp(root: HTMLElement): void {
  createRoot(root).render(
    <StrictMode>
      <IdentityBoundary>
        <App />
      </IdentityBoundary>
    </StrictMode>,
  );

  // Install the service worker (offline app shell + Web Push). No-op in a normal
  // dev session and over plain HTTP; see register-sw.ts for the gating.
  registerServiceWorker();
}
