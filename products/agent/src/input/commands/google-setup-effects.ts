import { SecretWriteCommittedError } from '@goodvibes-jev/engine/sdk/platform/config';
/** Exact setup writes consume an observation once and retain independent request authority. */
import type { ConfigManager, SecretsManager, ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { GoogleSetupWriteCommittedError, type GoogleConfigPort, type GoogleSecretPort } from '@goodvibes-jev/engine/sdk/platform/google';

export function googleSetupWritePorts(config: ConfigManager, secrets: SecretsManager,
  configPort: GoogleConfigPort, secretPort: GoogleSecretPort, assertRequest: () => void,
): { readonly config: GoogleConfigPort; readonly secrets: GoogleSecretPort; readonly assertCurrent: () => void } {
  const configMethods = { get: config.get, setDynamic: config.setDynamic, prepareSettingMutation: config.prepareSettingMutation,
    inspectPreparedMutation: config.inspectPreparedMutation, beginPreparedMutation: config.beginPreparedMutation,
    assertPreparedMutationTransition: config.assertPreparedMutationTransition, finishPreparedMutation: config.finishPreparedMutation,
    getConfigurationIncarnation: config.getConfigurationIncarnation };
  const secretMethods = { set: secrets.set, get: secrets.get, assertWriteTransition: secrets.assertWriteTransition,
    inspectWriteTransition: secrets.inspectWriteTransition, getCredentialMutationState: secrets.getCredentialMutationState };
  const configRevision = config.getConfigurationIncarnation?.bind(config);
  const secretRevision = secrets.getCredentialMutationState?.bind(secrets);
  let expectedConfig = configRevision?.(), expectedSecret = secretRevision?.().generation;
  const settingKeys = ['judgment.endpoint', 'judgment.keySource', 'judgment.model', 'judgment.timeoutMs'] as const;
  const settings = settingKeys.map(key => JSON.stringify(config.get(key)));
  const envKeys = ['TYPESAFE_BASE_URL', 'TYPESAFE_DEFAULT_MODEL', 'TYPESAFE_API_KEY'] as const;
  const environment = envKeys.map(key => process.env[key]);
  let configTransition: (() => void) | undefined, secretTransition: (() => void) | undefined;
  let stopped = false;
  function current() {
    assertRequest();
    for (const key of Object.keys(configMethods) as (keyof typeof configMethods)[]) if (config[key] !== configMethods[key]) throw new Error('The setup configuration port changed.');
    for (const key of Object.keys(secretMethods) as (keyof typeof secretMethods)[]) if (secrets[key] !== secretMethods[key]) throw new Error('The setup credential port changed.');
    if (stopped || settingKeys.some((key, index) => JSON.stringify(config.get(key)) !== settings[index])
      || envKeys.some((key, index) => process.env[key] !== environment[index])) throw new Error('The Google setup write owner changed.');
    if (configTransition) configTransition();
    else if (configRevision?.() !== expectedConfig) throw new Error('The Google setup configuration changed.');
    if (secretTransition) secretTransition();
    else {
      const state = secretRevision?.();
      if (state?.generation !== expectedSecret || state?.pending) throw new Error('The Google setup credential owner changed.');
    }
  }
  return { assertCurrent: current,
    config: { get: key => { current(); return configPort.get(key); },
      set: (key, value, ownership) => {
        current();
        if (!ownership) { configPort.set(key, value); return; }
        const handle = config.prepareSettingMutation({ operation: 'set', key: key as ConfigKey, value });
        const facts = config.inspectPreparedMutation(handle);
        ownership.assertCurrent(); current(); ownership.consumeObservation();
        let committed = false;
        try {
          const transition = config.beginPreparedMutation(handle);
          configTransition = () => config.assertPreparedMutationTransition(handle, transition);
          current(); ownership.assertCurrent();
          const receipt = config.finishPreparedMutation(handle, transition, () => { current(); ownership.assertCurrent(); });
          committed = receipt.status === 'committed';
          if (!committed) throw new Error('The exact setup configuration write did not fully commit.');
          configTransition = undefined; expectedConfig = facts.incarnation + 1;
          current(); ownership.committed();
        } catch (error) { stopped = true; if (committed || error instanceof SecretWriteCommittedError) throw new GoogleSetupWriteCommittedError(); throw error; }
      },
    },
    secrets: { get: async key => { current(); const value = await secretPort.get(key); current(); return value; },
      set: async (key, value, ownership) => {
        current();
        if (!ownership) { await secretPort.set(key, value); return; }
        let committed = false;
        try {
          await secrets.set(key, value, { assertCurrent: () => { current(); ownership.assertCurrent(); }, effect: token => {
            const facts = secrets.inspectWriteTransition(token);
            if (facts.phase !== 'prepared' || facts.key !== key || facts.beforeGeneration !== expectedSecret) throw new Error('The exact setup credential write changed.');
            current(); ownership.consumeObservation();
            secretTransition = () => secrets.assertWriteTransition(token);
            return {
              assertCurrent: () => { current(); ownership.assertCurrent(); },
              committed: () => {
                const receipt = secrets.inspectWriteTransition(token);
                if (receipt.phase !== 'committed') throw new Error('The setup credential write has no committed receipt.');
                committed = true; secretTransition = undefined; expectedSecret = receipt.beforeGeneration + 2;
                current(); ownership.committed();
              },
            };
          } });
        } catch (error) { stopped = true; if (committed || error instanceof SecretWriteCommittedError) throw new GoogleSetupWriteCommittedError(); throw error; }
      },
      ...(secretPort.delete ? { delete: secretPort.delete.bind(secretPort) } : {}),
    },
  };
}
