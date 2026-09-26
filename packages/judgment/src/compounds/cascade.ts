import type { JsonValue, JudgmentPort } from '../port/types.ts';
import type { Judge, Judgment } from '../patterns/judge.ts';
import type { CallOptions } from '../patterns/common.ts';

/** One way to produce the work, cheapest first: a small model, then a stronger one. */
export interface Tier<O extends JsonValue> {
  readonly name: string;
  produce(signal?: AbortSignal): Promise<O>;
}

export interface CascadeTask<O extends JsonValue> {
  readonly goal: string;
  readonly criteria: readonly string[];
  /** Evidence the judge may read beside an output: test results, command output. */
  readonly evidence?: (output: O) => JsonValue | Promise<JsonValue>;
}

export interface CascadeAttempt<O extends JsonValue> {
  readonly tier: string;
  readonly output: O;
  readonly judgment: Judgment;
}

export interface CascadeResult<O extends JsonValue> {
  /** The first output that passed, or the last one tried when none did. */
  readonly output: O;
  readonly tier: string;
  readonly accepted: boolean;
  readonly judgment: Judgment;
  readonly attempts: readonly CascadeAttempt<O>[];
}

/**
 * Verify-then-escalate (the SDE cascade): produce with the cheapest tier,
 * judge the output against the goal and criteria, and escalate to the next
 * tier only when the judge does not pass it. Cheap work that passes costs
 * nothing more; only flagged work pays for a stronger tier. The judge is the
 * calibrated decision; the cascade adds no judgment of its own.
 */
export async function verifyThenEscalate<O extends JsonValue>(
  port: JudgmentPort,
  judge: Judge,
  tiers: readonly Tier<O>[],
  task: CascadeTask<O>,
  options: CallOptions = {},
): Promise<CascadeResult<O>> {
  if (tiers.length === 0) throw new RangeError('a cascade needs at least one tier');
  const attempts: CascadeAttempt<O>[] = [];
  for (const tier of tiers) {
    const output = await tier.produce(options.signal);
    const evidence = task.evidence === undefined ? undefined : await task.evidence(output);
    const judgment = await judge.judge(
      port,
      { goal: task.goal, criteria: task.criteria, output, ...(evidence === undefined ? {} : { evidence }) },
      options,
    );
    attempts.push({ tier: tier.name, output, judgment });
    if (judgment.verdict === 'pass') {
      judgment.recordAction(`accept:${tier.name}`);
      return { output, tier: tier.name, accepted: true, judgment, attempts };
    }
    judgment.recordAction(attempts.length < tiers.length ? `escalate-from:${tier.name}` : `exhausted:${tier.name}`);
  }
  const last = attempts.at(-1)!;
  return { output: last.output, tier: last.tier, accepted: false, judgment: last.judgment, attempts };
}
