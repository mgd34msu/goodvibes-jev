/**
 * The route planner: given a piece of work, picks the model that does it from
 * the whole catalog, cross-checked with the accounts that are configured and
 * the providers that are healthy.
 *
 *   1. Read the work (request batteries, one request) and compose its tier.
 *   2. Keep the catalog models the configured, healthy providers serve that
 *      meet the work's hard requirements (tool calling, context, image input).
 *   3. For the wanted tier (then higher, then lower tiers when none fits),
 *      order the candidates by published facts, read the tier of a bounded
 *      shortlist (remembered per model) and keep the ones in that tier.
 *   4. Choose among them with routing.model-choice; the other fitting
 *      candidates become the failover routes.
 *
 * No rule names a vendor or a model: every judgment is about the work and
 * the model's published facts.
 */
import { NONE, type Candidate, type Selection } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { ModelDefinition } from '../providers/registry-types.js';
import type { ResolvedModelPricing } from '../providers/model-pricing.js';
import type { ProviderStatus } from '../runtime/store/domains/provider-health.js';
import { modelChoice } from './batteries/model.js';
import { modelFactsState, type ModelFacts, type ModelTierStore } from './model-tiers.js';
import { CHOICE_SHORTLIST, FALLBACK_ROUTES, TIER_READ_ROUNDS, TIER_READ_SHORTLIST } from './policy.js';
import { readRequest, type RequestReading, type RoutingRequest } from './request-reading.js';
import { tierSearchOrder, type RouteTier } from './tiers.js';

/** What the planner reads from the provider registry. */
export interface RoutePlannerCatalog {
  listModels(): readonly ModelDefinition[];
  getConfiguredProviderIds(): readonly string[];
  getContextWindowForModel(model: ModelDefinition): number;
  resolveModelPricing(modelRef: string, providerId?: string): ResolvedModelPricing;
}

export interface RoutePlannerDeps {
  readonly catalog: RoutePlannerCatalog;
  readonly tiers: ModelTierStore;
  /** Current provider health by provider id; providers that are unavailable or rejecting credentials are skipped. */
  readonly providerHealth?: (() => ReadonlyMap<string, { readonly status: ProviderStatus }>) | undefined;
  /** Published benchmark composite (0 to 1) for a model, when one is known. */
  readonly benchmarkFor?: ((model: ModelDefinition) => number | null | undefined) | undefined;
}

/** Hard requirements the work puts on a model: facts, checked in code. */
export interface RouteRequirements {
  /** The model must call tools; true for agent work. Default true. */
  readonly toolCalling?: boolean | undefined;
  /** The model must read images. */
  readonly imageInput?: boolean | undefined;
  /** The smallest context window that fits the work. */
  readonly minContextTokens?: number | undefined;
}

export interface RoutePlanRequest extends RoutingRequest {
  readonly requires?: RouteRequirements | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PlannedRoute {
  /** The chosen model's registry key, `provider:model`. */
  readonly model: string;
  readonly provider: string;
  readonly modelId: string;
  /** Other fitting models of the same tier, best first, as registry keys: the failover chain. */
  readonly fallbackModels: readonly string[];
  /** The tier the work needs. */
  readonly tier: RouteTier;
  /** The tier the chosen model belongs to; differs from `tier` only when no fitting model of that tier was available. */
  readonly chosenTier: RouteTier;
  /** The tier and the choice, in words, for the unit's route reason. */
  readonly reason: string;
  readonly request: RequestReading;
  readonly pick: Selection;
}

export class NoRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoRouteError';
  }
}

export interface RoutePlanner {
  /** Reads the work and picks its model route from the whole catalog. */
  planRoute(request: RoutePlanRequest): Promise<PlannedRoute>;
}

const UNUSABLE: ReadonlySet<ProviderStatus> = new Set(['unavailable', 'auth_error']);

function priceOf(catalog: RoutePlannerCatalog, model: ModelDefinition): ModelFacts['price'] {
  const resolved = catalog.resolveModelPricing(model.registryKey, model.provider);
  if (resolved.status === 'priced') return { input: resolved.rates.inputPerMTok, output: resolved.rates.outputPerMTok };
  if (resolved.status === 'subscription') return 'subscription';
  return model.tier === 'free' ? 'free' : 'unpriced';
}

