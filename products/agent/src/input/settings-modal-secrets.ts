import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { SecretsManager } from '../config/secrets.ts';
import {
  buildSecretBackedConfigUpdate,
  defaultSecretBackedScope,
  getSecretWriteMedium,
} from '../config/secret-config.ts';
import {
  agentDaemonCredentialsInstalled,
  isDaemonOwnedConfigKey,
  routeDaemonOwnedCredentialWrite,
} from '../config/daemon-credential-routing.ts';

export type SettingsSecretsManager = Pick<SecretsManager, 'delete' | 'set'>;

/** Outcome surfaced to the synchronous keystroke caller. */
export interface SettingsSecretWriteReport {
  readonly ok: boolean;
  readonly message: string;
}

export async function setSecretBackedSettingValue(args: {
  key: ConfigKey;
  value: string;
  configManager: ConfigManager;
  secretsManager: SettingsSecretsManager | null;
  setConfigValue: (key: ConfigKey, value: unknown) => void | Promise<void>;
  /**
   * How the outcome of a daemon-routed write reaches the screen. This setter is
   * called from a keystroke handler and cannot await, so a refusal, the daemon
   * unreachable, the verb rejecting the key, arrives here instead of in a
   * return value. Absent means the caller renders nothing; the failure is still
   * logged.
   */
  onWriteReported?: ((report: SettingsSecretWriteReport) => void) | undefined;
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
    if ((update.secretKey || update.clearSecretKey) && isDaemonOwnedConfigKey(key) && agentDaemonCredentialsInstalled()) {
      await routeDaemonOwnedCredentialWrite(key, value);
      args.onWriteReported?.({ ok: true, message: 'Stored by the connected host; it takes effect for every client.' });
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
    args.onWriteReported?.({ ok: false, message: `Save failed: ${message}` });
    return false;
  }
}
