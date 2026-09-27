/**
 * A fake judgment port for contract check tests: answers the unit judge
 * (`goal`, `criterion_<i>`), the quality battery (its six items) and the
 * severity battery from plain probabilities, and records every request.
 */
import type { Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { QualityItem } from '../../sdk/src/platform/contract/types.js';

/** Probabilities that each question fails: `criteria[i]` for criterion i, `goal`, and each quality item. */
export interface CheckAnswers {
  readonly criteria?: readonly number[];
  readonly goal?: number;
  readonly quality?: Partial<Record<QualityItem, number>>;
  readonly severity?: { readonly choice: 'critical' | 'major' | 'minor'; readonly confidence: number };
}

/** Clearly met, clean and settled: past the act threshold on the pass side of every band. */
export const MET = 0.05;
/** Clearly failing: past the act threshold on the fail side. */
export const UNMET = 0.9;

export function checkPort(answers: CheckAnswers, onAsk?: (name: string) => void) {
  return fakePort((name: string, question: Question) => {
    onAsk?.(name);
    if (name === 'severity') {
      const severity = answers.severity ?? { choice: 'major', confidence: 0.9 };
      return choiceAnswer(question, severity.choice, severity.confidence);
    }
    if (name === 'goal') return noulAnswer(answers.goal ?? MET);
    const criterion = /^criterion_(\d+)$/.exec(name);
    if (criterion !== null) return noulAnswer(answers.criteria?.[Number(criterion[1])] ?? MET);
    return noulAnswer(answers.quality?.[name as QualityItem] ?? MET);
  });
}
