import { describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { setManagedSettingLock } from '@goodvibes-jev/engine/sdk/platform/runtime/settings';
import { runWebuiCommand } from '../../daemon/webui-command.js';
import { runPairCommand } from '../../daemon/pair-command.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('webui-transition');
  const configDir = join(root, 'config');
  const daemonTierPath = join(root, 'daemon', 'settings.json');
  const config = new ConfigManager({ configDir, daemonTierPath });
  const deps = {
    configManager: config,
    directoryExists: () => true,
    fileExists: () => true,
    probeStableHost: () => ({ hostname: 'fixture' }),
  };
  return { root, configDir, daemonTierPath, config, deps,
    reload: () => new ConfigManager({ configDir, daemonTierPath }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('webui setup preserves complete transitions', () => {
  for (const serving of [false, true]) {
    test.each([
      'controlPlane.hostMode', 'web.hostMode', 'controlPlane.webui.bundleDir',
      'controlPlane.webui.serve', 'web.enabled', 'web.publicBaseUrl',
    ] satisfies ConfigKey[])('a locked %s leaves a previously serving=' + serving + ' configuration unchanged', (key) => {
      const f = fixture();
      try {
        f.config.set('controlPlane.hostMode', 'network');
        f.config.set('web.hostMode', 'network');
        f.config.set('controlPlane.webui.serve', serving);
        f.config.set('controlPlane.webui.bundleDir', '/fixture/original');
        f.config.set('web.publicBaseUrl', '');
        const before = f.config.getRaw();
        const bytes = readFileSync(f.daemonTierPath, 'utf8');
        setManagedSettingLock(key, 'fixture-policy', 'fixture lock', f.configDir);
        const result = runWebuiCommand(['enable', '--bundle-dir', '/fixture/replacement', '--loopback'], f.deps);
        expect(result.exitCode).toBe(1);
        expect(f.config.getRaw()).toEqual(before);
        expect(f.reload().getRaw()).toEqual(before);
        expect(readFileSync(f.daemonTierPath, 'utf8')).toBe(bytes);
      } finally { f.close(); }
    });
  }

  test('a generated origin follows explicit LAN and loopback transitions through pairing', async () => {
    const f = fixture();
    try {
      expect(runWebuiCommand(['enable', '--bundle-dir', '/fixture/bundle'], f.deps).exitCode).toBe(0);
      expect(f.config.get('web.publicBaseUrl')).toBe('http://127.0.0.1:3421');
      expect(runWebuiCommand(['enable', '--lan'], f.deps).exitCode).toBe(0);
      expect(f.config.get('web.publicBaseUrl')).toBe('http://fixture.local:3421');
      const paired = await runPairCommand({
        configManager: f.reload(), daemonHomeDir: f.root, version: 'fixture',
        readToken: () => 'fixture-token',
        flags: { host: undefined, port: undefined, token: undefined, json: true, yes: false },
      });
      expect(JSON.parse(paired.lines[0]!).data.origin).toBe('http://fixture.local:3421');
      expect(runWebuiCommand(['enable', '--loopback'], f.deps).exitCode).toBe(0);
      expect(f.reload().get('web.publicBaseUrl')).toBe('http://127.0.0.1:3421');
    } finally { f.close(); }
  });

  test('a refused LAN transition preserves an already serving loopback binding and bundle', () => {
    const f = fixture();
    try {
      f.config.set('controlPlane.webui.serve', true);
      f.config.set('controlPlane.webui.bundleDir', '/fixture/original');
      const before = f.config.getRaw();
      const bytes = readFileSync(f.daemonTierPath, 'utf8');
      setManagedSettingLock('web.hostMode', 'fixture-policy', 'fixture lock', f.configDir);
      expect(runWebuiCommand(['enable', '--bundle-dir', '/fixture/replacement', '--lan'], f.deps).exitCode).toBe(1);
      expect(f.config.getRaw()).toEqual(before);
      expect(f.reload().getRaw()).toEqual(before);
      expect(readFileSync(f.daemonTierPath, 'utf8')).toBe(bytes);
    } finally { f.close(); }
  });

  test('a distinct custom public origin survives explicit posture changes', () => {
    const f = fixture();
    try {
      f.config.set('web.publicBaseUrl', 'https://operator.example/app');
      expect(runWebuiCommand(['enable', '--bundle-dir', '/fixture/bundle', '--lan'], f.deps).exitCode).toBe(0);
      expect(f.reload().get('web.publicBaseUrl')).toBe('https://operator.example/app');
      expect(runWebuiCommand(['enable', '--loopback'], f.deps).exitCode).toBe(0);
      expect(f.reload().get('web.publicBaseUrl')).toBe('https://operator.example/app');
    } finally { f.close(); }
  });
});
