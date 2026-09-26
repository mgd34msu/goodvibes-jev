/**
 * The `contract.*` settings (design 9.1): every key is in the schema with the
 * default the runner uses, `wrfc.*` keys are gone, ConfigManager resolves and
 * validates them, and readContractConfig reads each one with its guards.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../../sdk/src/platform/config/schema.js';
import { ConfigManager } from '../../sdk/src/platform/config/manager.js';
import {
  CONTRACT_CONFIG_DEFAULTS,
  getEnabledContractGates,
  readContractConfig,
  type ContractConfig,
  type ContractConfigReader,
} from '../../sdk/src/platform/contract/index.js';
import { readWrfcConfig } from '../../sdk/src/platform/agents/wrfc-config.js';

function makeConfigManager(): ConfigManager {
  const configDir = join(tmpdir(), `gv-contract-config-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ configDir });
}

/** A reader over plain values: `dotted` answers get('contract.<key>'), `category` answers getCategory('contract'). */
function reader(dotted: Record<string, unknown>, category?: Record<string, unknown>): ContractConfigReader {
  return {
    get: (key: string): unknown => dotted[key.replace(/^contract\./, '')],
    getCategory: (name: string): unknown => (name === 'contract' ? category : undefined),
  } as unknown as ContractConfigReader;
}

const SCALAR_KEYS = (Object.keys(CONTRACT_CONFIG_DEFAULTS) as (keyof ContractConfig)[]).filter((key) => key !== 'gates');

describe('the contract settings in the schema', () => {
  test('every scalar contract setting is a schema key whose default is the runner default', () => {
    for (const key of SCALAR_KEYS) {
      const setting = CONFIG_SCHEMA.find((entry) => entry.key === `contract.${key}`);
      expect(setting).toBeDefined();
      expect(setting!.default).toEqual(CONTRACT_CONFIG_DEFAULTS[key]);
    }
    const schemaContractKeys = CONFIG_SCHEMA.filter((entry) => entry.key.startsWith('contract.')).map((entry) => entry.key);
    expect(schemaContractKeys.sort()).toEqual(SCALAR_KEYS.map((key) => `contract.${key}`).sort());
  });

  test('the category defaults match the runner defaults, gates included', () => {
    expect(DEFAULT_CONFIG.contract).toEqual({ ...CONTRACT_CONFIG_DEFAULTS, gates: [] });
  });

  test('ui.contractMessages replaces ui.wrfcMessages, and no wrfc setting remains', () => {
    const ui = CONFIG_SCHEMA.find((entry) => entry.key === 'ui.contractMessages');
    expect(ui?.type).toBe('enum');
    expect(ui?.default).toBe('both');
    expect(ui?.enumValues).toEqual(['panel', 'conversation', 'both']);
    expect(CONFIG_SCHEMA.filter((entry) => /wrfc/i.test(entry.key))).toEqual([]);
    expect('wrfc' in DEFAULT_CONFIG).toBe(false);
  });

  test('the enum settings carry exactly their documented values', () => {
    const values = (key: string): readonly string[] | undefined => CONFIG_SCHEMA.find((entry) => entry.key === key)?.enumValues;
    expect(values('contract.commitScope')).toEqual(['off', 'scoped', 'all']);
    expect(values('contract.acceptanceStakes')).toEqual(['high', 'critical']);
    expect(values('contract.isolation')).toEqual(['auto', 'worktree', 'shared']);
  });
});

