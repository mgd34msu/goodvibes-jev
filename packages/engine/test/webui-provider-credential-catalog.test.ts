import { expect, test } from 'bun:test';
import { readDeclaredProviderCredential } from '../sdk/src/platform/judgment-browser/batteries/catalogs.ts';
import { BUILTIN_COMPAT_PROVIDERS, BUILTIN_PROVIDER_ENV_KEYS, getBuiltinProviderEnvVars } from '../sdk/src/platform/providers/builtin-catalog.ts';
import {
  BUILTIN_PROVIDER_ENV_KEYS as canonicalEnvKeys,
  getBuiltinProviderEnvVars as canonicalEnvVars,
  readDeclaredProviderCredential as canonicalCredentialReading,
} from '../sdk/src/platform/config/provider-credential-catalog.ts';

test('browser projection reuses canonical declarations, including aliases with no shared provider spelling', () => {
  expect(BUILTIN_PROVIDER_ENV_KEYS).toBe(canonicalEnvKeys);
  expect(getBuiltinProviderEnvVars).toBe(canonicalEnvVars);
  expect(readDeclaredProviderCredential).toBe(canonicalCredentialReading);
  for (const [provider, keys] of Object.entries(BUILTIN_PROVIDER_ENV_KEYS)) {
    expect(getBuiltinProviderEnvVars(provider)).toEqual(keys);
    for (const key of keys) expect(readDeclaredProviderCredential(provider, key)).toBe(true);
  }
  expect(readDeclaredProviderCredential('gemini', 'GOOGLE_API_KEY')).toBe(true);
  expect(readDeclaredProviderCredential('openai', 'AZURE_OPENAI_API_KEY')).toBe(false);
  expect(readDeclaredProviderCredential('microsoft-foundry', 'AZURE_OPENAI_API_KEY')).toBe(true);
  expect(readDeclaredProviderCredential('openai', 'MY_OPENAIISH_KEY')).toBeUndefined();
  expect(readDeclaredProviderCredential('custom', 'OPENAI_API_KEY')).toBeUndefined();
  expect(readDeclaredProviderCredential('openai', 'openai_api_key')).toBeUndefined();
});

test('native provider descriptors use the same canonical credential names as the browser', () => {
  for (const provider of BUILTIN_COMPAT_PROVIDERS) {
    expect(provider.envVars).toEqual(canonicalEnvVars(provider.id));
    for (const key of provider.envVars) expect(readDeclaredProviderCredential(provider.id, key)).toBe(true);
  }
});

test('prototype names are not declared providers', () => {
  for (const id of ['__proto__', 'constructor', 'toString']) {
    expect(getBuiltinProviderEnvVars(id)).toEqual([]);
    expect(readDeclaredProviderCredential(id, 'OPENAI_API_KEY')).toBeUndefined();
  }
});
