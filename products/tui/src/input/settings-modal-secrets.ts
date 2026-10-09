import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { SecretsManager } from '../config/secrets.ts';
import {
  buildSecretBackedConfigUpdate,
  defaultSecretBackedScope,
  getSecretWriteMedium,
} from '../config/secret-config.ts';

export type SettingsSecretsManager = Pick<SecretsManager, 'delete' | 'set'>;

/**
 * The daemon's own credential write, when this app has a daemon to write to.
 *
 * A daemon-scoped credential is two writes that only work together, the secret
 * value and the config reference that points at it, and `credentials.set` does
 * both, verifying the value reads back before it touches the config. Splitting
 * them across a process boundary leaves a window where the config names a
 * reference resolving to nothing, which every reader treats as a
 * configured-but-broken credential.
 */
export interface SettingsDaemonCredentialWriter {
  set(configKey: string, value: string): Promise<unknown>;
  clear(configKey: string): Promise<void>;
}

export async function setSecretBackedSettingValue(args: {
  key: ConfigKey;
  value: string;
  configManager: ConfigManager;
  secretsManager: SettingsSecretsManager | null;
  /** Present when a daemon is adopted; absent leaves the historical local path. */
  daemonCredentials?: SettingsDaemonCredentialWriter | null;
  setConfigValue: (key: ConfigKey, value: unknown) => void | Promise<void>;
  /** Surface the daemon's refusal; without it a failed write would be silent. */
  onError?: (message: string) => void;
}): Promise<boolean> {
  const { key, value, configManager, secretsManager, setConfigValue } = args;
  const assertPolicyAvailable = () => {
    // Re-read authority from the captured owner, including after storage waits.
    // A modal opened against another owner must not supply this metadata.
    for (const setting of configManager.getHostSettingsSchema?.() ?? []) {
      configManager.getHostBooleanSetting(setting.key).getResolved();
    }
  };
  try {
    assertPolicyAvailable();
    const update = buildSecretBackedConfigUpdate(key, value);
    if ((update.secretKey || update.clearSecretKey) && defaultSecretBackedScope(key) === 'daemon' && args.daemonCredentials) {
      const writer = args.daemonCredentials;
      if (value.trim().length === 0) await writer.clear(key);
      else await writer.set(key, value);
      return true;
    }
    if ((update.secretKey || update.clearSecretKey) && !secretsManager) {
      throw new Error('Credential storage is unavailable.');
    }
    configManager.validateDynamic?.(key, update.configValue);
    const scope = defaultSecretBackedScope(key);
    const medium = getSecretWriteMedium(configManager.get('storage.secretPolicy'));
    // Publishing a reference is the commit: readers must never see it before
    // the cross-process secret write (or clear) has actually completed.
    if (update.secretKey && update.secretValue !== undefined) {
      await secretsManager!.set(update.secretKey, update.secretValue, { scope, medium });
    }
    if (update.clearSecretKey) {
      await secretsManager!.delete(update.clearSecretKey, { scope });
    }
    assertPolicyAvailable();
    configManager.validateDynamic?.(key, update.configValue);
    await setConfigValue(key, update.configValue);
    return true;
  } catch {
    // Store/transport errors may echo credential material. Never display or log them.
    const message = 'The credential could not be saved. Check storage access and settings policy, then retry.';
    logger.error('SettingsModal: failed to save secret config value', { key });
    args.onError?.(`Saving that credential failed: ${message}`);
    return false;
  }
}
