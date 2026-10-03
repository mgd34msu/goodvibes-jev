/** Settings observations for the shared autonomous admission owner. Never a grant. */
import type { ChoiceReading, EntryType, JudgmentPort, YesNoReading } from '@goodvibes-jev/judgment';
import { snapshotJudgmentInput } from '../judgment-input.js';
import { settingsHazard, type SettingsHazard } from '../batteries/settings-hazard.js';

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
}

/**
 * Ask the existing battery through the caller's scoped port. The complete
 * immutable invocation is inspected before any provider call and accompanies
 * the question, including mode and effect scope. No retry, permission decision,
 * approval callback or synthetic call lineage lives in this helper.
 */
export async function readSettingsWriteEvidence(
  args: SettingsToolArgs, port: JudgmentPort, signal?: AbortSignal,
): Promise<SettingsWriteEvidence | null> {
  signal?.throwIfAborted();
  const invocation = snapshotJudgmentInput(args, 'goodvibes_settings') as SettingsToolArgs;
  const key = typeof invocation.key === 'string' ? invocation.key.trim() : '';
  if (!key) return null;
  const request = invocation[AGENT_SETTINGS_CONFIRMATION_PROPERTY];
  const hasRequest = typeof request === 'string' && request.trim().length > 0;
  const run = await settingsHazard.run(port, {
    key, value: JSON.stringify(invocation['value'] ?? null), invocation,
    ...(hasRequest ? { request: request.trim() } : {}),
  } as EntryType, {
    site: SETTINGS_HAZARD_SITE, ...(signal === undefined ? {} : { signal }),
    only: hasRequest ? ['hazard', 'requested'] : ['hazard'],
  });
  signal?.throwIfAborted();
  return Object.freeze({
    key, hazard: Object.freeze({ ...run.readings.hazard, probabilities: Object.freeze({ ...run.readings.hazard.probabilities }) }),
    ...(hasRequest ? { requested: Object.freeze({ ...run.readings.requested }) } : {}),
    ...(run.result.decisionId === undefined ? {} : { judgmentDecisionId: run.result.decisionId }),
  });
}
