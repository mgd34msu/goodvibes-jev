import { checkEachFixture, decisionHeader, fixtureCheck, type DecisionIdentity, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { isNonDecreasing } from '../readings/bands.ts';
import { noul, score, type EntryType, type JudgmentPort, type NoulResponse, type Question, type ScoreCriteria, type ScoreResponse } from '../port/types.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/** An action a hazard can trigger on its own: its action or a review. */
type Triggered<A extends string> = A | 'review';
/** What a screening decides: a triggered action, or pass when nothing triggered. */
export type PolicyAction<A extends string> = Triggered<A> | 'pass';

/** One named policy: the hazard probability that sends a case to review, the one that triggers the hazard's action, and the severity level that hardens a review. */
export interface PolicyThresholds {
  readonly review: number;
  readonly action: number;
  readonly severityLine: number;
}

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
  readonly precedence: readonly PolicyAction<A>[];
  /** The action a review becomes when severity crosses the line. */
  readonly severityAction: A;
  readonly policies: Readonly<Record<string, PolicyThresholds>>;
  readonly defaultPolicy: string;
  readonly fixtures: readonly {
    readonly name: string;
    readonly state: EntryType;
    readonly policy?: string;
    readonly expect: PolicyAction<A>;
  }[];
}

export interface PolicyResult<H extends string, A extends string> {
  readonly action: PolicyAction<A>;
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
  route(hazards: Readonly<Record<H, number>>, severity: number, policy: string): PolicyAction<A>;
}

/** The answers a screening request returns: the severity score and one yes/no per hazard. */
type PolicyAnswers = { readonly severity: ScoreResponse } & { readonly [hazard: `hazard_${string}`]: NoulResponse };

const thresholdsOrdered = (review: number, action: number): boolean => isNonDecreasing([0, review, action, 1]);
const namesKnownPolicy = (policy: string | undefined, policies: Readonly<Record<string, unknown>>): boolean => policy === undefined || policy in policies;

function validatePolicySpec<H extends string, A extends string>(spec: PolicySpec<H, A>, hazards: readonly H[]): DecisionIdentity {
  const header = decisionHeader(spec);
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
  return header;
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
  policy: PolicyThresholds,
): Triggered<A>[] {
  return hazards.flatMap((hazard): Triggered<A>[] => {
    const p = probabilities[hazard];
    if (p >= policy.action) return [spec.hazards[hazard].action];
    return p >= policy.review ? ['review'] : [];
  });
}

function makeRouter<H extends string, A extends string>(spec: PolicySpec<H, A>, hazards: readonly H[]) {
  return (probabilities: Readonly<Record<H, number>>, severity: number, policyName: string): PolicyAction<A> => {
    const policy = spec.policies[policyName];
    if (policy === undefined) throw new RangeError(`policy ${spec.name}: unknown policy "${policyName}"`);
    const severe = severity >= policy.severityLine;
    const triggered = triggeredActions(spec, hazards, probabilities, policy).map((action) => (severe && action === 'review' ? spec.severityAction : action));
    return spec.precedence.find((action) => triggered.includes(action as Triggered<A>)) ?? 'pass';
  };
}

function actionCheck(fixture: { readonly name: string; readonly expect: string }, got: PolicyResult<string, string>): FixtureCheck {
  const strongest = Math.max(...Object.values<number>(got.hazards));
  const signal = got.action === 'pass' ? 1 - strongest : strongest;
  return fixtureCheck(fixture.name, 'action', fixture.expect, got.action, signal, got.action === 'review' ? 'escalate' : 'act');
}

export function definePolicyChecklist<const H extends string, const A extends string>(
  spec: PolicySpec<H, A>,
): PolicyChecklist<H, A> {
  const hazards = Object.keys(spec.hazards) as H[];
  const header = validatePolicySpec(spec, hazards);
  const questions = policyQuestions(spec, hazards);
  const topLevel = spec.severity.levels.length - 1;
  const route = makeRouter(spec, hazards);

  const checklist: PolicyChecklist<H, A> = {
    ...header,
    route,
    async screen(port, state, options = {}) {
      const policy = options.policy ?? spec.defaultPolicy;
      const result = await askAs(port, spec, 'policy', state, questions, options);
      const answers = result.answers as PolicyAnswers;
      const probabilities = Object.fromEntries(hazards.map((hazard) => [hazard, answers[`hazard_${hazard}`]!.noul])) as Record<H, number>;
      const { score: level, confidence } = answers.severity;
      const severity = { score: level, confidence };
      const action = route(probabilities, level, policy);
      recordReadings(port, result, { action, policy, hazards: probabilities, severity, severityNormalized: level / topLevel });
      return { action, hazards: probabilities, severity, policy, decisionId: result.decisionId, recordAction: (a) => recordAction(port, result.decisionId, a) };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const policyOption = fixture.policy === undefined ? {} : { policy: fixture.policy };
        return actionCheck(fixture, (await checklist.screen(port, fixture.state, { ...run, ...policyOption })) as PolicyResult<string, string>);
      }),
  };
  return checklist;
}
