/** Typed, fail-closed composition of the engine-owned model-readiness batteries. */
import type { BatteryItems, BatteryRun, ConfidenceBand, ScoreReading, YesNoReading } from '@goodvibes-jev/judgment';
import { localRecipeFit, routeReadiness } from './batteries/model-readiness.js';

export type ModelReadinessOutcome = 'ready' | 'held' | 'rejected' | 'deferred' | 'unavailable';
export type ModelReadinessHeldOutcome = Exclude<ModelReadinessOutcome, 'ready'>;
export type RouteReadinessLevel = typeof routeReadiness.composite.levels[number]['level'];
export type LocalRecipeFitLevel = typeof localRecipeFit.composite.levels[number]['level'];
export type LocalRecipeMemoryTier = typeof localRecipeFit.composite.memoryTiers[number];
export type RouteReadinessDimensionId = typeof routeReadiness.composite.dimensions[number]['id'];
export type ModelReadinessFlag = 'cloudTransfer' | 'exampleVision';

/** Allows subset battery runs without pretending omitted questions have readings. */
export type ModelReadinessRun<Items extends BatteryItems> = Pick<BatteryRun<Items>, 'result'> & {
  readonly readings: Partial<BatteryRun<Items>['readings']>;
};

/** An explicit non-answer; callers can preserve lifecycle outcomes without making up a score. */
export interface ModelReadinessNonAnswer {
  readonly outcome: ModelReadinessHeldOutcome;
  readonly decisionId?: string;
  readonly reason?: string;
}
export type RouteReadinessInput = ModelReadinessRun<typeof routeReadiness.items> | ModelReadinessNonAnswer | null | undefined;
export type LocalRecipeFitInput = ModelReadinessRun<typeof localRecipeFit.items> | ModelReadinessNonAnswer | null | undefined;
type ReadinessInput = RouteReadinessInput | LocalRecipeFitInput;

export interface ModelReadinessProvenance {
  readonly battery: string;
  readonly version: number;
  readonly decisionId: string | null;
  readonly requestedModel: string | null;
  readonly model: string | null;
  readonly requestId: string | null;
}

export interface ModelReadinessScoreReading {
  /** Display score in [0, 100]. Unknown or non-acting readings never become zero. */
  readonly score: number | null;
  readonly normalized: number | null;
  readonly confidence: number | null;
  readonly outcome: ModelReadinessOutcome;
  readonly reason: string | null;
}

export interface RouteReadinessDimension extends ModelReadinessScoreReading {
  readonly id: RouteReadinessDimensionId;
  readonly label: string;
  readonly weight: number;
}

export interface ModelReadinessFlagReading {
  readonly value: boolean | null;
  readonly probability: number | null;
  readonly confidence: number | null;
  readonly outcome: ModelReadinessOutcome;
  readonly reason: string | null;
  readonly decisionId: string | null;
  readonly provenance: ModelReadinessProvenance;
}

export interface RouteReadinessReading extends ModelReadinessScoreReading {
  readonly level: RouteReadinessLevel | null;
  readonly dimensions: readonly RouteReadinessDimension[];
  readonly cloudTransfer: ModelReadinessFlagReading;
  readonly decisionId: string | null;
  readonly provenance: ModelReadinessProvenance;
}

export interface LocalRecipeFitReading extends ModelReadinessScoreReading {
  readonly level: LocalRecipeFitLevel | null;
  readonly fit: ModelReadinessScoreReading;
  readonly memoryAdequacy: ModelReadinessScoreReading;
  readonly memoryTier: LocalRecipeMemoryTier | null;
  readonly decisionId: string | null;
  readonly provenance: ModelReadinessProvenance;
}

const unit = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;
const runFor = (input: ReadinessInput) => input != null && 'readings' in input ? input : undefined;
const absentOutcome = (input: ReadinessInput): ModelReadinessHeldOutcome => input == null ? 'unavailable' : 'outcome' in input ? input.outcome : 'held';
const absentReason = (input: ReadinessInput): string => input != null && 'reason' in input && input.reason !== undefined ? input.reason : input == null ? 'No judgment run is available.' : 'A required judgment reading is missing.';

function provenanceFor(input: ReadinessInput, battery: { readonly name: string; readonly version: number }): ModelReadinessProvenance {
  const result = runFor(input)?.result;
  return {
    battery: battery.name,
    version: battery.version,
    decisionId: result?.decisionId ?? (input != null && 'decisionId' in input ? input.decisionId : undefined) ?? null,
    requestedModel: result?.requestedModel ?? null,
    model: result?.model ?? null,
    requestId: result?.requestId ?? null,
  };
}

function emptyScore(outcome: ModelReadinessHeldOutcome, reason: string, confidence: number | null = null): ModelReadinessScoreReading {
  return { score: null, normalized: null, confidence, outcome, reason };
}

function scoreFrom(reading: ScoreReading | undefined, band: ConfidenceBand, levels: number, input: ReadinessInput): ModelReadinessScoreReading {
  if (!reading) return emptyScore(absentOutcome(input), absentReason(input));
  const confidence = unit(reading.confidence) ? reading.confidence : null;
  const top = levels - 1;
  const valid = reading.kind === 'score' && top > 0 && unit(reading.normalized)
    && Number.isFinite(reading.score) && reading.score >= 0 && reading.score <= top
    && Math.abs(reading.score / top - reading.normalized) <= Number.EPSILON * 4
    && reading.level === Math.round(reading.score)
    && Array.isArray(reading.probabilities) && reading.probabilities.length === levels && reading.probabilities.every(unit)
    && Math.abs(reading.probabilities.reduce((sum, p) => sum + p, 0) - 1) <= Number.EPSILON * levels * 4;
  if (!valid || confidence === null) return emptyScore('held', 'The judgment reading is invalid.', confidence);
  if (reading.outcome !== 'act' || band.actAt === null || confidence < band.actAt) {
    return emptyScore('held', 'The judgment reading does not clear its acting-confidence band.', confidence);
  }
  return { score: Math.round(reading.normalized * 100), normalized: reading.normalized, confidence, outcome: 'ready', reason: null };
}

