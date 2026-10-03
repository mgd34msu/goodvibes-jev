import type { ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { logger } from '@goodvibes-jev/engine/sdk/platform/utils';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
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

/** What the modal is told about a write it could not await. */
export interface SettingsSecretWriteReport {
  readonly ok: boolean;
  readonly message: string;
}

export function setSecretBackedSettingValue(args: {
  key: ConfigKey;
  value: string;
  configManager: ConfigManager;
  secretsManager: SettingsSecretsManager | null;
  setConfigValue: (key: ConfigKey, value: unknown) => void;
  /**
   * How the outcome of a daemon-routed write reaches the screen. This setter is
   * called from a keystroke handler and cannot await, so a refusal, the daemon
   * unreachable, the verb rejecting the key, arrives here instead of in a
   * return value. Absent means the caller renders nothing; the failure is still
   * logged.
   */
  onWriteReported?: ((report: SettingsSecretWriteReport) => void) | undefined;
}): void {
  const { key, value, configManager, secretsManager, setConfigValue } = args;
  if (!secretsManager) {
    setConfigValue(key, value.trim());
    return;
  }

  // A credential the DAEMON executes with is written BY the daemon, as one
  // verified pair: the secret value, read back, and only then the config key
  // pointed at its reference. Writing the two halves from here is what split
  // the pair once the daemon became a separate process, the reference landed
  // in one file and the value in a tier the daemon never resolves, and the
  // modal reported success either way.
  //
  // Routed only when a connected-host client is actually installed. A process
  // that composed no runtime (a unit test, a one-shot CLI) keeps the local path
  // rather than failing a write it was never wired to route.
  if (isDaemonOwnedConfigKey(key) && agentDaemonCredentialsInstalled()) {
    void routeDaemonOwnedCredentialWrite(key, value)
      .then(() => {
        args.onWriteReported?.({
          ok: true,
          message: 'Stored by the connected host; it takes effect for every client.',
        });
      })
      .catch((error) => {
        const message = summarizeError(error);
        // Loud, and never a silent local write instead: a credential saved
        // where the daemon cannot read it is the failure this routing exists
        // to end, and it looks exactly like success.
        logger.error('SettingsModal: the connected host refused a credential write', { key, error: message });
        args.onWriteReported?.({ ok: false, message: `Save failed: ${message}` });
      });
    return;
  }

  const update = buildSecretBackedConfigUpdate(key, value);
  const scope = defaultSecretBackedScope(key);
  if (update.secretKey && update.secretValue !== undefined) {
    void secretsManager.set(update.secretKey, update.secretValue, {
      scope,
      medium: getSecretWriteMedium(configManager.get('storage.secretPolicy')),
    }).catch((error) => {
      logger.error('SettingsModal: failed to store secret config value', { key, error: summarizeError(error) });
    });
  }
  if (update.clearSecretKey) {
    void secretsManager.delete(update.clearSecretKey, { scope }).catch((error) => {
      logger.error('SettingsModal: failed to clear secret config value', { key, error: summarizeError(error) });
    });
  }
  setConfigValue(key, update.configValue);
}
