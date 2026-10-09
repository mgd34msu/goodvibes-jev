/** Pinned legacy wire behavior and distinct current unsupported-owner behavior. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createLegacyPostConfigHandler } from './fixtures/settings/legacy-post-config.js';
import { createDaemonSystemRouteHandlers } from '../daemon-sdk/src/system-routes.js';

function fixture(body: Record<string, unknown>, version: 'legacy' | 'current' = 'current') {
  const writes: { key: string; value: unknown }[] = [];
  const values = new Map<string, unknown>([['display.theme', 'vaporwave']]);
  const context = {
    requireAdmin: () => null,
    parseJsonBody: async () => body,
    isValidConfigKey: (key: string) => key === 'display.theme',
    configManager: {
      getAll: () => ({ display: { theme: values.get('display.theme') } }),
      get: (key: string) => values.get(key),
      setDynamic: (key: string, value: unknown) => { writes.push({ key, value }); values.set(key, value); },
      getConfigPath: () => '/synthetic/owned/settings.json',
    },
  } as never;
  const post = version === 'legacy' ? createLegacyPostConfigHandler(context) : createDaemonSystemRouteHandlers(context).postConfig;
  const run = () => post(new Request('http://synthetic.invalid/config', { method: 'POST' }));
  return { run, writes, values };
}

function envelope(action: 'capture' | 'apply') {
  return { settingsPrecondition: action === 'capture'
    ? { version: 1, action, operation: 'set', key: 'display.theme', value: 'nord' }
    : { version: 1, action, reference: 'synthetic-precondition' } };
}

test('legacy handler fixture retains the exact pinned source regions', () => {
  const source = readFileSync(new URL('./fixtures/settings/legacy-post-config.ts', import.meta.url), 'utf8');
  const regions = ['postConfig', 'workingDirectory', 'configValuesMatch'].map(name => {
    const start = `// BEGIN pinned ${name}\n`;
    const end = `// END pinned ${name}`;
    expect(source.split(start)).toHaveLength(2);
    const region = source.split(start)[1]!.split(end);
    expect(region).toHaveLength(2);
    return region[0]!;
  });
  expect(createHash('sha256').update(regions.join('')).digest('hex')).toBe('93b689eac85a26eef7db3994982774d302df6ceb0a690826c0375aab56fa0a87');
});

test.each(['capture', 'apply'] as const)('pinned legacy handler inherently refuses nested %s without a legacy key', async action => {
  const f = fixture(envelope(action), 'legacy');
  expect((await f.run()).status).toBe(400);
  expect(f.writes).toHaveLength(0);
  expect(f.values.get('display.theme')).toBe('vaporwave');
});

test.each(['capture', 'apply'] as const)('current handler without an owner holds nested %s as unsupported', async action => {
  const f = fixture(envelope(action));
  const response = await f.run();
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('SETTINGS_PRECONDITION_UNSUPPORTED');
  expect(f.writes).toHaveLength(0);
  expect(f.values.get('display.theme')).toBe('vaporwave');
});

test.each(['legacy', 'current'] as const)('%s manual config payload retains its existing behavior', async version => {
  const f = fixture({ key: 'display.theme', value: 'nord' }, version);
  expect((await f.run()).status).toBe(200);
  expect(f.writes).toEqual([{ key: 'display.theme', value: 'nord' }]);
});

test('current unsupported admitted envelope cannot downgrade a mixed payload to legacy mutation', async () => {
  const f = fixture({ key: 'display.theme', value: 'nord', ...envelope('apply') });
  expect((await f.run()).status).toBe(409);
  expect(f.writes).toHaveLength(0);
  expect(f.values.get('display.theme')).toBe('vaporwave');
});

test('legacy top-level key still writes, demonstrating why admitted envelopes must omit it', async () => {
  const f = fixture({ key: 'display.theme', value: 'nord', ...envelope('apply') }, 'legacy');
  expect((await f.run()).status).toBe(200);
  expect(f.writes).toEqual([{ key: 'display.theme', value: 'nord' }]);
});
