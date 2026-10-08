/** Pure provider-console posture. No runtime services or credential reads. */
export { buildProviderHealthDomainSummaries } from './ui/provider-health/domains.js';
export type { HealthDomainSummary, ProviderHealthDomainInputs } from './ui/provider-health/domains.js';
export { buildAccountPosture, buildSyntheticAuthRoutes, isRouteUsable, routePriority } from './ui/provider-health/routes.js';
export type {
  ProviderHealthAuthRoute,
  ProviderHealthAuthFreshness,
  ProviderRuntimeAuthMetadata,
  ProviderRuntimeSnapshotLike,
  ProviderAccountPosture,
} from './ui/provider-health/routes.js';
