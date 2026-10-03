// ---------------------------------------------------------------------------
// connected-host-dial.test.ts
//
// `controlPlane.host` holds a BIND address. `0.0.0.0` and `::` mean "listen on
// every interface", they are normal things to bind to and they are not
// addresses anything can connect TO. Copying one into a dial URL is what
// produced `http://0.0.0.0:3421` and the refused profile calls.
//
// These pin the mapping itself, the fact that `doctor` prints the dialable
// form, and, just as important, that the ADVERTISED pairing URLs did NOT get
// swept into the same rule, because loopback on a phone is the phone.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  connectedHostBaseUrl,
  connectedHostPort,
  dialHostForConfiguredHost,
  urlHostForConfiguredHost,
  DEFAULT_CONNECTED_HOST_PORT,
  LOOPBACK_DIAL_HOST,
} from '../../config/connected-host-dial.ts';
import { inspectCliExternalRuntime } from '../../cli/external-runtime.ts';

describe('a wildcard bind is not a dial target', () => {
  test('both wildcard forms resolve to loopback', () => {
    expect(dialHostForConfiguredHost('0.0.0.0')).toBe(LOOPBACK_DIAL_HOST);
    expect(dialHostForConfiguredHost('::')).toBe(LOOPBACK_DIAL_HOST);
    expect(dialHostForConfiguredHost('[::]')).toBe(LOOPBACK_DIAL_HOST);
  });

  test('a real host is left exactly as configured', () => {
    expect(dialHostForConfiguredHost('192.168.1.40')).toBe('192.168.1.40');
    expect(dialHostForConfiguredHost('daemon.internal')).toBe('daemon.internal');
    expect(dialHostForConfiguredHost('::1')).toBe('::1');
  });

  test('a blank, absent or non-string host means the local daemon', () => {
    expect(dialHostForConfiguredHost('')).toBe(LOOPBACK_DIAL_HOST);
    expect(dialHostForConfiguredHost('   ')).toBe(LOOPBACK_DIAL_HOST);
    expect(dialHostForConfiguredHost(undefined)).toBe(LOOPBACK_DIAL_HOST);
    expect(dialHostForConfiguredHost(null)).toBe(LOOPBACK_DIAL_HOST);
    expect(dialHostForConfiguredHost(42)).toBe(LOOPBACK_DIAL_HOST);
  });

  test('surrounding whitespace does not defeat the wildcard match', () => {
    expect(dialHostForConfiguredHost('  0.0.0.0  ')).toBe(LOOPBACK_DIAL_HOST);
  });

  test('a bare IPv6 literal gets its brackets so the URL parses', () => {
    expect(urlHostForConfiguredHost('::1')).toBe('[::1]');
    expect(urlHostForConfiguredHost('[::1]')).toBe('[::1]');
    expect(urlHostForConfiguredHost('127.0.0.1')).toBe('127.0.0.1');
    expect(() => new URL(connectedHostBaseUrl('::1', 3421))).not.toThrow();
  });

  test('a missing or unusable port falls back rather than emitting NaN', () => {
    expect(connectedHostPort(undefined)).toBe(DEFAULT_CONNECTED_HOST_PORT);
    expect(connectedHostPort('nonsense')).toBe(DEFAULT_CONNECTED_HOST_PORT);
    expect(connectedHostPort(3999)).toBe(3999);
    expect(connectedHostBaseUrl('0.0.0.0', undefined)).toBe('http://127.0.0.1:3421');
    expect(connectedHostBaseUrl('0.0.0.0', 'nonsense')).not.toContain('NaN');
  });

  test('the whole base URL is built in one step', () => {
    expect(connectedHostBaseUrl('0.0.0.0', 3421)).toBe('http://127.0.0.1:3421');
    expect(connectedHostBaseUrl('::', 3421)).toBe('http://127.0.0.1:3421');
    expect(connectedHostBaseUrl('192.168.1.40', 8080)).toBe('http://192.168.1.40:8080');
  });
});

describe('doctor prints a dialable baseUrl', () => {
  /** A config reader bound to the wildcard, which is the reported case. */
  function wildcardConfig(): { get(key: string): unknown } {
    return {
      get: (key: string) => {
        if (key === 'controlPlane.host') return '0.0.0.0';
        if (key === 'controlPlane.port') return 3421;
        return undefined;
      },
    };
  }

  test('`goodvibes-agent doctor` reports loopback, not the wildcard bind', async () => {
    const snapshot = await inspectCliExternalRuntime({
      configManager: wildcardConfig() as never,
      homeDirectory: '/nonexistent-home-for-this-test',
      timeoutMs: 1,
    });
    // The line status.ts prints is `  baseUrl: ${snapshot.baseUrl}`.
    expect(snapshot.baseUrl).toBe('http://127.0.0.1:3421');
    expect(snapshot.baseUrl).not.toContain('0.0.0.0');
  });
});

describe('advertised addresses are deliberately NOT mapped to loopback', () => {
  test('urlHostForBindHost resolves a wildcard away from loopback', async () => {
    // A pairing QR code and the phone-facing web link are read by ANOTHER
    // device, where 127.0.0.1 is that device. This helper must therefore keep
    // resolving through the LAN address, it is not the dial helper, and the
    // sweep must never have merged the two.
    const { urlHostForBindHost } = await import('../../cli/management.ts');
    expect(urlHostForBindHost('0.0.0.0')).not.toBe('0.0.0.0');
    expect(urlHostForBindHost('192.168.1.40')).toBe('192.168.1.40');
  });
});
