import type { ProviderAuthRouteDescriptor } from '@goodvibes-jev/engine/sdk/platform/providers';
import { formatProviderAuthRouteId, formatProviderAuthRouteLabel } from '../provider-auth-route-display.ts';

function routeUsable(route: ProviderAuthRouteDescriptor): boolean {
  return route.usable ?? route.configured;
}

export function summarizeProviderAuthRoutes(routes: readonly ProviderAuthRouteDescriptor[] | undefined): string {
  if (!routes?.length) return 'n/a';
  const configured = routes.filter((route) => route.configured).length;
  const usable = routes.filter(routeUsable).length;
  return `${configured}/${routes.length} configured, ${usable}/${routes.length} usable`;
}

export function formatProviderAuthRoute(route: ProviderAuthRouteDescriptor): string {
  const status = [
    route.configured ? 'configured' : 'not configured',
    routeUsable(route) ? 'usable' : 'not usable',
    route.freshness,
  ].filter((part): part is string => Boolean(part));
  const detail = route.detail?.trim();
  return `${formatProviderAuthRouteLabel(route.route, route.label)} [${formatProviderAuthRouteId(route.route)}; ${status.join(', ')}]${detail ? ` - ${detail}` : ''}`;
}
