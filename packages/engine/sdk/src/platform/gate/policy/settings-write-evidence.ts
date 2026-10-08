/** Settings observations for the shared autonomous admission owner. Never a grant. */
import type { ChoiceReading, EntryType, JudgmentPort, YesNoReading } from '@goodvibes-jev/judgment';
import { snapshotJudgmentInput } from '../judgment-input.js';
import { settingsHazard, type SettingsHazard } from '../batteries/settings-hazard.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { configKeyDescription } from '../../config/credential-key-reading.js';
import { credentialValue, credentialValueState } from '../../tools/batteries/credential-value.js';

/** Historical argument name, retained as request context rather than an approval token. */
export const AGENT_SETTINGS_CONFIRMATION_PROPERTY = 'explicitUserRequest';
export const SETTINGS_HAZARD_SITE = 'engine.gate.settings-write';

export type SettingsToolArgs = {
  readonly mode?: unknown;
  readonly key?: unknown;
  readonly explicitUserRequest?: unknown;
  readonly [name: string]: unknown;
};

export interface SettingsWriteEvidence {
  readonly key: string;
  readonly hazard: ChoiceReading<SettingsHazard>;
  readonly requested?: YesNoReading;
  /** Absent on legacy unrecorded ports. Autonomous admission must reject that case. */
  readonly judgmentDecisionId?: string;
  readonly presentation?: Readonly<{ previous: unknown; current: unknown }> | undefined;
}

/**
 * Ask the existing battery through the caller's scoped port. The complete
 * immutable invocation is inspected before any provider call and accompanies
 * the question, including mode and effect scope. No retry, permission decision,
 * approval callback or synthetic call lineage lives in this helper.
 */
export async function readSettingsWriteEvidence(
  args: SettingsToolArgs, port: JudgmentPort, signal?: AbortSignal,
  ownerEvidence?: { readonly source: unknown; readonly effect: Readonly<Record<string, unknown>> } | undefined,
): Promise<SettingsWriteEvidence | null> {
  signal?.throwIfAborted();
  const invocation = snapshotJudgmentInput(args, 'goodvibes_settings') as SettingsToolArgs;
  const key = typeof invocation.key === 'string' ? invocation.key.trim() : '';
  if (!key) return null;
  const owned = ownerEvidence === undefined ? undefined : snapshotJudgmentInput(ownerEvidence, 'goodvibes_settings') as {
    readonly source: unknown; readonly effect: Readonly<Record<string, unknown>>;
  };
  // On adopted calls the host source is authoritative context. Model-authored
  // explicitUserRequest is just an argument and cannot replace that source.
  const request = owned === undefined ? invocation[AGENT_SETTINGS_CONFIRMATION_PROPERTY] : JSON.stringify(owned['source']);
  const hasRequest = typeof request === 'string' && request.trim().length > 0;
  const run = await settingsHazard.run(port, {
    key, value: JSON.stringify((owned === undefined ? invocation['value'] : owned.effect['value']) ?? null), invocation,
    ...(owned === undefined ? {} : { source: owned['source'], effect: owned['effect'] }),
    ...(hasRequest ? { request: request.trim() } : {}),
  } as EntryType, {
    site: SETTINGS_HAZARD_SITE, ...(signal === undefined ? {} : { signal }),
    only: hasRequest ? ['hazard', 'requested'] : ['hazard'],
  });
  signal?.throwIfAborted();
  let presentation: SettingsWriteEvidence['presentation'];
  if (ownerEvidence) {
    const effect = (owned as { effect: Readonly<Record<string, unknown>> }).effect;
    const show = async (value: unknown): Promise<unknown> => {
      if (value && typeof value === 'object' && !Array.isArray(value)
        && (value as Record<string, unknown>)['unavailable'] === true
        && Object.keys(value).length === 1) return value;
      const posture = Object.freeze({ redacted: true, configured: value !== undefined && value !== null && value !== '' });
      if (isSecretBearingConfigKey(key)) {
        // Previous values were already projected by the backend without exposing
        // the credential. Do not mistake that posture object for a configured value.
        if (value && typeof value === 'object' && !Array.isArray(value)
          && (value as Record<string, unknown>)['redacted'] === true
          && typeof (value as Record<string, unknown>)['configured'] === 'boolean') return value;
        return posture;
      }
      if (typeof value !== 'string' || value.trim() === '' || value.startsWith('goodvibes://')) return value;
      // The complete protected input crossed snapshotJudgmentInput above. This
      // recorded observation is never a substitute for that privacy barrier.
      const read = await credentialValue.run(port, credentialValueState(key, configKeyDescription(key), value),
        { site: 'tools.goodvibes-runtime.credential-value', ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (!read.result.decisionId) throw new Error('Settings display evidence has no recorded provenance');
      return read.readings.credential_material.verdict === 'no' && read.readings.credential_material.outcome === 'act' ? value : posture;
    };
    presentation = Object.freeze({ previous: await show(effect['previous']), current: await show(effect['value']) });
  }
  return Object.freeze({
    key, hazard: Object.freeze({ ...run.readings.hazard, probabilities: Object.freeze({ ...run.readings.hazard.probabilities }) }),
    ...(hasRequest ? { requested: Object.freeze({ ...run.readings.requested }) } : {}),
    ...(run.result.decisionId === undefined ? {} : { judgmentDecisionId: run.result.decisionId }),
    ...(presentation ? { presentation } : {}),
  });
}
