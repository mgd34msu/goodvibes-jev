import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_SCHEMA, ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { runConfigCommand } from '../../daemon/config-command.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture() {
  const root = makeOwnedTempDir('config-command-safety');
  const options = { surfaceRoot: 'tui', configDir: join(root, 'config'), homeDir: join(root, 'home'), workingDir: join(root, 'work') };
  mkdirSync(options.homeDir, { recursive: true });
  mkdirSync(options.workingDir, { recursive: true });
  const manager = new ConfigManager(options);
  const disk = () => existsSync(manager.getConfigPath()) ? readFileSync(manager.getConfigPath(), 'utf8') : undefined;
  return { manager, options, disk };
}

for (const json of [false, true]) {
  test(`real manager rejects nested values without echoing them (json=${json})`, async () => {
    const { manager, disk } = fixture();
    const marker = 'owned-fixture-private-rejected-value';
    const before = disk();
    const previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    try {
      const result = await runConfigCommand(['set', 'pricing.modelPrices', JSON.stringify([[marker]])], { configManager: manager, json });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).not.toContain(marker);
      expect(result.lines.join('\n')).toContain('pricing.modelPrices');
      expect(result.lines.join('\n')).toContain('object');
      expect(result.lines.join('\n')).toContain('finite numbers');
      expect(disk()).toBe(before);
      expect(manager.get('pricing.modelPrices')).toEqual({});
    } finally { installJudgmentPort(previous); }
  });

  for (const seeded of [false, true]) {
    test(`classification refusal leaves real manager and disk unchanged (json=${json}, seeded=${seeded})`, async () => {
      const { manager, options, disk } = fixture();
      if (seeded) manager.set('pricing.modelPrices', { 'fixture:existing': { input: 1, output: 1 } });
      const before = disk();
      const oldValue = manager.get('pricing.modelPrices');
      const previous = installJudgmentPort(undefined);
      try {
        const value = { [`fixture:unavailable-${json}-${seeded}`]: { input: 2, output: 3 } };
        const result = await runConfigCommand(['set', 'pricing.modelPrices', JSON.stringify(value)], { configManager: manager, json }).catch(() => undefined);
        expect(disk()).toBe(before);
        expect(result?.exitCode).toBe(1);
        expect(result?.lines.join('\n')).not.toContain('fixture:unavailable');
        expect(manager.get('pricing.modelPrices')).toEqual(oldValue);
        expect(new ConfigManager(options).get('pricing.modelPrices')).toEqual(oldValue);
      } finally { installJudgmentPort(previous); }
    });
  }

  for (const verb of ['set', 'unset']) {
    test(`arbitrary ${verb} errors are value-free (json=${json})`, async () => {
      const { manager } = fixture();
      const marker = 'owned-fixture-private-error-detail';
      const fail = () => { throw new Error(marker); };
      const configManager = {
        get: manager.get.bind(manager), getRaw: manager.getRaw.bind(manager),
        getSchema: () => CONFIG_SCHEMA, getConfigPath: manager.getConfigPath.bind(manager),
        set: fail, reset: fail,
      };
      const result = await runConfigCommand([verb, 'controlPlane.port', ...(verb === 'set' ? ['1234'] : [])], { configManager, json });
      expect(result.exitCode).toBe(1);
      expect(result.lines.join('\n')).not.toContain(marker);
      expect(result.lines.join('\n')).toContain('controlPlane.port');
    });
  }
}

