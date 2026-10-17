/** Channel registries use each adapter's surfaces.<id>.enabled setting.
 * Route bindings also consult their feature flag.
 */

import { AutomationRouteStore } from '../automation/index.js';
import { ChannelPluginRegistry, RouteBindingManager, SurfaceRegistry } from '../channels/index.js';
import type { ConfigManager } from '../config/index.js';
import type { FeatureFlagManager } from './feature-flags/manager.js';
import type { RuntimeEventBus } from './events/index.js';
import type { RuntimeStore } from './store/index.js';

export interface ChannelComposition {
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
}

export function createChannelComposition(options: {
  readonly configManager: ConfigManager;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeBus: RuntimeEventBus;
  readonly featureFlags: FeatureFlagManager;
}): ChannelComposition {
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore({ configManager: options.configManager }),
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    featureFlags: options.featureFlags,
  });
  const surfaceRegistry = new SurfaceRegistry(options.configManager, options.runtimeStore);
  const channelPlugins = new ChannelPluginRegistry();
  surfaceRegistry.attachPluginRegistry(channelPlugins);
  return { routeBindings, surfaceRegistry, channelPlugins };
}
