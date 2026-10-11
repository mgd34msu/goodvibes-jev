/**
 * webui-command.test.ts, `goodvibes-daemon webui enable|disable|status`.
 *
 * The properties under test are the ones an installer and an operator both
 * depend on:
 *
 *   - `enable` never widens network exposure as a side effect. A daemon bound to
 *     loopback keeps serving to that machine only; widening is `--lan` and
 *     nothing else.
 *   - The URL it prints is the origin that actually answers, the CONTROL-PLANE
 *     one, because that is the listener serving the bundle. `web.port` is the
 *     surface's declared endpoint and nothing binds it, so a command that
 *     printed it would be handing out a URL that fails to connect.
 *   - A directory that is not a built bundle is refused before anything is
 *     written, so a daemon is never pointed at a path it cannot serve.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runWebuiCommand } from '../../daemon/webui-command.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

/** A ConfigManager stand-in over a plain record, recording every write. */
function fakeConfig(initial: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'controlPlane.hostMode': 'local',
    'controlPlane.host': '127.0.0.1',
    'controlPlane.port': 3421,
    'controlPlane.webui.serve': false,
    'controlPlane.webui.bundleDir': '',
    'web.enabled': true,
    'web.hostMode': 'local',
    'web.host': '127.0.0.1',
    'web.port': 3423,
    'web.publicBaseUrl': 'http://127.0.0.1:3423',
    'web.staticAssetsDir': 'dist/web',
    ...initial,
  };
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    writes,
    values,
    manager: {
      get: (key: string) => values[key],
      set: (key: string, value: unknown) => {
        writes.push({ key, value });
        values[key] = value;
      },
      setDaemonValues: (patch: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(patch)) {
          writes.push({ key, value });
          values[key] = value;
        }
      },
    } as never,
  };
}

/** A bundle directory the daemon can actually serve. */
function bundleDir(prefix: string): string {
  const dir = makeOwnedTempDir(prefix);
  writeFileSync(join(dir, 'index.html'), '<!doctype html>\n');
  return dir;
}

const loopbackProbe = () => ({ hostname: 'desk', gatewayInterfaceIp: '192.168.1.20' });

describe('webui custom IPv6 origins', () => {
  test.each([
    ['::1', '[::1]', true], ['[::1]', '[::1]', true],
    ['2001:db8::5', '[2001:db8::5]', false], ['[2001:db8::5]', '[2001:db8::5]', false],
  ] as const)('%s is usable in enable receipts and status', (host, authority, loopback) => {
    const config = fakeConfig({ 'controlPlane.hostMode': 'custom', 'controlPlane.host': host });
    const deps = { configManager: config.manager, directoryExists: () => true, fileExists: () => true, probeStableHost: loopbackProbe };
    const origin = `http://${authority}:3421`;
    const enabled = runWebuiCommand(['enable', '--bundle-dir', '/fixture/bundle'], deps);
    expect(enabled.exitCode).toBe(0);
    expect(config.values['web.publicBaseUrl']).toBe(origin);
    expect(new URL(String(config.values['web.publicBaseUrl'])).hostname).toBe(authority);
    const status = runWebuiCommand(['status'], deps);
    expect(status.lines.join('\n')).toContain(origin);
    expect(status.lines.join('\n')).toContain(loopback ? 'this machine only' : 'reachable from your network');
    expect(config.values['controlPlane.hostMode']).toBe('custom');
  });
});

