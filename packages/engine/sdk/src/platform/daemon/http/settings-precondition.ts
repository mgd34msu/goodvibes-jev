/** Wire the HTTP protocol to the real serving ConfigManager and auth owners. */
import { createSettingsPreconditionHandler, type SettingsPreconditionHandler, type SettingsPreconditionRequest } from '@goodvibes-jev/engine/daemon-sdk';
import type { ConfigManager, PreparedConfigMutation } from '../../config/manager.js';
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import type { DaemonControlPlaneHelper } from '../control-plane.js';
import { readHostSettingsFile } from '../../config/manager-host-settings.js';
import { readDotPath } from '../../config/shared-config-tier.js';

export interface ServingSettingsAuthority {
  readonly settingsLifetime: () => object | null;
  readonly captureSettingsAdminAuthority: DaemonControlPlaneHelper['captureSettingsAdminAuthority'];
  readonly withSettingsAdminAuthority: DaemonControlPlaneHelper['withSettingsAdminAuthority'];
}
export function createServingSettingsPrecondition(
  manager: ConfigManager,
  authority: ServingSettingsAuthority,
): SettingsPreconditionHandler {
  // Wire operations retain exact semantics: remote reset historically sets the
  // serving schema default; local reset has a separate remove-override plan.
  const operations = new WeakMap<PreparedConfigMutation, SettingsPreconditionRequest['operation']>();
  return createSettingsPreconditionHandler({
    lifetime: authority.settingsLifetime,
    captureAuthority: (req) => authority.captureSettingsAdminAuthority(req),
    withAuthority: (req, captured, callback) => authority.withSettingsAdminAuthority(req, captured, callback),
    owner: {
      prepare(request) {
        const setting = manager.getSchema().find(entry => entry.key === request.key);
        if (!setting) throw new Error('Setting unavailable');
        const value = request.operation === 'reset-default' ? setting.default : request.value;
        // No semantic battery, secret resolution or raw old-value read belongs
        // in capture/commit. This is the same deterministic privacy boundary.
        const safe = snapshotJudgmentInput({ mode: 'set', key: setting.key, value }, 'goodvibes_settings') as { value: unknown };
        const prepared = manager.prepareSettingMutation({ operation: 'set', key: setting.key, value: safe.value });
        operations.set(prepared, request.operation);
        return prepared;
      },
      inspect(prepared) {
        const facts = manager.inspectPreparedMutation(prepared);
        const safe = snapshotJudgmentInput({ mode: 'set', key: facts.key, value: facts.value }, 'goodvibes_settings') as { value: unknown };
        return Object.freeze({ ...facts, operation: operations.get(prepared)!, value: safe.value });
      },
      assert: (prepared) => manager.assertPreparedMutation(prepared),
      begin: (prepared) => manager.beginPreparedMutation(prepared),
      assertTransition: (prepared, transition) => manager.assertPreparedMutationTransition(prepared, transition),
      finish(prepared, transition) {
        const facts = manager.inspectPreparedMutation(prepared);
        const receipt = manager.finishPreparedMutation(prepared, transition);
        if (receipt.status !== 'committed') return receipt;
        let verifiedInOwningStore = false;
        try {
          // Pure reporting after the effect receipt. Never authenticate again,
          // quarantine, repair, retry or substitute another owner's cached value.
          verifiedInOwningStore = facts.destinations.every(destination => {
            const found = readDotPath(readHostSettingsFile(destination.path), facts.key);
            return destination.operation === 'remove' ? !found.present
              : found.present && JSON.stringify(found.value) === JSON.stringify(facts.value);
          });
        } catch { /* Committed but readback unavailable is still committed. */ }
        return Object.freeze({ ...receipt, verifiedInOwningStore });
      },
    },
  });
}
