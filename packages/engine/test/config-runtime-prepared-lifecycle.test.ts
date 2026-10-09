import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import * as atomic from '../sdk/src/platform/utils/atomic-json-store.ts';
import { CONFIG_SCHEMA } from '../sdk/src/platform/config/schema.ts';
const roots: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runtime-prepared-')); roots.push(root);
  const configDir = join(root, 'config'); mkdirSync(configDir);
  const config = new ConfigManager({ configDir, sharedTierPath: join(root, 'shared.json') });
  config.setRuntimeOverride('provider.model', 'synthetic:cli');
  config.setRuntimeOverride('tts.voice', 'synthetic-cli-voice');
  return config;
}
function write(path: string, value: unknown) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); }

test('committed prepared set retires only its key before subscribers reenter load', () => {
  const config = fixture();
  const seen: unknown[] = [];
  config.subscribe('provider.model', () => { config.load(); seen.push(config.get('provider.model')); });
  const handle = config.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: 'synthetic:prepared' });
  expect(config.finishPreparedMutation(handle, config.beginPreparedMutation(handle)).status).toBe('committed');
  expect(seen).toEqual(['synthetic:prepared']);
  config.load(); expect(config.get('tts.voice')).toBe('synthetic-cli-voice');
  expect(config.get('provider.model')).toBe('synthetic:prepared');
});

test('known partial prepared reset publishes its known effect and retirement without pretending disk rollback', () => {
  const config = fixture();
  write(config.getConfigPath(), { tts: { voice: 'synthetic-global' } });
  write(config.getSharedTierPath()!, { tts: { voice: 'synthetic-shared' } }); config.load();
  const handle = config.prepareSettingMutation({ operation: 'reset', key: 'tts.voice' });
  const transition = config.beginPreparedMutation(handle);
  const original = atomic.writeJsonFileAtomic;
  const spy = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation((path, data, options) => {
    if (path === config.getSharedTierPath()) throw new Error('synthetic later failure');
    original(path, data, options);
  }); restores.push(() => spy.mockRestore());
  expect(config.finishPreparedMutation(handle, transition)).toEqual({ status: 'partial', completedPaths: [config.getConfigPath()], uncertainPath: config.getSharedTierPath()! });
  expect(config.get('tts.voice')).not.toBe('synthetic-cli-voice');
  expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8'))).toEqual({});
  config.load();
  expect(config.get('tts.voice')).toBe('synthetic-shared');
  expect(config.get('provider.model')).toBe('synthetic:cli');
});

test('unknown prepared publication retains invocation authority even if the writer changed bytes before throwing', () => {
  const config = fixture();
  const handle = config.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: 'synthetic:uncertain' });
  const transition = config.beginPreparedMutation(handle);
  const original = atomic.writeJsonFileAtomic;
  const spy = spyOn(atomic, 'writeJsonFileAtomic').mockImplementation((path, data, options) => {
    original(path, data, options); throw new Error('synthetic uncertain completion');
  }); restores.push(() => spy.mockRestore());
  expect(config.finishPreparedMutation(handle, transition)).toEqual({ status: 'unknown', completedPaths: [], uncertainPath: config.getConfigPath() });
  expect(config.get('provider.model')).toBe('synthetic:cli');
  config.load(); expect(config.get('provider.model')).toBe('synthetic:cli');
});

test.each(['revoked', 'abandoned', 'reentrant-runtime'] as const)('%s prepared owner never retires active invocation authority', kind => {
  const config = fixture();
  const handle = config.prepareSettingMutation({ operation: 'set', key: 'provider.model', value: 'synthetic:unpublished' });
  if (kind === 'reentrant-runtime') {
    let entered = false;
    config.onDidInvalidate(() => { if (!entered) { entered = true; config.setRuntimeOverride('display.stream', false); } });
    expect(() => config.beginPreparedMutation(handle)).toThrow();
  } else {
    const transition = config.beginPreparedMutation(handle);
    if (kind === 'revoked') {
      config.setRuntimeDefault('display.showTokenSpeed', true);
      expect(() => config.finishPreparedMutation(handle, transition)).toThrow();
    }
    // Abandoned models cancellation before finish: no publication is requested.
  }
  config.load(); expect(config.get('provider.model')).toBe('synthetic:cli');
});

test('runtime validators cannot retain and mutate owned overlay values', () => {
  const config = fixture();
  const schema = CONFIG_SCHEMA.find(setting => setting.key === 'pricing.modelPrices')!;
  const previous = schema.validate;
  let retained: unknown;
  schema.validate = value => { retained = value; return true; };
  restores.push(() => { schema.validate = previous; });
  config.setRuntimeOverride('pricing.modelPrices', { 'synthetic:model': { input: 1, output: 2 } });
  expect(Object.isFrozen(retained)).toBe(true);
  expect(Object.isFrozen((retained as Record<string, unknown>)['synthetic:model'])).toBe(true);
  expect(Reflect.set((retained as Record<string, object>)['synthetic:model']!, 'input', 99)).toBe(false);
  config.load(); expect(config.get('pricing.modelPrices')['synthetic:model']?.input).toBe(1);
});
