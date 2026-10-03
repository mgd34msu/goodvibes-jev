import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import type {
  ProviderAccountInspectionQuery,
} from '@/runtime/index.ts';

export type ProviderAuthRoute = 'api-key' | 'subscription' | 'service-oauth' | 'unconfigured';
export type ProviderAuthFreshness = 'healthy' | 'expiring' | 'expired' | 'pending' | 'unconfigured';

export interface ProviderUsageWindow {
  readonly label: string;
  readonly detail: string;
}

export interface ProviderRouteRecord {
  readonly route: Exclude<ProviderAuthRoute, 'unconfigured'>;
  readonly usable: boolean;
  readonly freshness: ProviderAuthFreshness;
  readonly detail: string;
  readonly issues: readonly string[];
}

export interface ProviderAccountRecord {
  readonly providerId: string;
  readonly active: boolean;
  readonly modelCount: number;
  readonly configured: boolean;
  readonly oauthReady: boolean;
  readonly pendingLogin: boolean;
  readonly availableRoutes: readonly ProviderAuthRoute[];
  readonly preferredRoute: ProviderAuthRoute;
  readonly activeRoute: ProviderAuthRoute;
  readonly activeRouteReason: string;
  readonly authFreshness: ProviderAuthFreshness;
  readonly fallbackRoute?: ProviderAuthRoute;
  readonly fallbackRisk?: string;
  readonly expiresAt?: number;
  readonly tokenType?: string;
  readonly notes: readonly string[];
  readonly usageWindows: readonly ProviderUsageWindow[];
  readonly issues: readonly string[];
  readonly recommendedActions: readonly string[];
  readonly routeRecords: readonly ProviderRouteRecord[];
}

export interface ProviderAccountSnapshot {
  readonly capturedAt: number;
  readonly providers: readonly ProviderAccountRecord[];
  readonly configuredCount: number;
  readonly issueCount: number;
}

export interface ProviderAccountSnapshotDeps extends ProviderAccountInspectionQuery {}

export interface ProviderAccountSnapshotQuery {
  readonly loadSnapshot: () => Promise<ProviderAccountSnapshot>;
}

export function createProviderAccountSnapshotQuery(
  deps: ProviderAccountSnapshotDeps,
): ProviderAccountSnapshotQuery {
  return {
    loadSnapshot: () => buildProviderAccountSnapshot(deps),
  };
}

function determineActiveRoute(routes: readonly ProviderAuthRoute[]): ProviderAuthRoute {
  if (routes.includes('subscription')) return 'subscription';
  if (routes.includes('service-oauth')) return 'service-oauth';
  if (routes.includes('api-key')) return 'api-key';
  return 'unconfigured';
}

