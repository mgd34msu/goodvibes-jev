import { afterEach, describe, expect, test } from 'bun:test';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime, tokenStore, WEBUI_TOKEN_STORE_KEY } from './client-lifetime';

afterEach(async () => { await tokenStore.clearToken(); });

describe('client identity lifetime', () => {
  for (const storage of ['missing', 'throwing'] as const) {
    test(`a fresh module loads with ${storage} storage and exposes no current semantic identity`, async () => {
      const script = `Object.defineProperty(globalThis, 'localStorage', ${storage === 'missing'
        ? '{ configurable: true, value: undefined }'
        : '{ configurable: true, get() { throw new Error("Storage unavailable"); } }'});
        const lifetime = await import(${JSON.stringify(new URL('./client-lifetime.ts', import.meta.url).href)});
        if (lifetime.isClientLifetimeCurrent(lifetime.getClientLifetime())) process.exit(1);`;
      const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, `${out}\n${err}`).toBe(0);
    });
  }

  test('one throwing subscriber cannot stop cancellation or other subscribers', async () => {
    await tokenStore.setToken('offline-account-a');
    const original = getClientLifetime();
    const abort = new AbortController();
    const broken = subscribeClientLifetime(() => { throw new Error('Synthetic observer failure'); });
    const cancel = subscribeClientLifetime(() => abort.abort());
    try {
      await tokenStore.clearToken();
      expect(abort.signal.aborted).toBe(true);
      expect(isClientLifetimeCurrent(original)).toBe(false);
      expect(await tokenStore.getToken()).toBeNull();
    } finally { broken(); cancel(); }
  });

  test('all real token-store mutation entry points notify synchronously with only a local revision', async () => {
    await tokenStore.setToken('offline-account-a');
    const original = getClientLifetime();
    const seen: unknown[] = [];
    const stop = subscribeClientLifetime(() => seen.push(getClientLifetime()));
    const pending = tokenStore.setTokenEntry('offline-account-b', 1_900_000_000_000);
    expect(isClientLifetimeCurrent(original)).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    await pending;
    await tokenStore.clearToken();
    await tokenStore.setToken('offline-account-a');
    expect(isClientLifetimeCurrent(original)).toBe(false);
    expect(seen.every((entry) => Object.keys(entry as object).join() === 'revision')).toBe(true);
    expect(JSON.stringify(seen)).not.toContain('offline-account');
    stop();
  });

  test('another-tab A to B to A storage events invalidate even after storage has returned to A', async () => {
    await tokenStore.setToken('offline-account-a');
    const original = getClientLifetime();
    window.dispatchEvent(new window.StorageEvent('storage', { key: WEBUI_TOKEN_STORE_KEY, storageArea: window.localStorage,
      oldValue: 'offline-account-a', newValue: 'offline-account-b' }));
    window.dispatchEvent(new window.StorageEvent('storage', { key: WEBUI_TOKEN_STORE_KEY, storageArea: window.localStorage,
      oldValue: 'offline-account-b', newValue: 'offline-account-a' }));
    expect(isClientLifetimeCurrent(original)).toBe(false);
    expect(await tokenStore.getToken()).toBe('offline-account-a');
  });

  test('unrelated storage events do not invalidate the identity', async () => {
    await tokenStore.setToken('offline-account-a');
    const original = getClientLifetime();
    window.dispatchEvent(new window.StorageEvent('storage', { key: 'unrelated-theme', storageArea: window.localStorage }));
    expect(isClientLifetimeCurrent(original)).toBe(true);
  });
});
