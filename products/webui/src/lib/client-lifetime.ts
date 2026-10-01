import { createBrowserTokenStore } from '@goodvibes-jev/engine/sdk/auth';

export const WEBUI_TOKEN_STORE_KEY = 'goodvibes.webui.token';
export const RELAY_PAIRING_STORAGE_KEY = 'goodvibes.webui.relayPairing';
const identityKeys = [WEBUI_TOKEN_STORE_KEY, `${WEBUI_TOKEN_STORE_KEY}.expiresAt`, RELAY_PAIRING_STORAGE_KEY];

/** Local generation only. Credentials and pairing material never leave this module. */
export interface ClientLifetime { readonly revision: number }
let lifetime: ClientLifetime = Object.freeze({ revision: 0 });
const listeners = new Set<() => void>();
const identity = (): readonly (string | null)[] | undefined => {
  try {
    const storage = globalThis.localStorage;
    return storage ? identityKeys.map((key) => storage.getItem(key)) : undefined;
  } catch { return undefined; }
};
let observed = identity();
// The SDK stores optional expiresAt as Unix milliseconds beside the token.
// Absence is supported for pasted tokens; malformed or elapsed expiry cannot
// support a semantic action. This does not assert that a token is authorized.
function canObserveCurrentIdentity(): boolean {
  if (observed === undefined) return false;
  if (observed[1] === null) return true;
  const expiry = Number(observed[1]);
  return Number.isFinite(expiry) && expiry > 0 && Date.now() < expiry;
}
let observable = canObserveCurrentIdentity();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function watchExpiry(): void {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  const expiry = Number(observed?.[1]);
  if (!observable || !Number.isFinite(expiry) || expiry <= Date.now()) return;
  const scheduledFor = lifetime;
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    if (lifetime !== scheduledFor) return;
    getClientLifetime();
    if (lifetime === scheduledFor) watchExpiry();
  }, Math.min(2_147_483_647, Math.max(1, expiry - Date.now())));
  // Browser timers are numbers; offline Node/Bun checks must not be kept alive
  // by a distant token expiry. No server/runtime module enters this graph.
  const handle: unknown = expiryTimer;
  if (typeof handle === 'object' && handle !== null && 'unref' in handle && typeof handle.unref === 'function') handle.unref();
}

export function invalidateClientLifetime(): void {
  lifetime = Object.freeze({ revision: lifetime.revision + 1 });
  observed = identity();
  observable = canObserveCurrentIdentity();
  watchExpiry();
  for (const listener of listeners) {
    try { listener(); } catch { /* An observer cannot prevent other requests from being invalidated. */ }
  }
}

/** Reconcile direct storage changes as well as the observed token-store writes. */
export function getClientLifetime(): ClientLifetime {
  const current = identity();
  if (current === undefined ? observed !== undefined
    : observed === undefined || current.some((value, index) => value !== observed?.[index])) invalidateClientLifetime();
  // Background tabs can delay timers. Adoption and execution always check the
  // clock synchronously, including exactly at the expiry boundary.
  else if (observable && !canObserveCurrentIdentity()) invalidateClientLifetime();
  return lifetime;
}

export function isClientLifetimeCurrent(snapshot: ClientLifetime): boolean {
  return getClientLifetime() === snapshot && observable;
}

export function subscribeClientLifetime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Observe the storage seam itself: SDK login, setToken, clearToken and expiring
// entries all pass here, including A → B → A before a pending request resumes.
export const tokenStore = createBrowserTokenStore({ key: WEBUI_TOKEN_STORE_KEY, storage: {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem(key, value) {
    const before = globalThis.localStorage.getItem(key);
    globalThis.localStorage.setItem(key, value);
    if (before !== value) invalidateClientLifetime();
  },
  removeItem(key) {
    const before = globalThis.localStorage.getItem(key);
    globalThis.localStorage.removeItem(key);
    if (before !== null) invalidateClientLifetime();
  },
} });

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== null && !identityKeys.includes(event.key)) return;
  try { if (event.storageArea !== null && event.storageArea !== window.localStorage) return; }
  catch { /* An unobservable storage identity must invalidate existing readings. */ }
  invalidateClientLifetime();
});
watchExpiry();
