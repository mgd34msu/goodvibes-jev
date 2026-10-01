import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, type DaemonConfigPatch } from '../sdk/src/platform/config/manager.ts';
import { setManagedSettingLock } from '../sdk/src/platform/runtime/settings/control-plane.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'daemon-config-batch-'));
  const configDir = join(root, 'surface');
  const daemonTierPath = join(root, 'daemon', 'settings.json');
  const manager = new ConfigManager({ configDir, daemonTierPath });
  return { root, configDir, daemonTierPath, manager,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

const patch = { 'controlPlane.hostMode': 'network', 'controlPlane.webui.serve': true } as const;

describe('one daemon settings file batch', () => {
  test('observers and a fresh reader see the complete batch and unrelated settings survive', () => {
    const f = fixture();
    try {
      f.manager.set('web.port', 4321);
      const observed: unknown[] = [];
      for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
        f.manager.subscribe(key, () => observed.push([
          f.manager.get('controlPlane.hostMode'), f.manager.get('controlPlane.webui.serve'),
          JSON.parse(readFileSync(f.daemonTierPath, 'utf8')).controlPlane,
        ]));
      }
      f.manager.setDaemonValues(patch);
      expect(observed).toHaveLength(2);
      for (const values of observed) expect(values).toEqual(['network', true, { hostMode: 'network', webui: { serve: true } }]);
      const reopened = new ConfigManager({ configDir: f.configDir, daemonTierPath: f.daemonTierPath });
      expect(reopened.get('controlPlane.hostMode')).toBe('network');
      expect(reopened.get('controlPlane.webui.serve')).toBe(true);
      expect(reopened.get('web.port')).toBe(4321);
    } finally { f.close(); }
  });

  test('a lock on the last field refuses the whole patch without notifications or file changes', () => {
    const f = fixture();
    try {
      f.manager.set('controlPlane.hostMode', 'local');
      const before = f.manager.getRaw();
      const bytes = readFileSync(f.daemonTierPath, 'utf8');
      let notifications = 0;
      f.manager.subscribe('controlPlane.hostMode', () => { notifications++; });
      setManagedSettingLock('controlPlane.webui.serve', 'fixture', 'locked', f.configDir);
      expect(() => f.manager.setDaemonValues(patch)).toThrow('managed');
      expect(f.manager.getRaw()).toEqual(before);
      expect(readFileSync(f.daemonTierPath, 'utf8')).toBe(bytes);
      expect(notifications).toBe(0);
    } finally { f.close(); }
  });

  test('an actual atomic-write failure leaves live values unchanged and emits nothing', () => {
    const f = fixture();
    try {
      const before = f.manager.getRaw();
      let notifications = 0;
      f.manager.subscribe('controlPlane.hostMode', () => { notifications++; });
      // A regular file blocks creation of the target's parent directory.
      // It is owned by this fixture; no host permissions are changed.
      rmSync(join(f.root, 'daemon'), { recursive: true, force: true });
      writeFileSync(join(f.root, 'daemon'), 'preserved fixture');
      expect(() => f.manager.setDaemonValues(patch)).toThrow('not applied');
      expect(f.manager.getRaw()).toEqual(before);
      expect(readFileSync(join(f.root, 'daemon'), 'utf8')).toBe('preserved fixture');
      expect(notifications).toBe(0);
    } finally { f.close(); }
  });

  test('read-only and missing daemon ownership refuse before creating a daemon settings file', () => {
    const f = fixture();
    try {
      const reader = new ConfigManager({ configDir: f.configDir, daemonTierPath: f.daemonTierPath, readOnly: true });
      expect(() => reader.setDaemonValues(patch)).toThrow('read-only');
      const local = new ConfigManager({ configDir: join(f.root, 'local') });
      expect(() => local.setDaemonValues(patch)).toThrow('daemon settings file');
      expect(existsSync(f.daemonTierPath)).toBe(false);
    } finally { f.close(); }
  });

  test.each([
    { 'controlPlane.hostMode': 'fixture-private-value' },
    { 'controlPlane.webui.serve': 'fixture-private-value' },
    { 'controlPlane.port': Number.NaN },
    { 'provider.model': 'fixture-private-value' },
    { 'surfaces.email.password': 'fixture-private-value' },
    { 'fixture-private-key': 'fixture-private-value' },
  ])('invalid or out-of-scope patch fails without echoing values: %#', (invalid) => {
    const f = fixture();
    try {
      const before = f.manager.getRaw();
      let failure: unknown;
      try { f.manager.setDaemonValues({ ...patch, ...invalid } as DaemonConfigPatch); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain('fixture-private');
      expect(f.manager.getRaw()).toEqual(before);
      expect(existsSync(f.daemonTierPath)).toBe(false);
    } finally { f.close(); }
  });
});
