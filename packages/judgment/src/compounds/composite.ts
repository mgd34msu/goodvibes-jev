import { defineBattery, rated, type Battery, type ScoreItem } from '../batteries/battery.ts';
import type { NamedDecision } from '../batteries/decision.ts';
import type { EntryType, JudgmentPort, ScoreCriteria } from '../port/types.ts';
import type { ConfidenceBand } from '../readings/bands.ts';
import type { ScoreReading } from '../readings/readings.ts';
import type { CallOptions, PatternHeader } from '../batteries/asking.ts';

/**
 * Composite scoring: a judgment that depends on several things is split into
 * one Score per dimension, asked together, normalized to 0-1 and combined
 * with weights held in code. Each profile is a set of weights over the same
 * dimensions, so one request serves several rankings, and changing a
 * priority is a weight edit rather than a reworded question.
 */
export interface CompositeSpec<D extends string, P extends string> extends PatternHeader {
  readonly dimensions: Readonly<Record<D, { readonly instructions: EntryType; readonly levels: ScoreCriteria; readonly band: ConfidenceBand }>>;
  readonly profiles: Readonly<Record<P, Readonly<Record<NoInfer<D>, number>>>>;
  readonly fixtures: readonly {
    readonly name: string;
    readonly state: EntryType;
    /** The level each dimension should land on. */
    readonly expect: Readonly<Partial<Record<NoInfer<D>, number>>>;
  }[];
}

export interface CompositeResult<D extends string, P extends string> {
  readonly dimensions: Readonly<Record<D, ScoreReading>>;
  /** Weighted mean of normalized dimension scores, per profile, in [0, 1]. */
  readonly composites: Readonly<Record<P, number>>;
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

export interface CompositeScore<D extends string, P extends string> extends NamedDecision {
  score(port: JudgmentPort, state: EntryType, options?: CallOptions): Promise<CompositeResult<D, P>>;
}

export function defineCompositeScore<const D extends string, const P extends string>(
  spec: CompositeSpec<D, P>,
): CompositeScore<D, P> {
  const dimensionNames = Object.keys(spec.dimensions) as D[];
  const totalWeight = (weights: Readonly<Record<D, number>>): number => dimensionNames.reduce((sum, dimension) => sum + weights[dimension], 0);
  for (const [profile, weights] of Object.entries(spec.profiles) as [P, Readonly<Record<D, number>>][]) {
    const negative = dimensionNames.find((dimension) => !(weights[dimension] >= 0));
    if (negative !== undefined) throw new RangeError(`composite ${spec.name}: profile ${profile} needs a weight of 0 or more for ${negative}`);
    if (!(totalWeight(weights) > 0)) throw new RangeError(`composite ${spec.name}: profile ${profile} has no positive weight`);
  }
  const items = Object.fromEntries(
    dimensionNames.map((dimension) => {
      const { instructions, levels, band } = spec.dimensions[dimension];
      return [dimension, rated(instructions, levels, band)];
    }),
  ) as Record<D, ScoreItem<ScoreCriteria>>;
  const battery: Battery<Record<D, ScoreItem<ScoreCriteria>>> = defineBattery({
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    items,
    fixtures: spec.fixtures as never,
  });

  return {
    name: spec.name,
    version: spec.version,
    description: spec.description,
    accuracyFloor: spec.accuracyFloor,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    fixtureCount: battery.fixtureCount,
    checkFixtures: (port, options) => battery.checkFixtures(port, options),
    async score(port, state, options = {}) {
      const run = await battery.run(port, state, { pattern: 'composite', ...options });
      const dimensions = run.readings as unknown as Record<D, ScoreReading>;
      const composites = Object.fromEntries(
        (Object.entries(spec.profiles) as [P, Readonly<Record<D, number>>][]).map(([profile, weights]) => {
          const weighted = dimensionNames.reduce((sum, dimension) => sum + weights[dimension] * dimensions[dimension].normalized, 0);
          return [profile, weighted / totalWeight(weights)];
        }),
      ) as Record<P, number>;
      return { dimensions, composites, decisionId: run.result.decisionId, recordAction: (action) => run.recordAction(action) };
    },
  };
}