for (const json of [false, true]) {
  for (const verb of ['set', 'unset']) {
    test(`a post-${verb} reporting failure retains a redacted committed receipt (json=${json})`, async () => {
      const { manager } = fixture();
      const key = 'pricing.modelPrices';
      const marker = 'owned-fixture-unexpected-stored-value';
      const previous = installJudgmentPort(undefined);
      let committed = false;
      const configManager = {
        get: (): never => ({ [`fixture:post-write-${verb}-${json}`]: { authToken: marker } }) as never,
        getRaw: manager.getRaw.bind(manager), getSchema: () => CONFIG_SCHEMA,
        getConfigPath: manager.getConfigPath.bind(manager),
        set: () => { committed = true; }, reset: () => { committed = true; },
      };
      try {
        const result = await runConfigCommand([verb, key, ...(verb === 'set' ? ['{}'] : [])], { configManager, json });
        expect(committed).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.lines.join('\n')).toContain('<redacted>');
        expect(result.lines.join('\n')).not.toContain(marker);
        if (json) expect(JSON.parse(result.lines[0]!).data[verb === 'set' ? 'written' : 'reset']).toBe(true);
      } finally { installJudgmentPort(previous); }
    });
  }

  test(`real manager retains enum validation and money coercion (json=${json})`, async () => {
    const { manager } = fixture();
    const enumSetting = CONFIG_SCHEMA.find((setting) => setting.type === 'enum' && setting.enumValues?.length);
    expect(enumSetting).toBeDefined();
    const rejected = await runConfigCommand(['set', enumSetting!.key, 'owned-fixture-invalid-enum'], { configManager: manager, json });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.lines.join('\n')).toContain('Allowed:');
    expect(rejected.lines.join('\n')).not.toContain('owned-fixture-invalid-enum');
    const moneySetting = CONFIG_SCHEMA.find((setting) => setting.unit === 'money');
    expect(moneySetting).toBeDefined();
    const result = await runConfigCommand(['set', moneySetting!.key, '$1.25'], { configManager: manager, json });
    expect(result.exitCode).toBe(0);
    expect(result.lines.join('\n')).toContain('1.25');
    expect(result.lines.join('\n')).not.toContain('$1.25');
  });
}

for (const json of [false, true]) {
  test(`reset classification is prepared before mutation (json=${json})`, async () => {
    const { manager } = fixture();
    let resets = 0;
    const configManager = {
      get: manager.get.bind(manager), getRaw: manager.getRaw.bind(manager),
      getConfigPath: manager.getConfigPath.bind(manager), set: manager.set.bind(manager),
      reset: () => { resets += 1; },
      getSchema: () => CONFIG_SCHEMA.map((setting) => setting.key === 'pricing.modelPrices'
        ? { ...setting, default: { [`fixture:reset-default-${json}`]: { input: 1, output: 2 } } }
        : setting),
    };
    const previous = installJudgmentPort(undefined);
    try {
      const result = await runConfigCommand(['unset', 'pricing.modelPrices'], { configManager, json });
      expect(result.exitCode).toBe(1);
      expect(resets).toBe(0);
      expect(result.lines.join('\n')).toContain('settings were not changed');
    } finally { installJudgmentPort(previous); }
  });
}

for (const json of [false, true]) {
  test(`all malformed argument diagnostics omit raw input (json=${json})`, async () => {
    const { manager } = fixture();
    const marker = 'owned-fixture-private-argument';
    const calls = [
      [marker], ['list', marker], ['get', marker], ['unset', marker],
      ['set', marker, '1234'], ['set', marker], ['get', 'controlPlane.port', marker],
      ['unset', 'controlPlane.port', marker], ['set', 'controlPlane.port', '1234', marker],
    ];
    for (const args of calls) {
      const result = await runConfigCommand(args, { configManager: manager, json });
      expect(result.exitCode).not.toBe(0);
      expect(result.lines.join('\n')).not.toContain(marker);
    }
  });
  for (const verb of ['set', 'unset']) {
    test(`a failed post-${verb} read is redacted instead of reported unset (json=${json})`, async () => {
      const { manager } = fixture();
      const configManager = {
        get: (): never => { throw new Error('owned-fixture-private-read-error'); },
        getRaw: manager.getRaw.bind(manager), getSchema: () => CONFIG_SCHEMA,
        getConfigPath: manager.getConfigPath.bind(manager),
        set: () => {}, reset: () => {},
      };
      const result = await runConfigCommand([verb, 'controlPlane.port', ...(verb === 'set' ? ['1234'] : [])], { configManager, json });
      expect(result.exitCode).toBe(0);
      expect(result.lines.join('\n')).toContain('<redacted>');
      expect(result.lines.join('\n')).not.toContain('owned-fixture-private-read-error');
      if (json) expect(JSON.parse(result.lines[0]!).data[verb === 'set' ? 'written' : 'reset']).toBe(true);
    });
  }
}
