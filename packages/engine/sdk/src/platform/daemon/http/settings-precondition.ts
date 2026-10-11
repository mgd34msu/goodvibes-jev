/** SETTINGS preconditions bind the real serving config, credential and auth owners. */
import { createSettingsPreconditionHandler, type SettingsPreconditionFacts, type SettingsPreconditionHandler, type SettingsPreconditionRequest } from '@goodvibes-jev/engine/daemon-sdk';
import type { ConfigManager, PreparedConfigMutation, PreparedConfigMutationReceipt } from '../../config/manager.js';
import type { PreparedScopedSecretDeletion, SecretsManager } from '../../config/secrets.js';
import { isDaemonOwnedConfigKey } from '../../config/config-ownership.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { daemonSecretKeyFor } from '../../config/daemon-secret-keys.js';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import type { DaemonControlPlaneHelper } from '../control-plane.js';
import { readHostSettingsFile } from '../../config/manager-host-settings.js';
import { readDotPath } from '../../config/shared-config-tier.js';

export interface ServingSettingsAuthority {
  readonly settingsLifetime: () => object | null;
  readonly captureSettingsAdminAuthority: DaemonControlPlaneHelper['captureSettingsAdminAuthority'];
  readonly withSettingsAdminAuthority: DaemonControlPlaneHelper['withSettingsAdminAuthority'];
}
export type ServingSettingsSecrets = Pick<SecretsManager, 'prepareScopedDeletion' | 'inspectPreparedScopedDeletion' | 'assertPreparedScopedDeletion' | 'withPreparedScopedDeletion' | 'assertCompletedScopedDeletion'>;
type FinishSecret = (assertCurrent: () => void) => PreparedConfigMutationReceipt;
interface Prepared {
  readonly config: PreparedConfigMutation;
  readonly operation: SettingsPreconditionRequest['operation'];
  readonly secret?: { readonly owner: ServingSettingsSecrets; readonly handle: PreparedScopedSecretDeletion; readonly scope: 'daemon' | 'user' };
  finishSecret?: FinishSecret;
}
export function createServingSettingsPrecondition(
  manager: ConfigManager,
  authority: ServingSettingsAuthority,
  secrets: () => ServingSettingsSecrets | null = () => null,
  assertServingOwner: () => void = () => {},
): SettingsPreconditionHandler {
  const assertSecretOwner = (prepared: Prepared) => {
    assertServingOwner();
    if (prepared.secret && secrets() !== prepared.secret.owner) throw new Error('Credential owner changed.');
  };
  return createSettingsPreconditionHandler({
    lifetime: authority.settingsLifetime,
    captureAuthority: (req) => authority.captureSettingsAdminAuthority(req),
    withAuthority: (req, captured, callback) => authority.withSettingsAdminAuthority(req, captured, callback),
    owner: {
      prepare(request): Prepared {
        assertServingOwner();
        const setting = manager.getSchema().find(entry => entry.key === request.key);
        if (!setting) throw new Error('Setting unavailable');
        const value = request.operation === 'reset-default' ? setting.default : request.value;
        const safe = snapshotJudgmentInput({ mode: 'set', key: setting.key, value }, 'goodvibes_settings') as { value: unknown };
        const config = manager.prepareSettingMutation({ operation: 'set', key: setting.key, value: safe.value });
        if (!request.credentialClear) return { config, operation: request.operation };
        // The caller cannot name a credential or widen its scope. References
        // are config-only; clear/reset bind the exact derived credential.
        if (!isSecretBearingConfigKey(setting.key) || (request.operation === 'set' && safe.value !== '')) throw new Error('Credential clear unavailable');
        const owner = secrets();
        if (!owner) throw new Error('Credential owner unavailable');
        const scope = isDaemonOwnedConfigKey(setting.key) ? 'daemon' : 'user';
        const handle = owner.prepareScopedDeletion(daemonSecretKeyFor(setting.key), scope);
        return { config, operation: request.operation, secret: { owner, handle, scope } };
      },
      inspect(prepared): SettingsPreconditionFacts {
        const facts = manager.inspectPreparedMutation(prepared.config);
        const safe = snapshotJudgmentInput({ mode: 'set', key: facts.key, value: facts.value }, 'goodvibes_settings') as { value: unknown };
        const credential = prepared.secret ? prepared.secret.owner.inspectPreparedScopedDeletion(prepared.secret.handle) : null;
        return Object.freeze({ operation: prepared.operation, key: facts.key, incarnation: facts.incarnation, value: safe.value,
          destinations: Object.freeze([...(credential?.destinations ?? []), ...facts.destinations]),
          ...(credential && prepared.secret ? { credentialClear: true as const, credential: Object.freeze({ key: credential.key,
            scope: prepared.secret.scope, destinations: credential.destinations }) } : {}) });
      },
      assert(prepared) {
        manager.assertPreparedMutation(prepared.config); assertSecretOwner(prepared);
        // Acquiring locks spends the secret handle. Its one-use finish rechecks
        // the exact generation, policy and store observations before writing.
        if (prepared.secret && !prepared.finishSecret) prepared.secret.owner.assertPreparedScopedDeletion(prepared.secret.handle);
      },
      async withPrepared(prepared, operation) {
        if (!prepared.secret) return operation();
        assertSecretOwner(prepared);
        return prepared.secret.owner.withPreparedScopedDeletion(prepared.secret.handle, finish => {
          prepared.finishSecret = finish;
          try { return operation(); } finally { delete prepared.finishSecret; }
        });
      },
      begin: (prepared) => manager.beginPreparedMutation(prepared.config),
      assertTransition(prepared, transition) { assertSecretOwner(prepared); manager.assertPreparedMutationTransition(prepared.config, transition); },
      finish(prepared, transition, assertCurrent) {
        const facts = manager.inspectPreparedMutation(prepared.config);
        const completedPaths: string[] = [];
        let secretCompleted = false;
        const assertBound = () => {
          assertCurrent(); assertSecretOwner(prepared); manager.assertPreparedMutationTransition(prepared.config, transition);
          if (secretCompleted && prepared.secret) prepared.secret.owner.assertCompletedScopedDeletion(prepared.secret.handle);
        };
        if (prepared.secret) {
          if (!prepared.finishSecret) throw new Error('Credential ownership unavailable');
          const receipt = prepared.finishSecret(assertBound);
          completedPaths.push(...receipt.completedPaths);
          if (receipt.status !== 'committed') return Object.freeze({ ...receipt, uncertainPath: receipt.uncertainPath ?? facts.destinations[0]!.path });
          secretCompleted = true;
        }
        let receipt: PreparedConfigMutationReceipt;
        try {
          assertBound();
          receipt = manager.finishPreparedMutation(prepared.config, transition, assertBound); }
        catch {
          return Object.freeze({ status: completedPaths.length ? 'partial' as const : 'unknown' as const,
            completedPaths: Object.freeze(completedPaths), uncertainPath: facts.destinations[0]!.path });
        }
        completedPaths.push(...receipt.completedPaths);
        if (receipt.status !== 'committed') return Object.freeze({ ...receipt,
          status: completedPaths.length ? 'partial' as const : 'unknown' as const, completedPaths: Object.freeze(completedPaths) });
        let verifiedInOwningStore = false;
        try {
          // Pure reporting only: verify both physical owners without re-reading
          // authority or turning a completed effect into a refusal.
          assertSecretOwner(prepared);
          if (prepared.secret) prepared.secret.owner.assertCompletedScopedDeletion(prepared.secret.handle);
          verifiedInOwningStore = facts.destinations.every(destination => {
            const found = readDotPath(readHostSettingsFile(destination.path), facts.key);
            return destination.operation === 'remove' ? !found.present
              : found.present && JSON.stringify(found.value) === JSON.stringify(facts.value);
          });
        } catch { /* A readback failure never undoes the truthful receipt. */ }
        return Object.freeze({ status: 'committed' as const, completedPaths: Object.freeze(completedPaths), verifiedInOwningStore });
      },
    },
  });
}
