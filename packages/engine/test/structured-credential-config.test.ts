import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { CONFIG_SCHEMA } from '../sdk/src/platform/config/schema.ts';
import type { ConfigSetting } from '../sdk/src/platform/config/schema-types.ts';
import type { JudgmentFallbackSettings } from '../sdk/src/platform/config/schema-types-judgment.ts';
import { isSecretBearingConfigKey } from '../sdk/src/platform/config/secret-bearing-config-keys.ts';
import { captureStructuredCredentialReferenceConfigValue, isStructuredCredentialReferenceConfigKey, structuredCredentialConfigSchemaFailures } from '../sdk/src/platform/config/structured-credential-config.ts';
import { screenSettingsForIngestion } from '../sdk/src/platform/config/settings-ingestion.ts';
import { redactConfigValue, redactObjectByPath } from '../sdk/src/platform/tools/goodvibes-runtime/credential-redaction.ts';
import { attachConfigEmitBridge } from '../sdk/src/platform/runtime/config/emit-bridge.ts';
import { RuntimeEventBus, type ConfigEvent } from '../sdk/src/platform/runtime/events/index.ts';
import { credentialReadingStanding, undeclaredSchemaKeys } from '../scripts/credential-key-readings.ts';
import { createCredentialSetHandler, createCredentialDeleteHandler, type CredentialWriteDeps } from '../sdk/src/platform/control-plane/routes/credentials-write.ts';
import { sweepPlaintextCredentials } from '../sdk/src/platform/config/plaintext-credential-sweep.ts';
import type { GatewayMethodInvocation } from '../sdk/src/platform/control-plane/method-catalog-shared.ts';

const key = 'judgment.fallbacks';
const marker = 'SYNTHETIC_RAW_KEY_MUST_NOT_APPEAR';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fallback(keySource: 'env' | 'secret' = 'env'): JudgmentFallbackSettings {
  return { endpoint: 'https://fallback.example.test/v1', model: 'jev-1.13.0', keySource, keyName: keySource === 'env' ? 'FALLBACK_API_KEY' : 'judgment/fallback-key' };
}

test('structured references have an exact declaration without entering scalar secret encryption or weakening other readings', () => {
  expect(isStructuredCredentialReferenceConfigKey(key)).toBe(true);
  expect(isSecretBearingConfigKey(key)).toBe(false);
  expect(isStructuredCredentialReferenceConfigKey('judgment.fallbacks.0.keyName')).toBe(false);
  expect(isStructuredCredentialReferenceConfigKey('provider.unrecognizedSecret')).toBe(false);
  expect(structuredCredentialConfigSchemaFailures(CONFIG_SCHEMA)).toEqual([]);
  expect(undeclaredSchemaKeys().some(entry => entry.key === key)).toBe(false);
  expect(undeclaredSchemaKeys().some(entry => entry.key === 'judgment.timeoutMs')).toBe(true);
  expect(credentialReadingStanding({ verdict: 'uncertain', outcome: 'escalate' })).toBe('unsettled');
  expect(credentialReadingStanding({ verdict: 'no', outcome: 'confirm' })).toBe('unsettled');
});

test('the declaration gate rejects missing, duplicate, wrong-shaped, wrong-parser and invalid-default contracts', () => {
  const entry = CONFIG_SCHEMA.find(setting => setting.key === key);
  if (!entry) throw new Error('Missing authored fallback schema');
  const others = CONFIG_SCHEMA.filter(setting => setting.key !== key);
  expect(structuredCredentialConfigSchemaFailures(others)).toHaveLength(1);
  expect(structuredCredentialConfigSchemaFailures([...CONFIG_SCHEMA, entry])).toHaveLength(1);
  const replacements: ConfigSetting[] = [
    { ...entry, type: 'string' },
    { ...entry, validate: () => true },
    { ...entry, validate: undefined },
    { ...entry, default: undefined },
    { ...entry, default: [fallback()] },
    { ...entry, default: marker },
    { ...entry, default: Object.assign([], { apiKey: marker }) },
  ];
  for (const replacement of replacements) {
    const failures = structuredCredentialConfigSchemaFailures([...others, replacement]);
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain(marker);
  }
});

test('valid reference arrays detach before display and preserve ordered env and native secret references', async () => {
  const input = [{ ...fallback() }, { ...fallback('secret') }];
  const snapshot = captureStructuredCredentialReferenceConfigValue(key, input);
  const displayed = await redactConfigValue(key, input);
  const nested = await redactObjectByPath('judgment', { fallbacks: input });
  expect(snapshot).toEqual(input);
  expect(displayed).toEqual(input);
  expect(nested).toEqual({ fallbacks: input });
  input[0]!.keyName = 'CHANGED_REFERENCE';
  expect(snapshot[0]!.keyName).toBe('FALLBACK_API_KEY');
  expect(displayed).toEqual(snapshot);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot[0])).toBe(true);
});

