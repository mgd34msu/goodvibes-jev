/**
 * Routing: every request is read for the tier and handler it needs before
 * tokens are spent, and every model question (tier, identity, access, choice)
 * is a Jev reading over the whole catalog. No rule names a vendor or a model.
 */
export { ROUTE_TIERS, MODEL_TIER_OPTIONS, WORK_TIER_OPTIONS, higherTier, tierRank, tierSearchOrder, type RouteTier } from './tiers.js';
export {
  TIER_FOR_DIFFICULTY,
  TIER_FLOOR_FOR_RISK,
  TIER_FLOOR_FOR_PURPOSE,
  TIER_FLOOR_FOR_UNSURE_NON_ENGLISH,
  TIER_READ_SHORTLIST,
  TIER_READ_ROUNDS,
  CHOICE_SHORTLIST,
  FALLBACK_ROUTES,
  TIER_READ_CONCURRENCY,
  BENCHMARK_READ_CONCURRENCY,
  GUIDANCE_TIER_WHEN_UNSETTLED,
} from './policy.js';
export {
  DOMAINS,
  INTENTS,
  LANGUAGES,
  REQUEST_BATTERIES,
  requestDifficulty,
  requestDomain,
  requestIntent,
  requestLanguage,
  requestRisk,
  requestTier,
  type RequestDomain,
  type RequestIntent,
  type RequestLanguage,
} from './batteries/request.js';
export { modelChoice, modelIdentity, modelTier } from './batteries/model.js';
export { catalogProviderAccess, type ProviderAccess } from './batteries/catalog.js';
export {
  REASONING_FAMILY_ROUTES,
  alternateApi,
  contentPartKind,
  localServerIdentity,
  reasoningFamily,
  reasoningRejection,
  stopReason,
  type ReasoningFamily,
} from './batteries/provider.js';
export { composeTier, readRequest, requestState, type RequestReading, type RoutingRequest } from './request-reading.js';
export {
  NoRouteError,
  createRoutePlanner,
  eligibleModels,
  factsFor,
  shortlistOrder,
  type PlannedRoute,
  type RoutePlanRequest,
  type RoutePlanner,
  type RoutePlannerCatalog,
  type RoutePlannerDeps,
  type RouteRequirements,
} from './route-planner.js';
export { ModelTierStore, modelFactsState, modelTierFrom, type ModelFacts, type TierRecord } from './model-tiers.js';
export {
  IDENTITY_SHORTLIST,
  ModelIdentityResolver,
  identityShortlist,
  identityTokens,
  type IdentityCandidate,
  type IdentityQuery,
  type ModelIdentityResolverOptions,
} from './model-identity.js';
export { ProviderAccessReadings, providerAccessFrom, providerFactsState, type ProviderFacts } from './catalog-access.js';
export {
  forgetProviderReadings,
  knownContentPartIsReasoning,
  knownReasoningFamily,
  readContentPartIsReasoning,
  readLocalServerIdentity,
  readReasoningFamily,
  readStopReason,
  readsAsAlternateApi,
  readsAsReasoningRejection,
  type LocalServerSoftware,
  type ReadStopReason,
  type ServerProbeEvidence,
} from './provider-readings.js';
export {
  describeUserError,
  readUserErrorClass,
  readUserFacingError,
  readUserFacingErrorLine,
  userErrorEvidence,
  userErrorReading,
  type ErrorClass,
  type UserErrorReading,
  type UserFacingError,
} from './user-error.js';
export * from './task-routes/index.js';
export { registry as routingRegistry } from './judgment-registry.js';
export { localRecipeFit, routeReadiness } from './batteries/model-readiness.js';
export {
  localRecipeFitFrom,
  modelReadinessFlagFrom,
  routeReadinessFrom,
  type LocalRecipeFitInput,
  type LocalRecipeFitLevel,
  type LocalRecipeFitReading,
  type LocalRecipeMemoryTier,
  type ModelReadinessFlag,
  type ModelReadinessFlagReading,
  type ModelReadinessHeldOutcome,
  type ModelReadinessNonAnswer,
  type ModelReadinessOutcome,
  type ModelReadinessProvenance,
  type ModelReadinessRun,
  type ModelReadinessScoreReading,
  type RouteReadinessDimension,
  type RouteReadinessDimensionId,
  type RouteReadinessInput,
  type RouteReadinessLevel,
  type RouteReadinessReading,
} from './model-readiness.js';
