import { describe, test, expect } from 'bun:test';
import { resolvePairingWebOrigin, ensurePublicBaseUrl, isHttpOnLan } from '../sdk/src/platform/pairing/web-origin.ts';
import type { StableHostInputs } from '../sdk/src/platform/pairing/stable-host.ts';
import type { ConfigKey, ConfigManager } from '../sdk/src/platform/config/index.ts';

/**
 * Minimal config double: a map of keys to values, plus a setDynamic recorder.
 *
 * `get` is cast through `unknown` straight to ConfigManager's own method type
 * (rather than reconstructed as an independent generic signature): the SDK's
 * ConfigValue mapped type is a very large discriminated union, and asking the
 * compiler to structurally verify a freshly-written `get<K extends
 * ConfigKey>` against it here hits TS's "excessive stack depth" recursion
 * limit (TS2321), a compiler limitation, not a real type mismatch.
 */
function fakeConfig(initial: Record<string, unknown>) {
  const store = { ...initial };
  const writes: Array<[string, unknown]> = [];
  return {
    store,
    writes,
    get: ((key: string) => store[key]) as unknown as ConfigManager['get'],
    setDynamic: (key: ConfigKey, value: unknown) => {
      store[key] = value;
      writes.push([key, value]);
    },
  };
}

const stableProbe = (): StableHostInputs => ({ hostname: 'workshop', gatewayInterfaceIp: '192.168.1.42' });
const unstableProbe = (): StableHostInputs => ({ hostname: 'localhost', gatewayInterfaceIp: '192.168.1.42' });

describe('resolvePairingWebOrigin', () => {
  test.each(['direct', 'proxy', 'off'])('bundled fallback uses the local listener scheme for TLS mode %s', (mode) => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': '', 'controlPlane.webui.serve': true, 'controlPlane.tls.mode': mode });
    expect(resolvePairingWebOrigin(cfg, stableProbe, { host: '127.0.0.1', port: 5678 }).origin)
      .toBe(`${mode === 'direct' ? 'https' : 'http'}://127.0.0.1:5678`);
  });
  test.each(['', 'http://127.0.0.1:3423'])('bundled fallback uses its control-plane listener for %s', (publicUrl) => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': publicUrl, 'web.port': 7777,
      'controlPlane.webui.serve': true, 'controlPlane.hostMode': 'network', 'controlPlane.port': 4567 });
    expect(resolvePairingWebOrigin(cfg, stableProbe).origin).toBe('http://workshop.local:4567');
    expect(resolvePairingWebOrigin(cfg, stableProbe, { host: '::1', port: 5678 }).origin).toBe('http://[::1]:5678');
    expect(cfg.writes).toEqual([]);
  });

  test('an explicit public URL remains authoritative over a bundled bound observation', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': 'https://vibes.example/app/', 'controlPlane.webui.serve': true });
    expect(resolvePairingWebOrigin(cfg, stableProbe, { host: '127.0.0.1', port: 5678 })).toMatchObject({
      origin: 'https://vibes.example/app', fromPublicBaseUrl: true,
    });
    expect(cfg.writes).toEqual([]);
  });

  test('a user-set web.publicBaseUrl is authoritative and never re-derived', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': 'https://vibes.example/' });
    const resolved = resolvePairingWebOrigin(cfg, stableProbe);
    expect(resolved.origin).toBe('https://vibes.example'); // trailing slash trimmed
    expect(resolved.fromPublicBaseUrl).toBe(true);
    expect(resolved.httpOnLan).toBe(false); // https
  });

  test('empty publicBaseUrl derives http://<stable-host>:<web-port>', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': '', 'web.hostMode': 'network', 'web.port': 3141 });
    const resolved = resolvePairingWebOrigin(cfg, stableProbe);
    expect(resolved.origin).toBe('http://workshop.local:3141');
    expect(resolved.fromPublicBaseUrl).toBe(false);
    expect(resolved.httpOnLan).toBe(true);
  });

  test.each([
    ['::1', '[::1]', false], ['[::1]', '[::1]', false],
    ['2001:db8::5', '[2001:db8::5]', true], ['[2001:db8::5]', '[2001:db8::5]', true],
  ] as const)('custom IPv6 host %s retains URL authority brackets', (host, authority, onLan) => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': '', 'web.hostMode': 'custom', 'web.host': host, 'web.port': 3141 });
    const resolved = resolvePairingWebOrigin(cfg, stableProbe);
    expect(resolved.origin).toBe(`http://${authority}:3141`);
    expect(new URL(resolved.origin).hostname).toBe(authority);
    expect(resolved.httpOnLan).toBe(onLan);
    expect(cfg.writes).toEqual([]);
  });
});

describe('ensurePublicBaseUrl', () => {
  test('bundled placeholder resolution does not authorize overwriting a stored URL', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': 'http://127.0.0.1:3423',
      'controlPlane.webui.serve': true, 'controlPlane.hostMode': 'network', 'controlPlane.port': 4567 });
    expect(ensurePublicBaseUrl(cfg, stableProbe).origin).toBe('http://workshop.local:4567');
    expect(cfg.writes).toEqual([]);
  });
  test('persists the derived origin once when a stable name exists', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': '', 'web.hostMode': 'network', 'web.port': 3141 });
    const resolved = ensurePublicBaseUrl(cfg, stableProbe);
    expect(resolved.origin).toBe('http://workshop.local:3141');
    expect(cfg.writes).toEqual([['web.publicBaseUrl', 'http://workshop.local:3141']]);
    // Idempotent: a second call sees the now-set value and does not write again.
    const again = ensurePublicBaseUrl(cfg, stableProbe);
    expect(again.fromPublicBaseUrl).toBe(true);
    expect(cfg.writes).toHaveLength(1);
  });

  test('does NOT freeze a DHCP-bound address into config', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': '', 'web.hostMode': 'network', 'web.port': 3141 });
    const resolved = ensurePublicBaseUrl(cfg, unstableProbe);
    expect(resolved.origin).toBe('http://192.168.1.42:3141');
    expect(cfg.writes).toEqual([]); // unstable ⇒ not persisted
  });

  test('never clobbers a user-set value', () => {
    const cfg = fakeConfig({ 'web.publicBaseUrl': 'https://mine.example' });
    ensurePublicBaseUrl(cfg, stableProbe);
    expect(cfg.writes).toEqual([]);
    expect(cfg.store['web.publicBaseUrl']).toBe('https://mine.example');
  });
});

describe('isHttpOnLan', () => {
  test.each([
    ['http://workshop.local:3141', true],
    ['http://192.168.1.5:3141', true],
    ['http://127.0.0.1:3141', false],
    ['http://localhost:3141', false],
    ['http://[::1]:3141', false],
    ['http://127.0.0.2:3141', false],
    ['http://app.localhost:3141', false],
    ['https://app.example', false],
  ])('%s -> %p', (origin, expected) => {
    expect(isHttpOnLan(origin as string)).toBe(expected);
  });
});