function isExpired(expiresAt?: number): boolean {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function determineFreshness(input: {
  readonly hasSubscription: boolean;
  readonly expiresAt?: number;
  readonly pending: boolean;
  readonly hasUsableServiceOAuth: boolean;
  readonly hasApiKey: boolean;
}): ProviderAuthFreshness {
  if (input.hasSubscription) {
    if (isExpired(input.expiresAt)) return 'expired';
    if (input.expiresAt && input.expiresAt <= Date.now() + 24 * 60 * 60 * 1000) return 'expiring';
    if (input.pending) return 'pending';
    return 'healthy';
  }
  if (input.hasUsableServiceOAuth || input.hasApiKey) return 'healthy';
  return 'unconfigured';
}

function builtinWindowsForProvider(providerId: string): readonly ProviderUsageWindow[] {
  if (providerId === 'openai') {
    return [
      { label: '5-hour window', detail: 'Subscription-backed OpenAI access may be constrained by rolling 5-hour usage limits.' },
      { label: '1-week window', detail: 'Subscription-backed OpenAI access may also be constrained by a rolling weekly limit.' },
    ];
  }
  return [];
}

function readProviderEnvVars(model: unknown): readonly string[] {
  if (typeof model !== 'object' || model === null) return [];
  const value = (model as { readonly providerEnvVars?: unknown }).providerEnvVars;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function defaultProviderEnvKeys(providerId: string): readonly string[] {
  const normalized = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalized.length === 0) return [];
  return [`${normalized}_API_KEY`, `${normalized}_KEY`];
}

export async function buildProviderAccountSnapshot(
  deps: ProviderAccountSnapshotDeps,
): Promise<ProviderAccountSnapshot> {
  const models = deps.providerModels.listModels();
  const services = deps.services.getAll();
  const subscriptions = deps.subscriptions;
  const builtinSubscriptionProviders = new Set(listBuiltinSubscriptionProviders().map((entry) => entry.provider));
  const serviceInspections = await Promise.all(Object.keys(services).map(async (name) => ({
    name,
    inspection: await deps.services.inspect(name),
  })));
  const serviceOauthByProvider = new Map<string, { configured: boolean; usable: boolean }>();
  for (const { inspection } of serviceInspections) {
    if (!inspection || inspection.config.authType !== 'oauth') continue;
    const providerId = inspection.config.providerId ?? inspection.config.name;
    const existing = serviceOauthByProvider.get(providerId);
    serviceOauthByProvider.set(providerId, {
      configured: true,
      usable: Boolean(existing?.usable || inspection.hasPrimaryCredential),
    });
  }

  const providerIds = new Set<string>([
    ...models.map((model) => model.provider),
    ...Object.values(services).map((service) => service.providerId ?? service.name),
    ...subscriptions.list().map((entry) => entry.provider),
    ...subscriptions.listPending().map((entry) => entry.provider),
    ...builtinSubscriptionProviders,
  ]);

  const providers = await Promise.all([...providerIds].sort((a, b) => a.localeCompare(b)).map(async (providerId) => {
    const providerModels = models.filter((model) => model.provider === providerId);
    const subscription = subscriptions.get(providerId);
    const pending = subscriptions.getPending(providerId);
    const serviceConfig = Object.values(services).find((entry) => (entry.providerId ?? entry.name) === providerId) ?? null;
    const serviceOauth = serviceOauthByProvider.get(providerId);
    const apiKeyCandidates = new Set<string>([
      ...(serviceConfig?.tokenKey ? [serviceConfig.tokenKey] : []),
      ...providerModels.flatMap((model) => readProviderEnvVars(model)),
      ...defaultProviderEnvKeys(providerId),
    ]);
    const hasApiKey = [...apiKeyCandidates].some((key) => deps.environment.hasEnvironmentVariable(key));
    const hasSubscription = subscription != null;
    const hasServiceOAuth = Boolean(serviceOauth?.configured || serviceConfig?.authType === 'oauth' || serviceConfig?.oauth);
    const hasUsableServiceOAuth = Boolean(serviceOauth?.usable);
    const routes: ProviderAuthRoute[] = [];
    if (hasApiKey) routes.push('api-key');
    if (hasSubscription) routes.push('subscription');
    if (hasServiceOAuth) routes.push('service-oauth');
    if (routes.length === 0) routes.push('unconfigured');

    const usableRoutes: Exclude<ProviderAuthRoute, 'unconfigured'>[] = [];
    if (hasApiKey) usableRoutes.push('api-key');
    if (hasSubscription && !isExpired(subscription.expiresAt)) usableRoutes.push('subscription');
    if (hasUsableServiceOAuth) usableRoutes.push('service-oauth');

    const activeRoute = determineActiveRoute(usableRoutes);
    const preferredRoute = determineActiveRoute(routes);
    const freshness = determineFreshness({
      hasSubscription,
      expiresAt: subscription?.expiresAt,
      pending: pending != null,
      hasUsableServiceOAuth,
      hasApiKey,
    });
    const usageWindows = builtinWindowsForProvider(providerId);
    const routeRecords: ProviderRouteRecord[] = [];

    if (hasApiKey) {
      routeRecords.push({
        route: 'api-key',
        usable: true,
        freshness: 'healthy',
        detail: 'Ambient API key is available for direct provider access.',
        issues: [],
      });
    }
    if (hasSubscription) {
      routeRecords.push({
        route: 'subscription',
        usable: !isExpired(subscription?.expiresAt),
        freshness: pending ? 'pending' : isExpired(subscription?.expiresAt) ? 'expired' : 'healthy',
        detail: subscription?.overrideAmbientApiKeys
          ? 'Subscription route is configured to override ambient API-key resolution.'
          : 'Subscription route is configured, but ambient API keys remain active unless selected explicitly.',
        issues: isExpired(subscription?.expiresAt) ? ['Stored subscription session is expired.'] : [],
      });
    }
    if (hasServiceOAuth) {
      routeRecords.push({
        route: 'service-oauth',
        usable: hasUsableServiceOAuth,
        freshness: hasUsableServiceOAuth ? 'healthy' : 'unconfigured',
        detail: hasUsableServiceOAuth
          ? 'Provider OAuth credential is available for this provider.'
          : 'Provider OAuth is configured but missing a usable credential.',
        issues: hasUsableServiceOAuth ? [] : ['Provider OAuth credential is missing or unavailable.'],
      });
    }

    const issues: string[] = [];
    const notes: string[] = [`${providerModels.length} model${providerModels.length === 1 ? '' : 's'} registered`];
    if (serviceConfig) notes.push(`provider config: ${serviceConfig.authType}`);
    const recommendedActions: string[] = [];
    if (routes.length === 1 && routes[0] === 'unconfigured') {
      issues.push('Provider has no configured auth route.');
      recommendedActions.push(`Configure API keys, subscriptions, or provider OAuth for ${providerId}.`);
    }
    if (hasSubscription && isExpired(subscription?.expiresAt)) {
      issues.push('Stored subscription session is expired and needs refresh.');
      recommendedActions.push(`Refresh or replace the ${providerId} subscription session before relying on it.`);
    } else if (hasSubscription && subscription?.expiresAt && subscription.expiresAt <= Date.now() + 24 * 60 * 60 * 1000) {
      issues.push('Stored subscription session is nearing expiry.');
      recommendedActions.push(`Renew or verify the ${providerId} subscription session soon to avoid route drift.`);
    }
    if (pending) {
      issues.push('Provider has a pending OAuth login that has not been completed yet.');
      recommendedActions.push(`Finish /subscription login ${providerId} finish <code> --yes or clear the pending login.`);
    }
    if (hasSubscription && hasApiKey) {
      issues.push('Provider has both subscription and API-key auth paths; routing must remain explicit.');
      recommendedActions.push('Review provider routing before switching models or auth paths.');
    }
    if (hasServiceOAuth && !hasUsableServiceOAuth) {
      issues.push('Provider OAuth is configured but missing a usable credential.');
      recommendedActions.push(`Repair provider OAuth credentials for ${providerId} in /settings or the owning GoodVibes host.`);
    }

    return {
      providerId,
      active: activeRoute !== 'unconfigured',
      modelCount: providerModels.length,
      configured: hasApiKey || hasSubscription || hasServiceOAuth || providerModels.length > 0,
      oauthReady: Boolean(serviceConfig?.oauth),
      pendingLogin: Boolean(pending),
      availableRoutes: routes,
      preferredRoute,
      activeRoute,
      activeRouteReason: activeRoute === 'subscription'
        ? 'Subscription route is currently preferred.'
        : activeRoute === 'service-oauth'
          ? 'Provider OAuth route is currently preferred.'
          : activeRoute === 'api-key'
            ? 'Ambient API-key route is currently preferred.'
            : 'No usable auth route is configured for this provider.',
      authFreshness: freshness,
      fallbackRoute: activeRoute !== preferredRoute ? activeRoute : undefined,
      // D7 fix: fallbackRisk is only meaningful when a fallbackRoute exists (i.e. activeRoute
      // differs from preferredRoute). Setting it on a healthy provider where activeRoute===
      // preferredRoute would show a spurious risk advisory with no fallback target.
      fallbackRisk: (activeRoute !== preferredRoute) && hasSubscription && hasApiKey
        ? (isExpired(subscription?.expiresAt)
          ? 'preferred subscription path is expired; active route falls back to API key.'
          : 'Both subscription and API key are present; check route priority.')
        : undefined,
      expiresAt: subscription?.expiresAt,
      tokenType: subscription?.tokenType,
      notes,
      usageWindows,
      issues,
      recommendedActions,
      routeRecords,
    };
  }));

  return {
    capturedAt: Date.now(),
    providers,
    configuredCount: providers.filter((provider) => provider.configured).length,
    issueCount: providers.reduce((sum, provider) => sum + provider.issues.length, 0),
  };
}
