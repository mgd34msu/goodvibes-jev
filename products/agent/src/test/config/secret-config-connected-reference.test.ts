import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { isDaemonOwnedConfigKey, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { installAgentDaemonConfigClient } from '../../config/daemon-config-routing.ts';
import { installAgentDaemonCredentialsClient } from '../../config/daemon-credential-routing.ts';
import {
  buildGoodVibesSecretKey,
  buildGoodVibesSecretRef,
  persistSecretBackedConfigValue,
} from '../../config/secret-config.ts';

const KEY = 'surfaces.telegram.botToken';
const REFERENCE = 'goodvibes://secrets/goodvibes/SYNTHETIC_ALREADY_STORED';
const RAW = '  synthetic raw credential  ';

function fixture(policy: unknown = 'secure_required') {
  const localConfig = { get: mock(() => policy), validateDynamic: mock((_key: ConfigKey, _value: unknown) => {}), setDynamic: mock((_key: ConfigKey, _value: unknown) => {}) };
  const secrets = {
    set: mock(async (_key: string, _value: string, _options?: { scope?: string; medium?: string }) => {}),
    delete: mock(async (_key: string, _options?: { scope?: string; medium?: string }) => {}),
    get: mock(async (_key: string) => { throw new Error('must not resolve a reference'); }),
  };
  const config = {
    ownsKey: mock(isDaemonOwnedConfigKey),
    set: mock(async (_key: string, _value: unknown) => {}),
    get: mock(async (_key: string) => { throw new Error('must not read connected config'); }),
    snapshot: mock(async (): Promise<Record<string, unknown> | null> => { throw new Error('must not read connected config'); }),
  };
  const credentials = {
    set: mock(async (_key: string, _value: string) => ({})),
    clear: mock(async (_key: string) => {}),
  };
  return { localConfig, secrets, config, credentials };
}

function resetClients() {
  installAgentDaemonConfigClient(null);
  installAgentDaemonCredentialsClient(null);
}
beforeEach(resetClients);
afterEach(resetClients);

describe('an existing secret reference is a configuration write', () => {
  test.each([
    REFERENCE,
    'goodvibes://secrets/env/SYNTHETIC_UNRESOLVED',
    'goodvibes://secrets/1password?vault=Synthetic&item=Absent&field=password',
  ])('routes %s unchanged through connected config without resolving or writing credentials', async (reference) => {
    const { localConfig, secrets, config, credentials } = fixture();
    installAgentDaemonConfigClient(config);
    installAgentDaemonCredentialsClient(credentials);

    expect(await persistSecretBackedConfigValue(localConfig, secrets, KEY, `  ${reference}  `)).toBe(reference);
    expect(config.set).toHaveBeenCalledTimes(1);
    expect(config.set).toHaveBeenCalledWith(KEY, reference);
    expect(credentials.set).not.toHaveBeenCalled();
    expect(credentials.clear).not.toHaveBeenCalled();
    expect(localConfig.setDynamic).not.toHaveBeenCalled();
    expect(localConfig.get).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
    expect(config.get).not.toHaveBeenCalled();
    expect(config.snapshot).not.toHaveBeenCalled();
  });

  test('a connected config refusal propagates without credential or local fallback', async () => {
    const { localConfig, secrets, config, credentials } = fixture();
    const refusal = new Error('synthetic connected owner unavailable');
    config.set.mockImplementation(async () => { throw refusal; });
    installAgentDaemonConfigClient(config);
    installAgentDaemonCredentialsClient(credentials);

    await expect(persistSecretBackedConfigValue(localConfig, secrets, KEY, REFERENCE)).rejects.toBe(refusal);
    expect(config.set).toHaveBeenCalledTimes(1);
    expect(credentials.set).not.toHaveBeenCalled();
    expect(credentials.clear).not.toHaveBeenCalled();
    expect(localConfig.setDynamic).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  test('raw material keeps the credential owner route and whitespace', async () => {
    const { localConfig, secrets, config, credentials } = fixture();
    installAgentDaemonConfigClient(config);
    installAgentDaemonCredentialsClient(credentials);

    expect(await persistSecretBackedConfigValue(localConfig, secrets, KEY, RAW))
      .toBe(buildGoodVibesSecretRef(buildGoodVibesSecretKey(KEY)));
    expect(credentials.set).toHaveBeenCalledWith(KEY, RAW);
    expect(credentials.clear).not.toHaveBeenCalled();
    expect(config.set).not.toHaveBeenCalled();
    expect(localConfig.setDynamic).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
  });

  test('empty material keeps the credential clear route', async () => {
    const { localConfig, secrets, config, credentials } = fixture();
    installAgentDaemonConfigClient(config);
    installAgentDaemonCredentialsClient(credentials);

    expect(await persistSecretBackedConfigValue(localConfig, secrets, KEY, '  ')).toBe('');
    expect(credentials.clear).toHaveBeenCalledWith(KEY);
    expect(credentials.set).not.toHaveBeenCalled();
    expect(config.set).not.toHaveBeenCalled();
    expect(localConfig.setDynamic).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  test.each([RAW, ''])('a credential owner refusal for %j still has no local fallback', async (value) => {
    const { localConfig, secrets, config, credentials } = fixture();
    const refusal = new Error('synthetic credential owner unavailable');
    credentials.set.mockImplementation(async () => { throw refusal; });
    credentials.clear.mockImplementation(async () => { throw refusal; });
    installAgentDaemonConfigClient(config);
    installAgentDaemonCredentialsClient(credentials);

    await expect(persistSecretBackedConfigValue(localConfig, secrets, KEY, value)).rejects.toBe(refusal);
    expect(config.set).not.toHaveBeenCalled();
    expect(localConfig.setDynamic).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  test('explicit local scope preserves the manual reference path even with both clients installed', async () => {
    const { localConfig, secrets, config, credentials } = fixture();
    installAgentDaemonConfigClient(config);
    installAgentDaemonCredentialsClient(credentials);

    expect(await persistSecretBackedConfigValue(localConfig, secrets, KEY, REFERENCE, { scope: 'project' })).toBe(REFERENCE);
    expect(localConfig.setDynamic).toHaveBeenCalledWith(KEY, REFERENCE);
    expect(config.set).not.toHaveBeenCalled();
    expect(credentials.set).not.toHaveBeenCalled();
    expect(credentials.clear).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  test.each([false, true])('without a config client, reference-only manual persistence never writes credentials (credential client: %j)', async (credentialClientInstalled) => {
    const { localConfig, secrets, credentials } = fixture();
    if (credentialClientInstalled) installAgentDaemonCredentialsClient(credentials);

    expect(await persistSecretBackedConfigValue(localConfig, secrets, KEY, REFERENCE)).toBe(REFERENCE);
    expect(localConfig.setDynamic).toHaveBeenCalledWith(KEY, REFERENCE);
    expect(credentials.set).not.toHaveBeenCalled();
    expect(credentials.clear).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  test('a non-daemon-owned reference stays local', async () => {
    const { localConfig, secrets, config, credentials } = fixture();
    installAgentDaemonConfigClient(config);
    installAgentDaemonCredentialsClient(credentials);

    expect(await persistSecretBackedConfigValue(localConfig, secrets, 'provider.model', REFERENCE)).toBe(REFERENCE);
    expect(localConfig.setDynamic).toHaveBeenCalledWith('provider.model', REFERENCE);
    expect(config.set).not.toHaveBeenCalled();
    expect(credentials.set).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
  });

  test('manual raw and empty writes preserve validation order, scope, and storage medium', async () => {
    const { localConfig, secrets } = fixture('plaintext_allowed');
    const reference = buildGoodVibesSecretRef(buildGoodVibesSecretKey(KEY));
    expect(await persistSecretBackedConfigValue(localConfig, secrets, KEY, RAW, { scope: 'project' })).toBe(reference);
    expect(localConfig.setDynamic).toHaveBeenCalledWith(KEY, reference);
    expect(secrets.set).toHaveBeenCalledWith(buildGoodVibesSecretKey(KEY), RAW, { scope: 'project', medium: 'plaintext' });
    expect(await persistSecretBackedConfigValue(localConfig, secrets, KEY, '', { scope: 'project' })).toBe('');
    expect(localConfig.setDynamic).toHaveBeenCalledWith(KEY, '');
    expect(secrets.delete).toHaveBeenCalledWith(buildGoodVibesSecretKey(KEY), { scope: 'project' });

    secrets.set.mockClear();
    secrets.delete.mockClear();
    const refusal = new Error('synthetic invalid configuration');
    localConfig.validateDynamic.mockImplementation(() => { throw refusal; });
    await expect(persistSecretBackedConfigValue(localConfig, secrets, KEY, RAW, { scope: 'project' })).rejects.toBe(refusal);
    await expect(persistSecretBackedConfigValue(localConfig, secrets, KEY, '', { scope: 'project' })).rejects.toBe(refusal);
    expect(secrets.set).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
  });

  test('a no-client raw write preserves daemon default scope and secure medium', async () => {
    const { localConfig, secrets } = fixture();
    await persistSecretBackedConfigValue(localConfig, secrets, KEY, RAW);
    expect(secrets.set).toHaveBeenCalledWith(buildGoodVibesSecretKey(KEY), RAW, { scope: 'daemon', medium: 'secure' });
  });
});
