import { checkEachFixture, decisionHeader, fixtureCheck, type NamedDecision } from '../batteries/decision.ts';
import { noul, type EntryType, type JudgmentPort } from '../port/types.ts';
import { askAs, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/** One rung: when question `ask` is above (or below) `at`, the item takes `route`. */
export interface Rung<Q extends string, R extends string> {
  readonly ask: Q;
  readonly when: 'above' | 'below';
  readonly at: number;
  readonly route: R;
}

/**
 * A rule ladder over yes/no readings (the classifying RAG passages
 * cookbook): several Nouls about one state in one request, then fixed rules
 * tested in order, first match wins, with a route when none match. Order
 * carries meaning: a security rung goes first so nothing below it can
 * outvote it. The numbers live in the rungs, so a change of policy is a
 * reviewed edit of a constant, not a reworded question.
 */
export interface LadderSpec<Q extends string, R extends string> extends PatternHeader {
  readonly questions: Readonly<Record<Q, { readonly instructions: EntryType; readonly yes?: EntryType; readonly no?: EntryType }>>;
  readonly rungs: readonly Rung<NoInfer<Q>, R>[];
  readonly otherwise: NoInfer<R>;
  readonly fixtures: readonly { readonly name: string; readonly state: EntryType; readonly expect: NoInfer<R> }[];
}

export interface Laddered<Q extends string, R extends string> {
  readonly route: R;
  /** The rung that matched, or undefined when `otherwise` applied. */
  readonly rung: number | undefined;
  readonly probabilities: Readonly<Record<Q, number>>;
}

export interface RuleLadder<Q extends string, R extends string> extends NamedDecision {
  route(port: JudgmentPort, state: EntryType, options?: CallOptions): Promise<Laddered<Q, R>>;
  /** Re-routes stored probabilities without asking again. */
  climb(probabilities: Readonly<Record<Q, number>>): { readonly route: R; readonly rung: number | undefined };
}

function matches(probability: number, rung: Rung<string, string>): boolean {
  return rung.when === 'above' ? probability > rung.at : probability < rung.at;
}

export function defineRuleLadder<const Q extends string, const R extends string>(spec: LadderSpec<Q, R>): RuleLadder<Q, R> {
  const header = decisionHeader(spec);
  const names = Object.keys(spec.questions) as Q[];
  for (const rung of spec.rungs) {
    if (!names.includes(rung.ask)) throw new RangeError(`ladder ${spec.name}: a rung asks unknown question "${rung.ask}"`);
    if (!(rung.at >= 0 && rung.at <= 1)) throw new RangeError(`ladder ${spec.name}: rung thresholds must be in [0, 1]`);
  }
  const questions = Object.fromEntries(
    names.map((name) => {
      const { instructions, yes, no } = spec.questions[name];
      const criteria = yes === undefined && no === undefined ? undefined : { ...(yes === undefined ? {} : { true: yes }), ...(no === undefined ? {} : { false: no }) };
      return [name, noul(instructions, criteria)];
    }),
  );

  const climb = (probabilities: Readonly<Record<Q, number>>) => {
    const index = spec.rungs.findIndex((rung) => matches(probabilities[rung.ask], rung));
    return index < 0 ? { route: spec.otherwise, rung: undefined } : { route: spec.rungs[index]!.route, rung: index };
  };

  const ladder: RuleLadder<Q, R> = {
    ...header,
    climb,
    async route(port, state, options = {}) {
      const result = await askAs(port, spec, 'ladder', state, questions, options);
      const answers = result.answers as Record<string, { type: 'noul'; noul: number }>;
      const probabilities = Object.fromEntries(names.map((name) => [name, answers[name]!.noul])) as Record<Q, number>;
      const { route, rung } = climb(probabilities);
      recordReadings(port, result, { route, rung: rung ?? null, probabilities });
      return { route, rung, probabilities };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const got = await ladder.route(port, fixture.state, run);
        const deciding = got.rung === undefined ? undefined : spec.rungs[got.rung]!;
        const p = deciding === undefined ? 1 : got.probabilities[deciding.ask];
        return fixtureCheck(fixture.name, 'route', fixture.expect, got.route, deciding?.when === 'below' ? 1 - p : p, 'act');
      }),
  };
  return ladder;
}