describe('webui enable', () => {
  test('turns serving on, records the bundle, and reports the control-plane origin', () => {
    const dir = bundleDir('webui-enable');
    try {
      const config = fakeConfig();
      const result = runWebuiCommand(['enable', '--bundle-dir', dir], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(result.exitCode).toBe(0);
      expect(config.values['controlPlane.webui.serve']).toBe(true);
      expect(config.values['controlPlane.webui.bundleDir']).toBe(dir);
      expect(config.values['web.enabled']).toBe(true);
      // The control-plane port, not web.port, that is where the bundle is served.
      expect(result.lines.join('\n')).toContain('http://127.0.0.1:3421');
      expect(result.lines.join('\n')).not.toContain(':3423');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not touch the host mode, so a loopback daemon stays loopback', () => {
    const dir = bundleDir('webui-posture');
    try {
      const config = fakeConfig();
      const result = runWebuiCommand(['enable', '--bundle-dir', dir], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(config.writes.map((write) => write.key)).not.toContain('controlPlane.hostMode');
      expect(config.writes.map((write) => write.key)).not.toContain('web.hostMode');
      expect(result.lines.join('\n')).toContain('this machine only');
      expect(result.lines.join('\n')).toContain('--lan');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--lan is the one act that widens exposure, and says where it now answers', () => {
    const dir = bundleDir('webui-lan');
    try {
      const config = fakeConfig();
      const result = runWebuiCommand(['enable', '--bundle-dir', dir, '--lan'], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(result.exitCode).toBe(0);
      expect(config.values['controlPlane.hostMode']).toBe('network');
      expect(config.values['web.hostMode']).toBe('network');
      expect(result.lines.join('\n')).toContain('http://desk.local:3421');
      expect(result.lines.join('\n')).toContain('reachable from your network');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--loopback takes a LAN-bound daemon back to this machine only', () => {
    const dir = bundleDir('webui-narrow');
    try {
      const config = fakeConfig({ 'controlPlane.hostMode': 'network', 'controlPlane.host': '0.0.0.0' });
      const result = runWebuiCommand(['enable', '--bundle-dir', dir, '--loopback'], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(result.exitCode).toBe(0);
      expect(config.values['controlPlane.hostMode']).toBe('local');
      expect(result.lines.join('\n')).toContain('this machine only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('--lan and --loopback together are refused, and nothing is written', () => {
    const dir = bundleDir('webui-both');
    try {
      const config = fakeConfig();
      const result = runWebuiCommand(['enable', '--bundle-dir', dir, '--lan', '--loopback'], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(result.exitCode).toBe(2);
      expect(config.writes).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('replaces the shipped publicBaseUrl placeholder with the origin that answers', () => {
    const dir = bundleDir('webui-publicurl');
    try {
      const config = fakeConfig();
      runWebuiCommand(['enable', '--bundle-dir', dir], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(config.values['web.publicBaseUrl']).toBe('http://127.0.0.1:3421');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an operator-chosen publicBaseUrl is left alone and the difference is stated', () => {
    const dir = bundleDir('webui-publicurl-kept');
    try {
      const config = fakeConfig({ 'web.publicBaseUrl': 'https://desk.tailnet.ts.net' });
      const result = runWebuiCommand(['enable', '--bundle-dir', dir], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(config.values['web.publicBaseUrl']).toBe('https://desk.tailnet.ts.net');
      expect(result.lines.join('\n')).toContain('https://desk.tailnet.ts.net');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('webui enable: refusals', () => {
  test('a directory with no index.html is refused before anything is written', () => {
    const dir = makeOwnedTempDir('webui-empty');
    try {
      const config = fakeConfig();
      const result = runWebuiCommand(['enable', '--bundle-dir', dir], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).toContain('no index.html');
      expect(result.lines.join('\n')).toContain('Nothing was changed');
      expect(config.writes).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a path that does not exist is refused before anything is written', () => {
    const config = fakeConfig();
    const result = runWebuiCommand(['enable', '--bundle-dir', '/nonexistent/goodvibes-webui'], {
      configManager: config.manager,
      probeStableHost: loopbackProbe,
    });
    expect(result.exitCode).toBe(1);
    expect(config.writes).toHaveLength(0);
  });

  test('enable with no bundle anywhere names the flag rather than guessing', () => {
    const config = fakeConfig();
    const result = runWebuiCommand(['enable'], {
      configManager: config.manager,
      probeStableHost: loopbackProbe,
    });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('--bundle-dir');
    expect(config.writes).toHaveLength(0);
  });

  test('an unknown subcommand is refused with the usage line', () => {
    const config = fakeConfig();
    const result = runWebuiCommand(['start'], {
      configManager: config.manager,
      probeStableHost: loopbackProbe,
    });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join('\n')).toContain('Usage:');
  });
});

describe('webui disable and status', () => {
  test('disable turns serving off and keeps the bundle on disk', () => {
    const dir = bundleDir('webui-disable');
    try {
      const config = fakeConfig({ 'controlPlane.webui.serve': true, 'controlPlane.webui.bundleDir': dir });
      const result = runWebuiCommand(['disable'], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(result.exitCode).toBe(0);
      expect(config.values['controlPlane.webui.serve']).toBe(false);
      expect(config.values['controlPlane.webui.bundleDir']).toBe(dir);
      expect(result.lines.join('\n')).toContain(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('status with serving off says so and names the command that turns it on', () => {
    const config = fakeConfig();
    const result = runWebuiCommand(['status'], {
      configManager: config.manager,
      probeStableHost: loopbackProbe,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('not served');
    expect(result.lines.join('\n')).toContain('webui enable');
  });

  test('status reports a configured bundle that is no longer on disk as unusable', () => {
    const config = fakeConfig({
      'controlPlane.webui.serve': true,
      'controlPlane.webui.bundleDir': '/nonexistent/goodvibes-webui',
    });
    const result = runWebuiCommand(['status'], {
      configManager: config.manager,
      probeStableHost: loopbackProbe,
    });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('UNUSABLE');
  });

  test('status names the URL and the posture when serving is on', () => {
    const dir = bundleDir('webui-status');
    try {
      const config = fakeConfig({ 'controlPlane.webui.serve': true, 'controlPlane.webui.bundleDir': dir });
      const result = runWebuiCommand(['status'], {
        configManager: config.manager,
        probeStableHost: loopbackProbe,
      });
      expect(result.lines.join('\n')).toContain('http://127.0.0.1:3421');
      expect(result.lines.join('\n')).toContain('this machine only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no subcommand at all reads as status rather than doing anything', () => {
    const config = fakeConfig();
    const result = runWebuiCommand([], {
      configManager: config.manager,
      probeStableHost: loopbackProbe,
    });
    expect(result.exitCode).toBe(0);
    expect(config.writes).toHaveLength(0);
  });
});

describe('read-only machine WebUI binding status', () => {
  test('reports configured web endpoint without probing, inspecting the bundle, or writing', () => {
    const config = fakeConfig({ 'web.hostMode': 'custom', 'web.host': '127.0.0.2', 'web.port': 44323,
      'controlPlane.webui.serve': true, 'controlPlane.port': 44321 });
    const forbidden = () => { throw new Error('machine binding query must not probe or inspect a bundle'); };
    const result = runWebuiCommand(['status', '--json'], { configManager: config.manager,
      probeStableHost: forbidden, directoryExists: forbidden, fileExists: forbidden });
    expect(result.exitCode).toBe(0); expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!)).toEqual({ schema: 'goodvibes.daemon.webui-binding', schemaVersion: 1,
      source: 'configuration', endpoint: 'web', enabled: true, hostMode: 'custom', configuredHost: '127.0.0.2',
      host: '127.0.0.2', port: 44323, url: 'http://127.0.0.1:3423' });
    expect(config.writes).toEqual([]);
  });

  test.each([
    ['enable', '--json', '--bundle-dir', '/fixture/bundle'], ['disable', '--json'],
    ['status', '--json', '--lan'], ['status', '--json', '--loopback'], ['status', '--json', '--bundle-dir', '/fixture/bundle'],
  ].map((args) => ({ args })))('refuses mixing machine discovery with a mutation: %j', ({ args }) => {
    const config = fakeConfig();
    expect(runWebuiCommand(args, { configManager: config.manager }).exitCode).toBe(2);
    expect(config.writes).toEqual([]);
  });

  test('an unrecognized host mode never becomes a usable binding receipt', () => {
    const config = fakeConfig({ 'web.hostMode': 'Network' });
    const result = runWebuiCommand(['status', '--json'], { configManager: config.manager });
    expect(result.exitCode).toBe(2); expect(config.writes).toEqual([]);
  });
});
