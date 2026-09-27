import type { EvalScenario } from '../runtime/eval/types.js';
import type { BatteryAccuracy } from './accuracy.js';

/** The eval suite name judgment accuracy scenarios run under. */
export const JUDGMENT_EVAL_SUITE = 'judgment-accuracy';

/**
 * One eval scenario per named decision with ground truth and a registered
 * floor, so the eval harness's scorecard, baseline and gate cover judgment
 * accuracy the way they cover performance: a decision below its floor fails
 * the gate, and a drop in accuracy shows as a regression against the
 * baseline. The accuracy comes from the decision log; running a scenario
 * makes no call.
 */
export function judgmentEvalScenarios(accuracy: readonly BatteryAccuracy[]): EvalScenario[] {
  return accuracy.flatMap((row) => {
    if (row.accuracyFloor === undefined) return [];
    const { battery, accuracyFloor } = row;
    return [
      {
        id: `judgment:${battery}`,
        name: `${battery} accuracy`,
        suite: JUDGMENT_EVAL_SUITE,
        description: `Accuracy of ${battery} over the ground truth in the decision log, against its registered floor.`,
        tags: ['judgment', 'quality'],
        run: async () => ({
          completed: true,
          durationMs: 0,
          judgment: { battery, accuracy: row.accuracy, accuracyFloor, checks: row.checks },
        }),
      },
    ];
  });
}
