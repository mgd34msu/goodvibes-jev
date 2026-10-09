/** The real registered check-in caller, shared by runtime composition and synthetic route tests. */
import { CheckinService, CheckinReceiptStore, createProviderBackedCheckinJudge, createRuntimeCheckinStateReader } from '../../checkin/index.js';
import type { ConfigKey } from '../../config/schema.js';
import { parseChannelDeliveryTarget } from '../../channels/delivery/types.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayVerbGroupDeps } from './register-gateway-verb-groups.js';
import { registerCheckinGatewayMethods } from './checkin.js';
import { controlPlaneStorePath } from '../control-plane-store-paths.js';

export function registerComposedCheckinGatewayMethods(catalog: GatewayMethodCatalog, deps: Pick<GatewayVerbGroupDeps,
  'channelDeliveryRouter' | 'providerRegistry' | 'automationManager' | 'sessionLister' | 'configManager' | 'shellPaths' | 'surfaceRoot' | 'disposal'>): void {
  if (deps.channelDeliveryRouter && deps.providerRegistry && deps.automationManager && deps.sessionLister && deps.configManager.onDidInvalidate) {
    const channelDeliveryRouter = deps.channelDeliveryRouter;
    const automation = deps.automationManager;
    const sessionLister = deps.sessionLister;
    // The checkin.* keys are string-keyed (they live in the config defaults tree,
    // not the grandfathered ConfigKey union); adapt the daemon's ConfigManager to
    // the check-in's string-keyed config surface.
    const configManager = deps.configManager;
    const onDidInvalidate = deps.configManager.onDidInvalidate.bind(configManager);
    const checkinConfig = {
      get: (key: string): unknown => configManager.get(key as ConfigKey),
      onDidInvalidate: (listener: () => void) => onDidInvalidate(listener),
      set: (key: string, value: string | boolean): void => configManager.set(key as ConfigKey, value as never),
    };
    const checkinService = new CheckinService({
      config: checkinConfig,
      stateReader: createRuntimeCheckinStateReader({
        listSessions: () => sessionLister.listSessions(500),
        listRuns: () => automation.listRuns(),
      }),
      judge: createProviderBackedCheckinJudge(deps.providerRegistry),
      deliverer: {
        deliver: async (channel, message, lifetime) => {
          return channelDeliveryRouter.deliver({
            target: parseChannelDeliveryTarget(channel),
            body: message,
            title: 'Check-in',
            ...(lifetime ? { signal: lifetime.signal, assertCurrent: lifetime.assertCurrent } : {}),
            jobId: 'checkin',
            runId: `checkin-${Date.now()}`,
            includeLinks: false,
          });
        },
      },
      receipts: new CheckinReceiptStore(controlPlaneStorePath(deps.shellPaths, deps.surfaceRoot, 'checkin-receipts.json')),
      automation,
    });
    deps.disposal?.add('check-in evaluation lifetime', () => checkinService.dispose());
    registerCheckinGatewayMethods(catalog, checkinService);
    void checkinService.attach().catch(() => {
      // Automation may be disabled at construction; the schedule syncs on the
      // next checkin.config.set once it is enabled. Never fail construction.
    });
  }

}
