import { hashState, type DecisionLog, type JsonValue } from '@goodvibes-jev/judgment';
import type { ContractView } from './types.js';

/** Read the actual recorded API identity behind host check references. This
 * describes execution, never grants semantic approval or fills a missing call. */
export function judgmentExecutionEvidence(contract: ContractView, log: Pick<DecisionLog, 'get'> | undefined, finalAnswerIds: readonly string[]): JsonValue | undefined {
  if (!log) return undefined;
  const phases = {
    plan: contract.decisions.filter(decision => decision.action === 'plan-accepted').flatMap(decision => decision.decisionIds),
    units: contract.units.flatMap(unit => unit.checks.at(-1)?.decisionIds ?? []),
    integratedWork: contract.groups.flatMap(group => group.checks.at(-1)?.decisionIds ?? []),
    finalAnswer: [...finalAnswerIds],
  };
  return { operation: 'read-runtime-native-judgment-log', source: 'native-host',
    meaning: 'Actual recorded Jev API executions for existing host check IDs. The IDs remain in planChecks, unit/group latestCheck and finalAnswerReview. These facts identify who performed those validations; they do not replace semantic review of project work, approve this current requirements check or turn missing calls into success.',
    phases: Object.entries(phases).map(([phase, linked]) => {
      const ids = [...new Set(linked)], rows = ids.map(id => ({ id, entry: log.get(id) }));
      const models = new Map<string, number>();
      for (const { entry } of rows) {
        if (entry?.status !== 'answered') continue;
        const key = JSON.stringify([entry.requestedModel, entry.model]);
        models.set(key, (models.get(key) ?? 0) + 1);
      }
      return { phase, linkedCheckDecisionIdsDigest: hashState(ids), decisions: ids.length,
        answered: rows.filter(({ entry }) => entry?.status === 'answered').length,
        models: [...models].map(([key, count]) => { const [requestedModel, model] = JSON.parse(key) as string[]; return { requestedModel: requestedModel!, model: model!, count }; }),
        missingOrUnanswered: rows.filter(({ entry }) => entry?.status !== 'answered').map(({ id }) => id),
      };
    }) };
}
