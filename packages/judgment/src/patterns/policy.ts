import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, score, type EntryType, type JudgmentPort, type NoulQuestion, type ScoreCriteria } from '../port/types.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from './common.ts';

/**
 * Policy checklist (guardrails for LLMs): one Noul per hazard plus one Score
 * on how much harm going ahead would do, all in one request. A named policy
 * turns the probabilities into one action in code: a hazard at or above the
 * action threshold triggers its own action, one at or above the review
 * threshold sends the case to review, and severity at or above its line
 * hardens a review into the severity action. The highest-precedence action
 * wins. The probabilities never change with the policy; only the decision does.
 */
export interface PolicySpec<H extends string, A extends string> extends PatternHeader {
  readonly hazards: Readonly<
    Record<H, { readonly instructions: EntryType; readonly yes: EntryType; readonly no: EntryType; readonly action: A }>
  >;
  readonly severity: { readonly instructions: EntryType; readonly levels: ScoreCriteria };
  /** Every action, highest precedence first; must include 'review', and end with 'pass'. */
  readonly precedence: readonly (A | 'review' | 'pass')[];
  /** The action a review becomes when severity crosses the line. */
  readonly severityAction: A;
  readonly policies: Readonly<
    Record<string, { readonly review: number; readonly action: number; readonly severityLine: number }>
  >;
  readonly defaultPolicy: string;
  readonly fixtures: readonly {
    readonly name: string;
    readonly state: EntryType;
    readonly policy?: string;
    readonly expect: A | 'review' | 'pass';
  }[];
}

export interface PolicyResult<H extends string, A extends string> {
  readonly action: A | 'review' | 'pass';
  readonly hazards: Readonly<Record<H, number>>;
  /** Expected severity level (0 to the top level) and the model's confidence in it. */
  readonly severity: { readonly score: number; readonly confidence: number };
  readonly policy: string;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface PolicyChecklist<H extends string, A extends string> extends NamedDecision {
  screen(port: JudgmentPort, state: EntryType, options?: CallOptions & { readonly policy?: string }): Promise<PolicyResult<H, A>>;
  /** Re-decides stored probabilities under another policy without asking again. */
  route(hazards: Readonly<Record<H, number>>, severity: number, policy: string): A | 'review' | 'pass';
}

export function definePolicyChecklist<const H extends string, const A extends string>(
  spec: PolicySpec<H, A>,
): PolicyChecklist<H, A> {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  const hazardNames = Object.keys(spec.hazards) as H[];
  if (hazardNames.length === 0) throw new RangeError(`policy ${spec.name}: needs at least one hazard`);
  const actions = new Set<string>([...hazardNames.map((h) => spec.hazards[h].action), spec.severityAction, 'review', 'pass']);
  for (const action of actions) {
    if (!spec.precedence.includes(action as A)) throw new RangeError(`policy ${spec.name}: precedence is missing "${action}"`);
  }
  if (spec.precedence.at(-1) !== 'pass') throw new RangeError(`policy ${spec.name}: 'pass' must come last in precedence`);
  for (const [policyName, policy] of Object.entries(spec.policies)) {
    if (!(policy.review >= 0 && policy.review <= policy.action && policy.action <= 1)) {
      throw new RangeError(`policy ${spec.name}: ${policyName} needs 0 <= review <= action <= 1`);
    }
  }
  if (!(spec.defaultPolicy in spec.policies)) throw new RangeError(`policy ${spec.name}: unknown default policy`);
  for (const fixture of spec.fixtures) {
    if (!actions.has(fixture.expect)) throw new RangeError(`policy ${spec.name}: fixture ${fixture.name} expects unknown action`);
    if (fixture.policy !== undefined && !(fixture.policy in spec.policies)) {
      throw new RangeError(`policy ${spec.name}: fixture ${fixture.name} names unknown policy`);
    }
  }

  const questions: Record<string, NoulQuestion | ReturnType<typeof score>> = {
    severity: score(spec.severity.instructions, spec.severity.levels),
  };
  for (const hazard of hazardNames) {
    const { instructions, yes, no } = spec.hazards[hazard];
    questions[`hazard_${hazard}`] = noul(instructions, { true: yes, false: no });
  }
  const topLevel = spec.severity.levels.length - 1;

  const route = (hazards: Readonly<Record<H, number>>, severity: number, policyName: string): A | 'review' | 'pass' => {
    const policy = spec.policies[policyName];
    if (policy === undefined) throw new RangeError(`policy ${spec.name}: unknown policy "${policyName}"`);
    let triggered: (A | 'review')[] = [];
    for (const hazard of hazardNames) {
      const p = hazards[hazard];
      if (p >= policy.action) triggered.push(spec.hazards[hazard].action);
      else if (p >= policy.review) triggered.push('review');
    }
    if (severity >= policy.severityLine) triggered = triggered.map((action) => (action === 'review' ? spec.severityAction : action));
    return spec.precedence.find((action) => triggered.includes(action as A | 'review')) ?? 'pass';
  };

  const checklist: PolicyChecklist<H, A> = {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: spec.fixtures.length,
    route,
    async screen(port, state, options = {}) {
      const policy = options.policy ?? spec.defaultPolicy;
      const result = await askAs(port, spec, 'policy', state, questions, options);
      const answers = result.answers as Record<string, unknown>;
      const hazards = Object.fromEntries(
        hazardNames.map((hazard) => [hazard, (answers[`hazard_${hazard}`] as { noul: number }).noul]),
      ) as Record<H, number>;
      const severityAnswer = answers['severity'] as { score: number; confidence: number };
      const severity = { score: severityAnswer.score, confidence: severityAnswer.confidence };
      const action = route(hazards, severity.score, policy);
      recordReadings(port, result, { action, policy, hazards, severity, severityNormalized: severity.score / topLevel });
      return { action, hazards, severity, policy, decisionId: result.decisionId, recordAction: (a) => recordAction(port, result.decisionId, a) };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const got = await checklist.screen(port, fixture.state, {
          site: 'calibration',
          ...(fixture.policy === undefined ? {} : { policy: fixture.policy }),
          ...options,
        });
        const strongest = Math.max(...Object.values<number>(got.hazards));
        checks.push({
          fixture: fixture.name,
          aspect: 'action',
          expected: fixture.expect,
          got: got.action,
          correct: got.action === fixture.expect,
          signal: got.action === 'pass' ? 1 - strongest : strongest,
          outcome: got.action === 'pass' ? 'act' : got.action === 'review' ? 'escalate' : 'act',
        });
      }
      return checks;
    },
  };
  return checklist;
}