test('malformed structured values never show raw credential fields or invoke accessors', async () => {
  let calls = 0;
  const accessor = { ...fallback(), get keyName() { calls++; return marker; } };
  for (const value of [undefined, marker, [{ ...fallback(), apiKey: marker }], [accessor], [{ ...fallback(), endpoint: `https://user:${marker}@example.test` }]]) {
    expect(() => captureStructuredCredentialReferenceConfigValue(key, value)).toThrow();
    const displayed = await redactConfigValue(key, value);
    expect(displayed).toMatchObject({ redacted: true });
    expect(JSON.stringify(displayed)).not.toContain(marker);
  }
  expect(calls).toBe(0);
  expect(() => captureStructuredCredentialReferenceConfigValue('unknown.reference', [fallback()])).toThrow();
});

test('native prepared settings import round-trips the array without string-secret routing', () => {
  const root = mkdtempSync(join(tmpdir(), 'structured-credential-config-')); roots.push(root);
  const workingDir = join(root, 'project'); mkdirSync(workingDir);
  const config = new ConfigManager({ configDir: join(root, 'config'), workingDir, surfaceRoot: 'tui', sharedTierPath: join(root, 'shared.json'), daemonTierPath: join(root, 'daemon.json') });
  const targets = [fallback(), fallback('secret')];
  const handle = config.prepareSettingMutationPlan([{ operation: 'set', key, value: targets }, { operation: 'set', key: 'display.treeGlyphs', value: 'ascii' }]);
  const destination = config.inspectPreparedMutation(handle).effects?.find(effect => effect.key === key)?.destinations[0]?.path;
  if (!destination) throw new Error('Missing original fallback import destination');
  const transition = config.beginPreparedMutation(handle);
  expect(config.finishPreparedMutation(handle, transition).status).toBe('committed');
  config.load();
  expect(config.get(key)).toEqual(targets);
  expect(config.get('display.treeGlyphs')).toBe('ascii');
  const stored = readFileSync(destination, 'utf8');
  expect(JSON.parse(stored)).toMatchObject({ judgment: { fallbacks: targets } });
  expect(stored).not.toContain('goodvibes://secrets/');
  expect(stored).not.toContain('apiKey');
});

test('ingestion publishes only shape diagnostics for malformed structured references', () => {
  const raw = { judgment: { fallbacks: [{ ...fallback(), apiKey: marker }] } };
  const result = screenSettingsForIngestion(raw, '/synthetic/settings.json');
  expect(result.notices.some(notice => notice.key === key)).toBe(true);
  expect(JSON.stringify(result)).not.toContain(marker);
});

test('actual config events carry only validated reference arrays and omit malformed fields without running getters', async () => {
  const bus = new RuntimeEventBus();
  const seen: ConfigEvent[] = [];
  const listeners = new Map<string, (value: unknown, previous: unknown) => void>();
  const unsubscribe = bus.onDomain('config', envelope => { seen.push(envelope.payload); });
  const detach = attachConfigEmitBridge({ config: { subscribe(name, listener) { listeners.set(name, listener); return () => { listeners.delete(name); }; } }, bus });
  try {
    const valid = [fallback(), fallback('secret')];
    listeners.get(key)?.(valid, undefined);
    listeners.get(key)?.([{ ...fallback(), apiKey: marker }], valid);
    let calls = 0;
    listeners.get(key)?.([{ ...fallback(), get keyName() { calls++; return marker; } }], valid);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ key, secret: false, value: valid });
    for (const event of seen.slice(1)) {
      expect(event.secret).toBe(true);
      expect(Object.hasOwn(event, 'value')).toBe(false);
    }
    expect(calls).toBe(0);
    expect(JSON.stringify(seen)).not.toContain(marker);
  } finally { detach(); unsubscribe(); }
});

test('scalar credential set and clear refuse structured references before effects even with a product override', async () => {
  let calls = 0;
  const original = [fallback()];
  const deps: CredentialWriteDeps = {
    config: { get: () => original, setDynamic: () => { calls++; } },
    secrets: { set: async () => { calls++; }, get: async () => { calls++; return null; }, delete: async () => { calls++; } },
    additionalSecretKeys: [key],
  };
  const context: GatewayMethodInvocation['context'] = { principalId: 'synthetic-operator', principalKind: 'user', clientKind: 'web', admin: true };
  await expect(createCredentialSetHandler(deps)({ context, body: { key, value: marker } })).rejects.toThrow('structured credential references');
  await expect(createCredentialDeleteHandler(deps)({ context, body: { key } })).rejects.toThrow('structured credential references');
  expect(calls).toBe(0);
  expect(original).toEqual([fallback()]);
});

test('plaintext sweep leaves valid reference arrays intact and refuses malformed values before scalar effects', async () => {
  let calls = 0;
  const valid = [fallback(), fallback('secret')];
  const config = { get: (name: string): unknown => name === key ? valid : undefined, set: () => { calls++; } };
  const secrets = { set: async () => { calls++; }, get: async () => { calls++; return null; }, getFromScope: async () => { calls++; return null; } };
  expect(await sweepPlaintextCredentials(config, secrets, [key])).toMatchObject({ noop: true, entries: [] });
  expect(valid).toEqual([fallback(), fallback('secret')]);
  await expect(sweepPlaintextCredentials({ ...config, get: (name: string) => name === key ? marker : undefined }, secrets, [key])).rejects.toThrow('Invalid judgment fallback settings');
  expect(calls).toBe(0);
});
