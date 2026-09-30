/** Public host routing types remain aligned with the existing wire contract. */
import type { OperatorMethodOutputMap } from '@goodvibes-jev/engine/contracts';
import { RouteStore, createRoutingResolver, createInboxRouteResolver, toRouteListItem, type RoutingChannelRoute } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { RouteResolver } from '@goodvibes-jev/engine/sdk/platform/intake';

declare const store: RouteStore;
declare const route: RoutingChannelRoute;
const resolver = createRoutingResolver(store);
const intakeResolver: RouteResolver = createInboxRouteResolver(resolver);
const profile: string | null = resolver.resolveProfile('fixture', 'route');
const closed: Promise<void> = store.close();
const wireRoute: OperatorMethodOutputMap['channels.routing.list']['routes'][number] = toRouteListItem(route);
export { intakeResolver, profile, closed, wireRoute };