/** The published facts routing reads about one registry model. */
export function factsFor(deps: Pick<RoutePlannerDeps, 'catalog' | 'benchmarkFor'>, model: ModelDefinition): ModelFacts {
  return {
    registryKey: model.registryKey,
    id: model.id,
    name: model.displayName,
    provider: model.provider,
    contextWindow: deps.catalog.getContextWindowForModel(model),
    maxOutputTokens: model.tokenLimits?.maxOutputTokens,
    price: priceOf(deps.catalog, model),
    reasoning: model.capabilities.reasoning,
    inputModalities: model.capabilities.multimodal ? ['text', 'image'] : ['text'],
    benchmark: deps.benchmarkFor?.(model) ?? null,
  };
}

/** A metered input price for ordering; free and subscription count as zero, unpriced as unknown. */
function inputPrice(facts: ModelFacts): number | undefined {
  if (facts.price === 'free' || facts.price === 'subscription') return 0;
  if (facts.price === 'unpriced' || facts.price === undefined) return undefined;
  return facts.price.input;
}

const byBenchmarkDesc = (a: ModelFacts, b: ModelFacts): number => (b.benchmark ?? -1) - (a.benchmark ?? -1);
const byPriceAsc = (a: ModelFacts, b: ModelFacts): number => (inputPrice(a) ?? Infinity) - (inputPrice(b) ?? Infinity);
const byPriceDesc = (a: ModelFacts, b: ModelFacts): number => (inputPrice(b) ?? -1) - (inputPrice(a) ?? -1);

/**
 * The order candidates are read in for a tier, from published facts only:
 * the strongest published benchmark then the highest price for premium, the
 * strongest benchmark then the lowest price for standard, the lowest price
 * for economy. It only bounds which models are read; the readings decide.
 */
export function shortlistOrder(tier: RouteTier): (a: ModelFacts, b: ModelFacts) => number {
  if (tier === 'premium') return (a, b) => byBenchmarkDesc(a, b) || byPriceDesc(a, b) || a.registryKey.localeCompare(b.registryKey);
  if (tier === 'standard') return (a, b) => byBenchmarkDesc(a, b) || byPriceAsc(a, b) || a.registryKey.localeCompare(b.registryKey);
  return (a, b) => byPriceAsc(a, b) || a.registryKey.localeCompare(b.registryKey);
}

/** Catalog models a configured, healthy provider serves that meet the hard requirements. */
export function eligibleModels(deps: RoutePlannerDeps, requires: RouteRequirements = {}): ModelDefinition[] {
  const configured = new Set(deps.catalog.getConfiguredProviderIds());
  const health = deps.providerHealth?.();
  const needsTools = requires.toolCalling ?? true;
  return deps.catalog.listModels().filter((model) => {
    if (!model.selectable || !configured.has(model.provider)) return false;
    const status = health?.get(model.provider)?.status;
    if (status !== undefined && UNUSABLE.has(status)) return false;
    if (needsTools && !model.capabilities.toolCalling) return false;
    if (requires.imageInput && !model.capabilities.multimodal) return false;
    if (requires.minContextTokens !== undefined && deps.catalog.getContextWindowForModel(model) < requires.minContextTokens) return false;
    return true;
  });
}

function choiceContext(request: RoutePlanRequest, reading: RequestReading): { [key: string]: string } {
  return {
    work: request.brief,
    purpose: request.purpose,
    tier: reading.tier,
    intent: reading.readings.intent.choice,
    domain: reading.readings.domain.choice,
    language: reading.readings.language.choice,
  };
}

interface TierPool {
  readonly tier: RouteTier;
  readonly members: readonly ModelFacts[];
}

/**
 * The models of one tier: candidates ordered by the tier's published facts,
 * read a shortlist at a time (remembered per model) until the tier holds
 * enough candidates to choose among or the read rounds run out.
 */
