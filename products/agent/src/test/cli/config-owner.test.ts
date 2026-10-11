import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { retainCliConfig } from '@goodvibes-jev/engine/terminal-shell';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('retained CLI configuration ownership', () => {
  let root: string;
  beforeEach(() => { root = makeProjectTempDir('agent-cli-config-owner'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const manager = () => new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root });

  test('native detached views remain current through repeated read-only guards', () => {
    const config = manager(); const retained = retainCliConfig(config);
    const original = config.getRaw();
    for (let i = 0; i < 1000; i++) retained.assertCurrent();
    expect(retained.raw).toEqual(original);
    expect(config.getRaw()).toEqual(original);
  });

  test.each(['replacement', 'ABA', 'no-op', 'save'] as const)('%s retires a native configuration view', mode => {
    const config = manager(); const retained = retainCliConfig(config);
    const currency = config.get('payments.currency');
    if (mode === 'save') config.save();
    else {
      config.setDynamic('payments.currency', mode === 'no-op' ? currency : currency === 'EUR' ? 'USD' : 'EUR');
      if (mode === 'ABA') config.setDynamic('payments.currency', currency);
    }
    expect(retained.assertCurrent).toThrow('CLI configuration owner changed');
  });

  test('borrowed mutable snapshots still retain complete source content', () => {
    const config = manager(); const borrowed = config.getRaw();
    config.getRaw = () => borrowed;
    const retained = retainCliConfig(config);
    borrowed.payments.currency = 'JPY';
    expect(retained.assertCurrent).toThrow('CLI configuration content changed');
  });

  test('replacing a getter with equal content cannot adopt a new owner', () => {
    const config = manager(); const retained = retainCliConfig(config);
    const original = config.getRaw(); config.getRaw = () => original;
    expect(retained.assertCurrent).toThrow('CLI configuration owner changed');
  });

  test('an accessor method is refused without invoking it', () => {
    const config = manager(); let invoked = 0;
    Object.defineProperty(config, 'getRaw', { configurable: true, get() { invoked++; return ConfigManager.prototype.getRaw; } });
    expect(() => retainCliConfig(config)).toThrow('must be data properties');
    expect(invoked).toBe(0);
  });

  test('changing only a method descriptor retires the view', () => {
    const config = manager(); const retained = retainCliConfig(config);
    Object.defineProperty(config, 'getRaw', { value: ConfigManager.prototype.getRaw, writable: false, configurable: true });
    expect(retained.assertCurrent).toThrow('CLI configuration owner changed');
  });
});
