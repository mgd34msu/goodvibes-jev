import { checkEachFixture, decisionHeader, type NamedDecision } from '../batteries/decision.ts';
import { checkReading } from '../batteries/battery.ts';
import { choice, type EntryType, type JudgmentPort } from '../port/types.ts';
import { assertBand, type ChoiceBand } from '../readings/bands.ts';
import { readChoice, type ChoiceReading } from '../readings/readings.ts';
import { askAs, recordAction, recordReadings, type CallOptions, type PatternHeader } from '../batteries/asking.ts';

/**
 * Routing: dispatch over a closed set of handlers (intent routing and
 * confidence-gated routing in the Jev docs). One Choice picks the handler;
 * the band decides whether code may route there on its own.
 */
export interface DispatchSpec<R extends string> extends PatternHeader {
  /** The question, e.g. "Which handler should take this request?". */
  readonly instructions: EntryType;
  /** Every handler, with a description that separates it from the others. */
  readonly routes: Readonly<Record<R, EntryType>>;
  /** Confidence floors, with stricter bands for routes with higher stakes. */
  readonly band: ChoiceBand<NoInfer<R>>;
  readonly fixtures: readonly { readonly name: string; readonly state: EntryType; readonly expect: NoInfer<R> }[];
}

export interface Dispatched<R extends string> {
  readonly route: R;
  readonly reading: ChoiceReading<R>;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface Dispatch<R extends string> extends NamedDecision {
  readonly routes: readonly R[];
  route(port: JudgmentPort, state: EntryType, options?: CallOptions): Promise<Dispatched<R>>;
}

export function defineDispatch<const R extends string>(spec: DispatchSpec<R>): Dispatch<R> {
  const header = decisionHeader(spec);
  assertBand(spec.band);
  const routes = Object.keys(spec.routes) as R[];
  for (const fixture of spec.fixtures) {
    if (!routes.includes(fixture.expect)) {
      throw new RangeError(`dispatch ${spec.name}: fixture ${fixture.name} expects unknown route "${fixture.expect}"`);
    }
  }
  const question = choice(spec.instructions, spec.routes as Readonly<Record<string, EntryType>>);

  const dispatch: Dispatch<R> = {
    ...header,
    routes,
    async route(port, state, options = {}) {
      const result = await askAs(port, spec, 'dispatch', state, { route: question }, options);
      const reading = readChoice(result.answers.route, spec.band as ChoiceBand) as ChoiceReading<R>;
      recordReadings(port, result, { route: reading });
      return {
        route: reading.choice,
        reading,
        decisionId: result.decisionId,
        recordAction: (action) => recordAction(port, result.decisionId, action),
      };
    },
    checkFixtures: (port, options = {}) =>
      checkEachFixture(spec.fixtures, options, async (fixture, run) => {
        const { reading } = await dispatch.route(port, fixture.state, run);
        return checkReading(fixture.name, 'route', fixture.expect, reading);
      }),
  };
  return dispatch;
}
