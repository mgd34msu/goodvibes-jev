/**
 * Reads a piece of work before any model token is spent on it: the six
 * request batteries asked in one request (speculative fan-out), then the tier
 * composed in code from the readings and the policy floors.
 */
import { fanOut, type ChoiceReading, type ScoreReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { REQUEST_BATTERIES, type RequestDomain, type RequestIntent, type RequestLanguage } from './batteries/request.js';
import {
  TIER_FLOOR_FOR_PURPOSE,
  TIER_FLOOR_FOR_RISK,
  TIER_FLOOR_FOR_UNSURE_NON_ENGLISH,
  TIER_FOR_DIFFICULTY,
} from './policy.js';
import { higherTier, type RouteTier } from './tiers.js';

/** A piece of work to route: who does it and the brief as written. */
export interface RoutingRequest {
  /** Who does the work: 'planner', 'unit', 'fresh-unit', 'integration', 'conversation', or another short label. */
  readonly purpose: string;
  readonly brief: string;
  /** Complete immutable requirements for native work, separate from the bounded display/derived brief. */
  readonly originalSource?: { readonly goal: string; readonly criteria: readonly string[] } | undefined;
}

export interface RequestReading {
  /** The tier the work needs, composed from the readings and the policy floors. */
  readonly tier: RouteTier;
  /** How the tier was composed, one clause per step, for the route's reason string. */
  readonly tierBecause: string;
  readonly readings: {
    readonly tier: ChoiceReading<RouteTier>;
    readonly intent: ChoiceReading<RequestIntent>;
    readonly difficulty: ScoreReading;
    readonly risk: ScoreReading;
    readonly domain: ChoiceReading<RequestDomain>;
    readonly language: ChoiceReading<RequestLanguage>;
  };
  readonly decisionId: string | undefined;
  recordAction(action: string): void;
}

/** Long briefs say what the work is in their opening; the rest is detail the readings do not need. */
const MAX_BRIEF_CHARS = 6_000;

/** The state every request battery reads. */
export function requestState(request: RoutingRequest): { purpose: string; work: string; originalSource?: { goal: string; criteria: string[] } } {
  return { purpose: request.purpose, work: request.brief.slice(0, MAX_BRIEF_CHARS),
    ...(request.originalSource === undefined ? {} : { originalSource: { goal: request.originalSource.goal, criteria: [...request.originalSource.criteria] } }),
  };
}

const pct = (value: number): string => value.toFixed(2);

/**
 * The tier from the readings: the tier reading when it is strong enough to
 * act or confirm on, else the tier the difficulty level asks for; then raised
 * to the risk floor, the purpose floor and, for an unsure non-English
 * request, the language floor.
 */
export function composeTier(
  readings: RequestReading['readings'],
  purpose: string,
): { readonly tier: RouteTier; readonly because: string } {
  const clauses: string[] = [];
  const tierRead = readings.tier.outcome !== 'escalate';
  let tier: RouteTier;
  if (tierRead) {
    tier = readings.tier.choice;
    clauses.push(`tier read ${tier} (${pct(readings.tier.confidence)})`);
  } else {
    tier = TIER_FOR_DIFFICULTY[readings.difficulty.level]!;
    clauses.push(`tier reading unsure (${readings.tier.choice} ${pct(readings.tier.confidence)}), difficulty ${readings.difficulty.score.toFixed(1)}/3 asks ${tier}`);
  }
  const raise = (floor: RouteTier | undefined, why: string): void => {
    if (floor === undefined) return;
    const next = higherTier(tier, floor);
    if (next !== tier) clauses.push(`${why} raises it to ${next}`);
    tier = next;
  };
  if (readings.risk.outcome !== 'escalate') raise(TIER_FLOOR_FOR_RISK[readings.risk.level], `risk ${readings.risk.score.toFixed(1)}/3`);
  raise(TIER_FLOOR_FOR_PURPOSE[purpose], `purpose ${purpose}`);
  const nonEnglish = readings.language.outcome !== 'escalate' && readings.language.choice !== 'english';
  if (nonEnglish && readings.tier.outcome !== 'act') raise(TIER_FLOOR_FOR_UNSURE_NON_ENGLISH, `${readings.language.choice} request with an unsure tier reading`);
  return { tier, because: clauses.join('; ') };
}

/** Reads the work with every request battery in one request and composes its tier. */
export async function readRequest(
  request: RoutingRequest,
  options: import('@goodvibes-jev/judgment').CallOptions = {},
): Promise<RequestReading> {
  const site = options.site ?? 'routing.request';
  const run = await fanOut(judgmentPort(site), requestState(request), REQUEST_BATTERIES, {
    site,
    label: 'routing.request',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.beforeAttempt === undefined ? {} : { beforeAttempt: options.beforeAttempt }),
    ...(options.onRetry === undefined ? {} : { onRetry: options.onRetry }),
  });
  const readings = {
    tier: run.readings.tier.tier,
    intent: run.readings.intent.intent,
    difficulty: run.readings.difficulty.difficulty,
    risk: run.readings.risk.risk,
    domain: run.readings.domain.domain,
    language: run.readings.language.language,
  };
  const { tier, because } = composeTier(readings, request.purpose);
  return { tier, tierBecause: because, readings, decisionId: run.decisionId, recordAction: run.recordAction };
}