describe('ConfigManager and the contract settings', () => {
  test('resolves every default without throwing', () => {
    const manager = makeConfigManager();
    expect(manager.get('contract.commitScope')).toBe('scoped');
    expect(manager.get('contract.acceptanceStakes')).toBe('high');
    expect(manager.get('contract.maxActiveContracts')).toBe(6);
    expect(manager.get('ui.contractMessages')).toBe('both');
    expect(readContractConfig(manager)).toEqual(CONTRACT_CONFIG_DEFAULTS);
  });

  test('accepts the documented values and refuses others', () => {
    const manager = makeConfigManager();
    for (const value of ['off', 'scoped', 'all'] as const) {
      manager.set('contract.commitScope', value);
      expect(manager.get('contract.commitScope')).toBe(value);
    }
    expect(() => manager.set('contract.commitScope', 'everything' as never)).toThrow();
    manager.set('contract.acceptanceStakes', 'critical');
    expect(readContractConfig(manager).acceptanceStakes).toBe('critical');
    expect(() => manager.set('contract.acceptanceStakes', 'low' as never)).toThrow();
    expect(() => manager.set('contract.stallLimit', 0)).toThrow();
    expect(() => manager.set('contract.maxUnits', 1.5)).toThrow();
    expect(() => manager.set('contract.heartbeatTimeoutMs', -1)).toThrow();
    manager.set('contract.heartbeatTimeoutMs', 90_000);
    expect(readContractConfig(manager).heartbeatTimeoutMs).toBe(90_000);
  });

  test('gates are set through the category and read by readContractConfig', () => {
    const manager = makeConfigManager();
    manager.mergeCategory('contract', { gates: [{ name: 'test', command: 'bun test', enabled: true }, { name: 'lint', command: 'eslint .', enabled: false }] });
    expect(readContractConfig(manager).gates).toHaveLength(2);
    expect(getEnabledContractGates(manager).map((gate) => gate.name)).toEqual(['test']);
  });
});

describe('readContractConfig', () => {
  test('the dotted key wins over the category, and the category over the default', () => {
    expect(readContractConfig(reader({ stallLimit: 7 }, { stallLimit: 4 })).stallLimit).toBe(7);
    expect(readContractConfig(reader({}, { stallLimit: 4 })).stallLimit).toBe(4);
    expect(readContractConfig(reader({})).stallLimit).toBe(3);
  });

  test('a non-finite number is skipped at each step, so a loop bound can never be NaN or Infinity', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
      expect(readContractConfig(reader({ maxNudgesPerUnit: bad })).maxNudgesPerUnit).toBe(12);
      expect(readContractConfig(reader({ maxNudgesPerUnit: bad }, { maxNudgesPerUnit: 9 })).maxNudgesPerUnit).toBe(9);
    }
  });

  test('an enum value outside its set, or a non-boolean switch, falls through to the next source', () => {
    expect(readContractConfig(reader({ commitScope: 'everything' }, { commitScope: 'off' })).commitScope).toBe('off');
    expect(readContractConfig(reader({ isolation: 'vm' })).isolation).toBe('auto');
    expect(readContractConfig(reader({ midRunChecks: 'no' })).midRunChecks).toBe(true);
    expect(readContractConfig(reader({ autoCommit: true })).autoCommit).toBe(true);
  });

  test('malformed gate entries are dropped and a non-array gates value reads as none', () => {
    const gates = [
      { name: 'test', command: 'bun test', enabled: true },
      { name: 'broken', enabled: true },
      'lint',
      null,
    ];
    expect(readContractConfig(reader({}, { gates })).gates).toEqual([{ name: 'test', command: 'bun test', enabled: true }]);
    expect(readContractConfig(reader({}, { gates: 'bun test' })).gates).toEqual([]);
  });
});

describe('the review loop reads the contract settings until it is removed', () => {
  test('its fields follow their contract successors', () => {
    const config = readWrfcConfig(reader({
      maxFixRounds: 2,
      heartbeatTimeoutMs: 1000,
      commitScope: 'all',
      autoCommit: true,
      transportRetryLimit: 0,
      transportRetryDelayMs: 10,
    }, { gates: [{ name: 'test', command: 'bun test', enabled: true }] }));
    expect(config).toEqual({
      scoreThreshold: 9.9,
      maxFixAttempts: 2,
      autoCommit: true,
      commitScope: 'all',
      gates: [{ name: 'test', command: 'bun test', enabled: true }],
      agentHeartbeatTimeoutMs: 1000,
      transportRetryLimit: 0,
      transportRetryDelayMs: 10,
    });
  });
});
