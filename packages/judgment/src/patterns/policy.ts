import { assertDecisionHeader, assertUniqueFixtures, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, score, type EntryType, type JudgmentPort, type NoulResponse, type Question, type ScoreCriteria, type ScoreResponse } from '../port/types.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

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

type Action<A extends string> = A | 'review' | 'pass';

const thresholdsOrdered = (review: number, action: number): boolean => 0 <= review && review <= action && action <= 1;
const namesKnownPolicy = (policy: string | undefined, policies: Readonly<Record<string, unknown>>): boolean => policy === undefined || policy in policies;

function assertPolicySpec<H extends string, A extends string>(spec: PolicySpec<H, A>, hazards: readonly H[]): void {
  assertDecisionHeader({ ...spec, fixtureCount: spec.fixtures.length });
  assertUniqueFixtures(spec.name, spec.fixtures);
  if (hazards.length === 0) throw new RangeError(`policy ${spec.name}: needs at least one hazard`);
  const actions = new Set<string>([...hazards.map((h) => spec.hazards[h].action), spec.severityAction, 'review', 'pass']);
  const unranked = [...actions].find((action) => !spec.precedence.includes(action as A));
  if (unranked !== undefined) throw new RangeError(`policy ${spec.name}: precedence is missing "${unranked}"`);
  if (spec.precedence.at(-1) !== 'pass') throw new RangeError(`policy ${spec.name}: 'pass' must come last in precedence`);
  for (const [policyName, { review, action }] of Object.entries(spec.policies)) {
    if (!thresholdsOrdered(review, action)) throw new RangeError(`policy ${spec.name}: ${policyName} needs 0 <= review <= action <= 1`);
  }
  if (!(spec.defaultPolicy in spec.policies)) throw new RangeError(`policy ${spec.name}: unknown default policy`);
  for (const fixture of spec.fixtures) {
    if (!actions.has(fixture.expect)) throw new RangeError(`policy ${spec.name}: fixture ${fixture.name} expects unknown action`);
    if (!namesKnownPolicy(fixture.policy, spec.policies)) throw new RangeError(`policy ${spec.name}: fixture ${fixture.name} names unknown policy`);
  }
}

function policyQuestions<H extends string, A extends string>(spec: PolicySpec<H, A>, hazards: readonly H[]): Record<string, Question> {
  const questions: Record<string, Question> = { severity: score(spec.severity.instructions, spec.severity.levels) };
  for (const hazard of hazards) {
    const { instructions, yes, no } = spec.hazards[hazard];
    questions[`hazard_${hazard}`] = noul(instructions, { true: yes, false: no });
  }
  return questions;
}

/** The actions a set of hazard probabilities triggers under one policy, before precedence picks one. */
function triggeredActions<H extends string, A extends string>(
  spec: PolicySpec<H, A>,
  hazards: readonly H[],
  probabilities: Readonly<Record<H, number>>,
  policy: PolicySpec<H, A>['policies'][string],
): (A | 'review')[] {
  return hazards.flatMap((hazard): (A | 'review')[] => {
    const p = probabilities[hazard];
    if (p >= policy.action) return [spec.hazards[hazard].action];
    return p >= policy.review ? ['review'] : [];
  });
}

function makeRouter<H extends string, A extends string>(spec: PolicySpec<H, A>, hazards: readonly H[]) {
  return (probabilities: Readonly<Record<H, number>>, severity: number, policyName: string): Action<A> => {
    const policy = spec.policies[policyName];
    if (policy === undefined) throw new RangeError(`policy ${spec.name}: unknown policy "${policyName}"`);
    const severe = severity >= policy.severityLine;
    const triggered = triggeredActions(spec, hazards, probabilities, policy).map((action) => (severe && action === 'review' ? spec.severityAction : action));
    return spec.precedence.find((action) => triggered.includes(action as A | 'review')) ?? 'pass';
  };
}

function actionCheck(fixture: { readonly name: string; readonly expect: string }, got: PolicyResult<string, string>): FixtureCheck {
  const strongest = Math.max(...Object.values<number>(got.hazards));
  const passed = got.action === 'pass';
  return {
    fixture: fixture.name,
    aspect: 'action',
    expected: fixture.expect,
    got: got.action,
    correct: got.action === fixture.expect,
    signal: passed ? 1 - strongest : strongest,
    outcome: got.action === 'review' ? 'escalate' : 'act',
  };
}

export function definePolicyChecklist<const H extends string, const A extends string>(
  spec: PolicySpec<H, A>,
): PolicyChecklist<H, A> {
  const hazards = Object.keys(spec.hazards) as H[];
  assertPolicySpec(spec, hazards);
  const questions = policyQuestions(spec, hazards);
  const topLevel = spec.severity.levels.length - 1;
  const route = makeRouter(spec, hazards);

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
      const answers = result.answers as Readonly<Record<string, unknown>>;
      const probabilities = Object.fromEntries(hazards.map((hazard) => [hazard, (answers[`hazard_${hazard}`] as NoulResponse).noul])) as Record<H, number>;
      const { score: level, confidence } = answers['severity'] as ScoreResponse;
      const severity = { score: level, confidence };
      const action = route(probabilities, level, policy);
      recordReadings(port, result, { action, policy, hazards: probabilities, severity, severityNormalized: level / topLevel });
      return { action, hazards: probabilities, severity, policy, decisionId: result.decisionId, recordAction: (a) => recordAction(port, result.decisionId, a) };
    },
    async checkFixtures(port, options = {}) {
      const checks: FixtureCheck[] = [];
      for (const fixture of spec.fixtures) {
        const policyOption = fixture.policy === undefined ? {} : { policy: fixture.policy };
        const got = await checklist.screen(port, fixture.state, { ...options, ...policyOption, site: 'calibration' });
        checks.push(actionCheck(fixture, got as PolicyResult<string, string>));
      }
      return checks;
    },
  };
  return checklist;
}