async function poolFor(deps: RoutePlannerDeps, candidates: readonly ModelFacts[], tier: RouteTier, request: RoutePlanRequest): Promise<TierPool> {
  const sorted = [...candidates].sort(shortlistOrder(tier));
  const inTier = (facts: ModelFacts): boolean => deps.tiers.known(facts)?.tier === tier;
  for (let round = 0; round < TIER_READ_ROUNDS; round++) {
    if (sorted.filter(inTier).length >= CHOICE_SHORTLIST) break;
    const unread = sorted.filter((facts) => deps.tiers.known(facts) === undefined).slice(0, TIER_READ_SHORTLIST);
    if (unread.length === 0) break;
    await deps.tiers.readMany(unread, { site: 'routing.route-planner.model-tier', ...(request.signal ? { signal: request.signal } : {}) });
  }
  return { tier, members: sorted.filter(inTier) };
}

function describe(reading: RequestReading, pool: TierPool, pick: Selection, chosen: string, eligible: number): string {
  const r = reading.readings;
  const parts = [
    `tier ${reading.tier} (${reading.tierBecause})`,
    `intent ${r.intent.choice}, domain ${r.domain.choice}, language ${r.language.choice}, difficulty ${r.difficulty.score.toFixed(1)}/3, risk ${r.risk.score.toFixed(1)}/3`,
  ];
  if (pool.tier !== reading.tier) parts.push(`no fitting ${reading.tier} model is configured, so the ${pool.tier} tier was used`);
  parts.push(`chose ${chosen} from ${Math.min(pool.members.length, CHOICE_SHORTLIST)} ${pool.tier} candidates of ${eligible} eligible models (pick ${pick.pick.confidence.toFixed(2)}, ${pick.outcome})`);
  return parts.join('; ');
}

export function createRoutePlanner(deps: RoutePlannerDeps): RoutePlanner {
  return {
    async planRoute(request) {
      const signalOption = request.signal ? { signal: request.signal } : {};
      const reading = await readRequest(request, { site: 'routing.route-planner.request', ...signalOption });
      const eligible = eligibleModels(deps, request.requires);
      if (eligible.length === 0) {
        throw new NoRouteError('No configured, healthy provider serves a model that meets this work\'s requirements (tool calling, context window, image input).');
      }
      const facts = eligible.map((model) => factsFor(deps, model));
      const byKey = new Map(eligible.map((model) => [model.registryKey, model]));
      for (const tier of tierSearchOrder(reading.tier)) {
        const pool = await poolFor(deps, facts, tier, request);
        if (pool.members.length === 0) continue;
        const shortlist = pool.members.slice(0, CHOICE_SHORTLIST);
        const candidates: Candidate[] = shortlist.map((member) => ({ id: member.registryKey, content: { ...modelFactsState(member), tier } }));
        const pick = await modelChoice.select(judgmentPort('routing.route-planner.choice'), choiceContext(request, reading), candidates, {
          site: 'routing.route-planner.choice',
          ...signalOption,
        });
        // The pick stands when its own fit question reads yes, whatever the
        // pick's confidence: several same-tier models often fit equally, which
        // spreads the choice's probability without making any of them wrong,
        // and the Jev guidance for choosing the best option is to take the most
        // probable one rather than to threshold it. The reason records the
        // pick's confidence and outcome for review.
        if (pick.chosen === undefined || pick.chosen === NONE) {
          pick.recordAction(`none-fit:${tier}`);
          continue;
        }
        const model = byKey.get(pick.chosen)!;
        const fallbackModels = shortlist
          .map((member) => member.registryKey)
          .filter((key) => key !== pick.chosen && pick.fits[key]?.verdict === 'yes')
          .sort((a, b) => pick.fits[b]!.probability - pick.fits[a]!.probability)
          .slice(0, FALLBACK_ROUTES);
        pick.recordAction(`route:${pick.chosen}`);
        reading.recordAction(`tier:${reading.tier}`);
        return {
          model: model.registryKey,
          provider: model.provider,
          modelId: model.id,
          fallbackModels,
          tier: reading.tier,
          chosenTier: tier,
          reason: describe(reading, pool, pick, model.registryKey, eligible.length),
          request: reading,
          pick,
        };
      }
      throw new NoRouteError(`No configured model fits this work: none of the ${eligible.length} eligible models read as able to do it in any tier.`);
    },
  };
}
