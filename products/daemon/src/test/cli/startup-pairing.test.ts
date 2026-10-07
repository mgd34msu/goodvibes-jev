import { expect, test } from 'bun:test';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { renderDaemonStartupPairing } from '../../cli/startup-pairing.js';

function config(values: Record<string, unknown>): Pick<ConfigManager, 'get'> {
  return { get: ((key: string) => values[key]) as ConfigManager['get'] };
}
const bound = { host: '127.0.0.1', port: 54321 };
const token = 'synthetic-private-pairing-token';

test('an explicitly configured external WebUI remains usable without a local bundle', () => {
  const output = renderDaemonStartupPairing(config({
    'web.publicBaseUrl': 'https://web.example/app/', 'controlPlane.webui.serve': false,
  }), bound, token, 'test');
  expect(output).toContain(`https://web.example/app/#pair=${token}`);
  expect(output).not.toContain(String(bound.port));
});

test.each([false, true])('missing bundled surface never prints a dead pairing link: enabled=%s', (enabled) => {
  const output = renderDaemonStartupPairing(config({
    'web.publicBaseUrl': 'http://127.0.0.1:3423', 'controlPlane.webui.serve': enabled,
  }), bound, token, 'test');
  expect(output).toContain('Device pairing link unavailable:');
  expect(output).not.toContain(token); expect(output).not.toContain('3423'); expect(output).not.toContain('scan to pair');
});

test.each(['https://user:private-password@web.example/', 'https://web.example/?private-query',
  'https://web.example/#private-fragment', 'javascript:private-code', 'https://web.example/\nprivate-control',
  'https://web.example/#', 'https://web.example/?', 'http://0.0.0.0:3421', 'http://[::]:3421'])('invalid WebUI origin remains value-free: %s', (url) => {
  const output = renderDaemonStartupPairing(config({ 'web.publicBaseUrl': url }), bound, token, 'test');
  expect(output).toBe('Device pairing link unavailable: the configured WebUI URL is not a usable HTTP(S) origin.');
  expect(output).not.toContain('private-'); expect(output).not.toContain(token);
});
