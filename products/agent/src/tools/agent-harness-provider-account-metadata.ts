import type { CommandContext } from '../input/command-registry.ts';
import type { ProviderAccountRecord, ProviderAccountSnapshot } from '../runtime/provider-account-snapshot.ts';
import { buildProviderAccountSnapshot } from '../runtime/provider-account-snapshot.ts';
import { requireProvider, requireServiceRegistry, requireSubscriptionManager } from '../input/commands/runtime-services.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessProviderAccountArgs {
  readonly providerId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type ProviderAccountLookupSource = 'providerId' | 'target' | 'query';

type ProviderAccountResolution =
  | { readonly status: 'found'; readonly account: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

async function loadSnapshot(context: CommandContext): Promise<ProviderAccountSnapshot> {
  return await buildProviderAccountSnapshot({
    providerModels: requireProvider(context).providerRegistry,
    services: requireServiceRegistry(context),
    subscriptions: requireSubscriptionManager(context),
    environment: {
      hasEnvironmentVariable: (name: string) => Boolean(process.env[name]),
    },
  });
}

function lookupFromArgs(args: AgentHarnessProviderAccountArgs): { readonly source: ProviderAccountLookupSource; readonly input: string } | null {
  const providerId = readString(args.providerId);
  if (providerId) return { source: 'providerId', input: providerId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function accountSearchText(account: ProviderAccountRecord): string {
  return [
    account.providerId,
    account.authFreshness,
    account.activeRoute,
    account.preferredRoute,
    account.activeRouteReason,
    account.fallbackRoute ?? '',
    account.fallbackRisk ?? '',
    ...account.availableRoutes,
    ...account.issues,
    ...account.notes,
    ...account.recommendedActions,
    ...account.usageWindows.flatMap((window) => [window.label, window.detail]),
    ...account.routeRecords.flatMap((route) => [route.route, route.freshness, route.detail, ...route.issues]),
  ].join('\n').toLowerCase();
}

function describeCandidate(account: ProviderAccountRecord): Record<string, unknown> {
  return {
    providerId: account.providerId,
    activeRoute: account.activeRoute,
    preferredRoute: account.preferredRoute,
    authFreshness: account.authFreshness,
    configured: account.configured,
    issues: account.issues.length,
    modelRoute: providerAccountModelRoute(),
  };
}

function providerAccountModelRoute(): string {
  return 'agent_harness mode:"provider_account" or mode:"run_command"';
}

function describeAccount(
  account: ProviderAccountRecord,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    providerId: account.providerId,
    active: account.active,
    configured: account.configured,
    modelCount: account.modelCount,
    oauthReady: account.oauthReady,
    pendingLogin: account.pendingLogin,
    availableRoutes: account.availableRoutes,
    preferredRoute: account.preferredRoute,
    activeRoute: account.activeRoute,
    activeRouteReason: account.activeRouteReason,
    authFreshness: account.authFreshness,
    ...(account.fallbackRoute ? { fallbackRoute: account.fallbackRoute } : {}),
    ...(account.fallbackRisk ? { fallbackRisk: account.fallbackRisk } : {}),
    ...(account.expiresAt ? { expiresAt: new Date(account.expiresAt).toISOString() } : {}),
    ...(account.tokenType ? { tokenType: account.tokenType } : {}),
    issueCount: account.issues.length,
    recommendedActionCount: account.recommendedActions.length,
    modelRoute: providerAccountModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters
      ? {
        routeRecords: account.routeRecords.map((route) => ({
          route: route.route,
          usable: route.usable,
          freshness: route.freshness,
          detail: route.detail,
          issues: route.issues,
        })),
        usageWindows: account.usageWindows,
        issues: account.issues,
        notes: account.notes,
        recommendedActions: account.recommendedActions,
        policy: {
          effect: 'read-only',
          values: 'Provider account posture reports route and freshness metadata only; raw tokens, authorization codes, and secret values are never returned.',
          mutation: 'Provider login, logout, subscription bundle export, and account repair actions stay explicit confirmation-gated workspace or slash-command flows.',
        },
        modelAccess: {
          reviewCommand: '/accounts review',
          showCommand: `/accounts show ${account.providerId}`,
          routesCommand: `/accounts routes ${account.providerId}`,
          repairCommand: `/accounts repair ${account.providerId}`,
          subscriptionInspectCommand: `/subscription inspect ${account.providerId}`,
          workspaceActions: [
            'provider-accounts',
            'provider-account-repair',
            'subscription-review',
            'subscription-inspect',
          ],
          loginStartCommand: `/subscription login ${account.providerId} start --yes`,
          loginFinishCommand: `/subscription login ${account.providerId} finish <code-or-url> --yes`,
          logoutCommand: `/subscription logout ${account.providerId} --yes`,
          confirmationRequired: true,
        },
      }
      : {
        summary: previewHarnessText(`${account.providerId} ${account.authFreshness}; ${account.issues.length} issue(s)`),
      }),
  };
}

export async function providerAccountCatalogStatus(context: CommandContext): Promise<Record<string, unknown>> {
  const snapshot = await loadSnapshot(context);
  return {
    modes: ['provider_accounts', 'provider_account'],
    providers: snapshot.providers.length,
    configured: snapshot.configuredCount,
    issues: snapshot.issueCount,
    readOnly: true,
  };
}

export async function providerAccountSummary(
  context: CommandContext,
  args: AgentHarnessProviderAccountArgs,
): Promise<Record<string, unknown>> {
  const snapshot = await loadSnapshot(context);
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const accounts = snapshot.providers
    .filter((account) => !query || accountSearchText(account).includes(query))
    .slice(0, readLimit(args.limit, 100));
  return {
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    providers: accounts.map((account) => describeAccount(account, { includeParameters })),
    returned: accounts.length,
    total: snapshot.providers.length,
    configured: snapshot.configuredCount,
    issues: snapshot.issueCount,
    policy: 'Read-only provider account posture. Use confirmed workspace actions or slash-command mirrors for login/logout/bundle mutations.',
  };
}

export async function describeHarnessProviderAccount(
  context: CommandContext,
  args: AgentHarnessProviderAccountArgs,
): Promise<ProviderAccountResolution> {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'provider_account requires providerId, target, or query. Prefer models action:"providers" to inspect provider ids.',
    };
  }
  const snapshot = await loadSnapshot(context);
  const normalized = lookup.input.toLowerCase();
  const exact = snapshot.providers.find((account) => account.providerId === lookup.input);
  if (exact) return { status: 'found', account: describeAccount(exact, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' } }) };
  const insensitive = snapshot.providers.find((account) => account.providerId.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', account: describeAccount(insensitive, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  const searched = snapshot.providers.filter((account) => accountSearchText(account).includes(normalized));
  if (searched.length === 1) {
    return { status: 'found', account: describeAccount(searched[0]!, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) };
  }
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(describeCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown provider account ${lookup.input}. Prefer models action:"providers" to inspect provider ids.`,
  };
}
