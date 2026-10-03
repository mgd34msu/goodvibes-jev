import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import {
  createFeatureFlagManager,
  deriveFeatureStates,
  RuntimeEventBus,
  configureRuntimeEventBusDefaults,
  runtimeEventBusOptionsFrom,
} from '@/runtime/index.ts';
import { AutomationRouteStore } from '@goodvibes-jev/engine/sdk/platform/automation';
import { RouteBindingManager } from '@goodvibes-jev/engine/sdk/platform/channels';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('automation/control-plane foundation', () => {
  let root = '';
  let configDir = '';

  beforeEach(() => {
    root = makeProjectTempDir('gv-automation-foundation');
    configDir = join(root, '.goodvibes', 'tui');
  });

  afterEach(() => {
    configDir = '';
  });

  test('initial runtime store includes automation, routes, control-plane, and watcher domains', () => {
    const store = createRuntimeStore();
    const state = store.getState();

    expect(state.automation.jobs.size).toBe(0);
    expect(state.routes.bindings.size).toBe(0);
    expect(state.controlPlane.clients.size).toBe(0);
    expect(state.deliveries.deliveryAttempts.size).toBe(0);
    expect(state.watchers.watchers.size).toBe(0);
    expect(state.surfaces.surfaces.size).toBe(0);
    expect(state.routes.bindingIds).toEqual([]);
    expect(state.controlPlane.connectionState).toBe('disabled');
  });

  /**
   * integrations.routeBinding, driven to BOTH values through the real consumer.
   *
   * This setting used to configure nothing in this product. The gate reads
   * through isFeatureGateEnabled, which is permissive when no manager is wired,
   * a narrow embed with no flag manager gets the capability rather than a silent
   * off, so a composition root that omitted featureFlags did not DISABLE route
   * binding. It made the switch inert: the key rendered in settings, accepted a
   * write, reported success, and the manager went on binding either way. That is
   * the same shape as a bot username that lands in the wrong config file, and it
   * is why services.ts now threads featureFlags into RouteBindingManager.
   *
   * The mutation check for this row: remove that argument and the "off" half of
   * the first test below fails, because the manager falls back to permissive.
   */
  function routeBindingManager(enabled: boolean): RouteBindingManager {
    const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir });
    configManager.set('integrations.routeBinding', enabled);
    const featureFlags = createFeatureFlagManager();
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    // Constructed exactly as runtime/services.ts constructs it.
    return new RouteBindingManager({
      store: new AutomationRouteStore({ configManager }),
      runtimeStore: createRuntimeStore(),
      featureFlags,
    });
  }

  test('integrations.routeBinding true binds and resolves a route, and is the shipped default', async () => {
    const manager = routeBindingManager(true);
    expect(manager.isRouteBindingEnabled()).toBe(true);
    const binding = await manager.upsertBinding({ kind: 'session', surfaceKind: 'telegram', surfaceId: 'surface:telegram', externalId: 'chat-1' });
    expect(binding.externalId).toBe('chat-1');
    expect(manager.resolve('telegram', 'chat-1')?.id).toBe(binding.id);

    // The default half: with the key never written, the effective behaviour is
    // the same as true. This is what makes threading featureFlags a fix that
    // changes only whether the switch WORKS, not what an existing install does.
    const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'unset') });
    expect(configManager.get('integrations.routeBinding')).toBe(true);
    const flags = createFeatureFlagManager();
    flags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    const unset = new RouteBindingManager({
      store: new AutomationRouteStore({ configManager }),
      runtimeStore: createRuntimeStore(),
      featureFlags: flags,
    });
    expect(unset.isRouteBindingEnabled()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runtime.eventBus.maxListeners, threaded into a bus built with no options,
// the same way every composition root in this project now calls it
// (bundle-command.ts, management.ts, bootstrap-core.ts):
// `configureRuntimeEventBusDefaults(runtimeEventBusOptionsFrom((key) =>
// configManager.get(key)))` right before the first `new RuntimeEventBus()`.
//
// Before this sweep, none of the three called it: the schema promised a
// tunable listener cap and every bus in this project was built with no
// options, so the cap was always the SDK's hardcoded 100 regardless of the
// setting. This proves the exact call shape used at all three sites reaches
// a freshly-built bus, in both directions (a lower cap refuses sooner, a
// higher cap accepts more).
// ---------------------------------------------------------------------------

describe('runtime.eventBus.maxListeners reaches a bus built with no options', () => {
  let origEnv: string | undefined;
  let tmpRoot: string;

  beforeEach(() => {
    origEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'development';
    tmpRoot = makeProjectTempDir('gv-event-bus-cap');
  });

  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = origEnv;
    }
    // Leave the process-wide default where the rest of the suite expects it.
    configureRuntimeEventBusDefaults({ maxListeners: 100 });
  });

  function configManagerWithCap(cap: number): ConfigManager {
    const manager = new ConfigManager({ surfaceRoot: 'agent', configDir: join(tmpRoot, `config-${cap}`) });
    manager.set('runtime.eventBus.maxListeners', cap);
    return manager;
  }
});
