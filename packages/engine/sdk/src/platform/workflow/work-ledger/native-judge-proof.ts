/** Reconstructs a complete original-requirements reading from actual recorded batches. */
import type { DecisionLog } from '@goodvibes-jev/judgment';
import type { ContractView } from '../../contract/types.js';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

interface NativeQuestionReading {
  readonly decisionId: string;
  readonly answer: { readonly type: 'noul'; readonly noul: number };
  readonly question: Record<string, unknown>;
}

export function nativeQuestionBatches(ids: readonly string[], keys: readonly string[], site: string, log: Pick<DecisionLog, 'get'>): ReadonlyMap<string, NativeQuestionReading> | null {
  if (!ids.length || new Set(ids).size !== ids.length) return null;
  const expected = new Set(keys);
  const readings = new Map<string, NativeQuestionReading>();
  let stateHash: string | undefined, battery: string | undefined, version: number | undefined;
  for (const id of ids) {
    const entry = log.get(id);
    if (!entry || entry.status !== 'answered' || entry.context.site !== site || typeof entry.stateHash !== 'string' || !entry.stateHash) return null;
    if (stateHash === undefined) { stateHash = entry.stateHash; battery = entry.context.battery; version = entry.context.batteryVersion; }
    else if (entry.stateHash !== stateHash || entry.context.battery !== battery || entry.context.batteryVersion !== version) return null;
    const answers = object(entry.answers), questions = object(entry.questions);
    if (!answers || !questions || !Object.keys(answers).length
      || JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(Object.keys(questions).sort())) return null;
    for (const [key, value] of Object.entries(answers)) {
      const answer = object(value), question = object(questions[key]);
      if (!expected.has(key) || readings.has(key) || question?.['type'] !== 'noul' || answer?.['type'] !== 'noul'
        || typeof answer['noul'] !== 'number' || !Number.isFinite(answer['noul']) || answer['noul'] < 0 || answer['noul'] > 1) return null;
      readings.set(key, { decisionId: id, question, answer: { type: 'noul', noul: answer['noul'] } });
    }
  }
  return readings.size === expected.size ? readings : null;
}

export function nativeJudgeBatches(ids: readonly string[], criteria: ContractView['criteria'], site: string, log: Pick<DecisionLog, 'get'>): ReadonlyMap<string, NativeQuestionReading> | null {
  const judged = criteria.filter(criterion => criterion.disposition === 'judged');
  const readings = nativeQuestionBatches(ids, ['goal', ...judged.map((_, index) => `criterion_${index}`)], site, log);
  if (!readings || judged.some((criterion, index) => object(readings.get(`criterion_${index}`)!.question['instructions'])?.['criterion'] !== criterion.text)) return null;
  return readings;
}
