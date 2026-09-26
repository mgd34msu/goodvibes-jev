import { checkEachFixture, decisionHeader, fixtureCheck, type DecisionIdentity, type FixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { makeRouter, policyNamed, validateRouting, type PolicyAction, type PolicyRouting, type PolicyRoutingSpec } from './policy-routing.ts';
import type { EntryType, JudgmentPort } from '../port/types.ts';
import { policyQuestions, readScreening, type PolicyQuestionsSpec } from './policy-questions.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/**
 * Policy checklist (guardrails for LLMs): the questions in policy-questions.ts
 * ride one request, and a named policy turns the answers into one action in
 * code (makeRouter). The probabilities never change with the policy; only the
 * decision does.
 */
export interface PolicySpec<H extends string, A extends string> extends PatternHeader, PolicyQuestionsSpec<H, A>, PolicyRoutingSpec<A> {
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

/** The action each hazard triggers, with the rest of the routing the spec states. */
function routingOf<H extends string, A extends string>(spec: PolicySpec<H, A>, hazards: readonly H[]): PolicyRouting<H, A> {
  return { ...spec, hazardActions: Object.fromEntries(hazards.map((hazard) => [hazard, spec.hazards[hazard].action])) as Record<H, A> };
}

function validatePolicySpec<H extends string, A extends string>(spec: PolicySpec<H, A>, routing: PolicyRouting<H, A>): DecisionIdentity {
  const header = decisionHeader(spec);
  if (Object.keys(spec.hazards).length === 0) throw new RangeError(`policy ${spec.name}: needs at least one hazard`);
  const actions = validateRouting(routing);
  for (const fixture of spec.fixtures) {
    if (!actions.has(fixture.expect)) throw new RangeError(`policy ${spec.name}: fixture ${fixture.name} expects unknown action`);
    if (fixture.policy !== undefined) policyNamed(routing, fixture.policy);
  }
  return header;
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
  const routing = routingOf(spec, hazards);
  const header = validatePolicySpec(spec, routing);
  const questions = policyQuestions(spec, hazards);
  const topLevel = spec.severity.levels.length - 1;
  const route = makeRouter(routing);

  const checklist: PolicyChecklist<H, A> = {
    ...header,
    route,
    async screen(port, state, options = {}) {
      const policy = options.policy ?? spec.defaultPolicy;
      const result = await askAs(port, spec, 'policy', state, questions, options);
      const { probabilities, severity } = readScreening(result.answers, hazards);
      const action = route(probabilities, severity.score, policy);
      recordReadings(port, result, { action, policy, hazards: probabilities, severity, severityNormalized: severity.score / topLevel });
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
