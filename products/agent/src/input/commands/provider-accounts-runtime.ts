import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type {
  ProviderAccountRecord,
  ProviderAccountSnapshot,
  ProviderAuthRoute,
  ProviderRouteRecord,
} from '../../runtime/provider-account-snapshot.ts';
import { buildProviderAccountSnapshot } from '../../runtime/provider-account-snapshot.ts';
import {
  requireProvider,
  requireServiceRegistry,
  requireSubscriptionManager,
} from './runtime-services.ts';
import { formatProviderAuthRouteId } from '../../provider-auth-route-display.ts';

function formatRouteList(routes: readonly ProviderAuthRoute[]): string {
  return routes.map((route) => formatProviderAuthRouteId(route)).join(', ');
}

function formatRouteRecord(route: ProviderRouteRecord): string {
  return `${formatProviderAuthRouteId(route.route)}  ${route.usable ? 'usable' : 'blocked'}  auth ${route.freshness}  ${route.detail}`;
}

async function loadProviderAccountSnapshot(context: CommandContext): Promise<ProviderAccountSnapshot> {
  return await buildProviderAccountSnapshot({
    providerModels: requireProvider(context).providerRegistry,
    services: requireServiceRegistry(context),
    subscriptions: requireSubscriptionManager(context),
    environment: {
      hasEnvironmentVariable: (name: string) => Boolean(process.env[name]),
    },
  });
}

function findProviderAccountRecord(
  snapshot: ProviderAccountSnapshot,
  providerId: string | undefined,
): ProviderAccountRecord | undefined {
  if (!providerId) return undefined;
  return snapshot.providers.find((entry) => entry.providerId === providerId);
}

export function registerProviderAccountsRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'accounts',
    aliases: ['account'],
    description: 'Review provider auth routes, subscription windows, and billing-path safety',
    hidden: true,
    usage: '[review|show <provider>|routes <provider>|repair <provider>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (sub === 'panel' || sub === 'open') {
        ctx.print('Open Agent Workspace -> Start -> Sign in to a provider for the workspace view, or run /accounts review for compact command output.');
        return;
      }
      const snapshot = await loadProviderAccountSnapshot(ctx);
      if (sub === 'routes') {
        const providerId = args[1];
        const record = findProviderAccountRecord(snapshot, providerId);
        if (!record) {
          ctx.print(providerId ? `Unknown provider account ${providerId}` : 'Usage: /accounts routes <provider>');
          return;
        }
        ctx.print([
          `Provider Routes ${record.providerId}`,
          `  preferred route ${formatProviderAuthRouteId(record.preferredRoute)}`,
          `  active route ${formatProviderAuthRouteId(record.activeRoute)}`,
          `  reason ${record.activeRouteReason}`,
          ...record.routeRecords.map((route) => `  ${formatRouteRecord(route)}`),
          ...record.routeRecords.flatMap((route) => route.issues.map((issue) => `    issue ${issue}`)),
        ].join('\n'));
        return;
      }
      if (sub === 'repair') {
        const providerId = args[1];
        const record = findProviderAccountRecord(snapshot, providerId);
        if (!record) {
          ctx.print(providerId ? `Unknown provider account ${providerId}` : 'Usage: /accounts repair <provider>');
          return;
        }
        ctx.print([
          `Provider Account Repair ${record.providerId}`,
          `  active route ${formatProviderAuthRouteId(record.activeRoute)}`,
          `  preferred route ${formatProviderAuthRouteId(record.preferredRoute)}`,
          ...(record.fallbackRisk ? [`  routing risk ${record.fallbackRisk}`] : []),
          ...(record.issues.map((issue) => `  issue ${issue}`)),
          ...(record.recommendedActions.length > 0
            ? ['  next', ...record.recommendedActions.map((action) => `    ${action}`)]
            : ['  No active repair actions suggested.']),
        ].join('\n'));
        return;
      }
      if (sub === 'show') {
        const providerId = args[1];
        const record = findProviderAccountRecord(snapshot, providerId);
        if (!record) {
          ctx.print(providerId ? `Unknown provider account ${providerId}` : 'Usage: /accounts show <provider>');
          return;
        }
        ctx.print([
          `Provider Account ${record.providerId}`,
          `  preferred route ${formatProviderAuthRouteId(record.preferredRoute)}`,
          `  active route ${formatProviderAuthRouteId(record.activeRoute)}`,
          `  auth freshness ${record.authFreshness}`,
          `  configured ${record.configured ? 'yes' : 'no'}`,
          `  OAuth ready ${record.oauthReady ? 'yes' : 'no'}`,
          `  pending login ${record.pendingLogin ? 'yes' : 'no'}`,
          `  available routes ${formatRouteList(record.availableRoutes)}`,
          `  model count ${record.modelCount}`,
          `  route reason ${record.activeRouteReason}`,
          ...(record.fallbackRoute ? [`  fallback route ${formatProviderAuthRouteId(record.fallbackRoute)}`] : []),
          ...(record.fallbackRisk ? [`  routing risk ${record.fallbackRisk}`] : []),
          ...(record.expiresAt ? [`  expires at ${new Date(record.expiresAt).toISOString()}`] : []),
          ...record.routeRecords.map((route) => `  route ${formatRouteRecord(route)}`),
          ...record.routeRecords.flatMap((route) => route.issues.map((issue) => `    issue ${issue}`)),
          ...record.usageWindows.map((entry) => `  window ${entry.label}, ${entry.detail}`),
          ...record.issues.map((issue) => `  issue ${issue}`),
          ...record.notes.map((note) => `  note ${note}`),
          ...record.recommendedActions.map((action) => `  next ${action}`),
        ].join('\n'));
        return;
      }
      ctx.print([
        'Provider Account Review',
        `  providers ${snapshot.providers.length}`,
        `  configured ${snapshot.configuredCount}`,
        `  issues ${snapshot.issueCount}`,
        ...snapshot.providers.map((record) => (
          `  ${record.providerId}  active route ${formatProviderAuthRouteId(record.activeRoute)}  preferred route ${formatProviderAuthRouteId(record.preferredRoute)}  auth ${record.authFreshness}  models ${record.modelCount}  issues ${record.issues.length}`
        )),
      ].join('\n'));
    },
  });
}
