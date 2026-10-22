import { hashState, type JsonValue, type NoulQuestion, type YesNoReading } from '@goodvibes-jev/judgment';
import type { ContractView } from './types.js';
import { nativeContractSourceData } from './native-source.js';

export interface GoalObligationProof {
  readonly schemaVersion: 1;
  readonly policy: { readonly name: string; readonly version: number };
  readonly literalSourceDigest: string;
  readonly outputDigest: string;
  readonly stateHash: string;
  readonly sourceJudgmentDecisionIds: readonly string[];
  readonly sourceGoal: Pick<YesNoReading, 'probability' | 'verdict' | 'outcome'>;
  readonly reading: Pick<YesNoReading, 'probability' | 'verdict' | 'outcome'>;
  readonly decisionIds: readonly string[];
  readonly passed: boolean;
}

/** A hypothetical implication, not facts about the work. Excluded criteria
 * cannot serve as premises; actual fulfillment remains independently checked. */
export function goalObligationSource(contract: Pick<ContractView, 'goal' | 'ask' | 'criteria' | 'nativeSource' | 'originalSource'>): JsonValue & object {
  return { goal: contract.goal, originalRequest: contract.ask,
    criteria: contract.criteria.filter(criterion => criterion.disposition === 'judged' || criterion.disposition === 'met-by-structure')
      .map(criterion => ({ id: criterion.id, text: criterion.text, disposition: criterion.disposition })),
    ...(contract.nativeSource === undefined ? {} : { nativeSource: nativeContractSourceData(contract.nativeSource) }),
    ...(contract.originalSource === undefined ? {} : { originalSource: { goal: contract.originalSource.goal, criteria: [...contract.originalSource.criteria] } }),
  };
}

export function goalObligationQuestion(question: NoulQuestion, literalSourceDigest: string): NoulQuestion {
  return { ...question, instructions: { question: question.instructions ?? null, literalSourceDigest } };
}