/** A cloud-transfer or single-example vision flag, preserving uncertainty and run provenance. */
export function modelReadinessFlagFrom(input: RouteReadinessInput, flag: ModelReadinessFlag): ModelReadinessFlagReading {
  const run = input != null && 'readings' in input ? input : undefined;
  const reading: YesNoReading | undefined = run?.readings[flag];
  const provenance = provenanceFor(input, routeReadiness);
  const probability = reading && unit(reading.probability) ? reading.probability : null;
  const confidence = probability === null ? null : Math.max(probability, 1 - probability);
  let outcome: ModelReadinessOutcome = absentOutcome(input);
  let reason: string | null = absentReason(input);
  let value: boolean | null = null;
  if (reading) {
    const side = reading.verdict === 'yes' ? 'yes' : reading.verdict === 'no' ? 'no' : null;
    const actingBand = side === null ? null : routeReadiness.items[flag].band[side].actAt;
    const sideConfidence = probability === null || side === null ? null : side === 'yes' ? probability : 1 - probability;
    if (reading.kind === 'yes-no' && reading.outcome === 'act' && side !== null && actingBand !== null
      && sideConfidence !== null && sideConfidence >= actingBand) {
      outcome = 'ready';
      reason = null;
      value = side === 'yes';
    } else {
      outcome = 'held';
      reason = 'The judgment flag does not clear its acting-confidence band.';
    }
  }
  return { value, probability, confidence, outcome, reason, decisionId: provenance.decisionId, provenance };
}

const jointConfidence = (readings: readonly { readonly confidence: number | null }[]): number | null =>
  readings.every((reading) => reading.confidence !== null) ? Math.min(...readings.map((reading) => reading.confidence!)) : null;

/**
 * Composes all six settled dimensions using only the battery's published weights.
 * Cloud-transfer uncertainty holds privacy and the aggregate; unrelated example
 * questions are composed separately, once per example. This does not grant any
 * routing, installation, data-sharing or default-model mutation authority.
 */
export function routeReadinessFrom(input: RouteReadinessInput): RouteReadinessReading {
  const run = input != null && 'readings' in input ? input : undefined;
  const provenance = provenanceFor(input, routeReadiness);
  const cloudTransfer = modelReadinessFlagFrom(input, 'cloudTransfer');
  const dimensions = routeReadiness.composite.dimensions.map((dimension): RouteReadinessDimension => {
    const item = routeReadiness.items[dimension.reading];
    let reading = scoreFrom(run?.readings[dimension.reading], item.band, item.question.criteria.length, input);
    if (dimension.id === 'privacy' && cloudTransfer.outcome !== 'ready') {
      reading = emptyScore(cloudTransfer.outcome, 'Cloud-transfer judgment is unsettled.', reading.confidence);
    }
    return { id: dimension.id, label: dimension.label, weight: dimension.weight, ...reading };
  });
  const confidence = jointConfidence([...dimensions, cloudTransfer]);
  const unsettled = dimensions.find((dimension) => dimension.outcome !== 'ready');
  const normalized = unsettled ? null : dimensions.reduce((sum, dimension) => sum + dimension.weight * dimension.normalized!, 0)
    / routeReadiness.composite.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  return {
    score: normalized === null ? null : Math.round(normalized * 100),
    normalized,
    level: normalized === null ? null : routeReadiness.composite.levels.find((entry) => normalized >= entry.at)!.level,
    confidence,
    outcome: unsettled?.outcome ?? 'ready',
    reason: unsettled?.reason ?? null,
    dimensions,
    cloudTransfer,
    decisionId: provenance.decisionId,
    provenance,
  };
}

/** Fit and memory adequacy must both settle; hardware facts alone never produce a tier. */
export function localRecipeFitFrom(input: LocalRecipeFitInput): LocalRecipeFitReading {
  const run = input != null && 'readings' in input ? input : undefined;
  const provenance = provenanceFor(input, localRecipeFit);
  const fit = scoreFrom(run?.readings.fit, localRecipeFit.items.fit.band, localRecipeFit.items.fit.question.criteria.length, input);
  const memoryAdequacy = scoreFrom(run?.readings.memoryAdequacy, localRecipeFit.items.memoryAdequacy.band, localRecipeFit.items.memoryAdequacy.question.criteria.length, input);
  const unsettled = [fit, memoryAdequacy].find((reading) => reading.outcome !== 'ready');
  const normalized = unsettled ? null : fit.normalized;
  return {
    score: normalized === null ? null : Math.round(normalized * 100),
    normalized,
    level: normalized === null ? null : localRecipeFit.composite.levels.find((entry) => normalized >= entry.at)!.level,
    confidence: jointConfidence([fit, memoryAdequacy]),
    outcome: unsettled?.outcome ?? 'ready',
    reason: unsettled?.reason ?? null,
    fit,
    memoryAdequacy,
    memoryTier: unsettled ? null : localRecipeFit.composite.memoryTiers[run!.readings.memoryAdequacy!.level] ?? null,
    decisionId: provenance.decisionId,
    provenance,
  };
}
