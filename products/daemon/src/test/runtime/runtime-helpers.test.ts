import { afterEach, expect, spyOn, test } from 'bun:test';
import { createFleetServices as canonicalFleetServices } from '@goodvibes-jev/engine/terminal-shell';
import { ObservedAgentSource } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet/observed';
import { WorktreeRegistry as CanonicalWorktrees } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { GlobalNetworkTransportInstaller as CanonicalTransport } from '@goodvibes-jev/engine/sdk/platform/runtime/transport';
import { CardMaterialRedactor } from '@goodvibes-jev/engine/sdk/platform/payments';
import type { BrowserCheckoutSeam } from '@goodvibes-jev/engine/sdk/platform/control-plane';
import { createFleetServices, type FleetServicesDeps } from '../../runtime/fleet-services.ts';
import { createBrowserCheckoutSeamHolder } from '../../runtime/browser-checkout-seam-holder.ts';
import { WorktreeRegistry, GlobalNetworkTransportInstaller } from '../../runtime/index.ts';

const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });
function unexpected(): never { throw new Error('Unexpected fixture control operation'); }
function fleetFixture(): { deps: FleetServicesDeps; handles: Set<symbol> } {
  const handles = new Set<symbol>();
  return {
    handles,
    deps: {
      agentManager: { list: () => [], cancel: unexpected }, contractRunner: { list: () => [], cancel: unexpected },
      processManager: { list: () => [], stop: unexpected, getStatus: unexpected },
      watcherRegistry: { list: () => [], stopWatcher: unexpected },
      workflow: {
        workflowManager: { list: () => [], cancel: unexpected },
        triggerManager: { list: () => [], remove: unexpected, disable: unexpected, enable: unexpected },
        scheduleManager: { list: () => [], remove: unexpected, disable: unexpected, enable: unexpected },
      },
      providerRegistry: { resolveModelPricing: unexpected }, now: () => 1000,
      timers: {
        setInterval: () => { const handle = Symbol('fixture'); handles.add(handle); return handle; },
        clearInterval: (handle) => { handles.delete(handle as symbol); },
      },
    },
  };
}

test('fleet composition is the canonical shared implementation, not a second rule copy', () => {
  expect(createFleetServices).toBe(canonicalFleetServices);
});

test('the real archive-aware fleet registry works with injected empty managers and owns its tick', () => {
  const fixture = fleetFixture(); const { processRegistry } = createFleetServices(fixture.deps);
  const stop = processRegistry.subscribe(() => {});
  try { expect(processRegistry.query().nodes).toEqual([]); expect(fixture.handles.size).toBe(1); }
  finally { stop(); processRegistry.dispose(); }
  expect(fixture.handles.size).toBe(0);
});

test('observed-agent wiring is opt-in, and the test never reads the host process/session inventory', () => {
  const observed = spyOn(ObservedAgentSource.prototype, 'list').mockReturnValue([]);
  restores.push(() => observed.mockRestore());
  const first = createFleetServices(fleetFixture().deps).processRegistry;
  try { first.query(); expect(observed).toHaveBeenCalledTimes(0); }
  finally { first.dispose(); }
  const second = createFleetServices({ ...fleetFixture().deps, observeExternalAgents: true }).processRegistry;
  try { second.query(); expect(observed).toHaveBeenCalled(); }
  finally { second.dispose(); }
});

function seam(): BrowserCheckoutSeam {
  return { cardFieldGuard: new CardMaterialRedactor(), driverFor: unexpected, armSubmitApproval: async () => unexpected() };
}
test('browser checkout is read at call time and clear stops returning the old seam', () => {
  const holder = createBrowserCheckoutSeamHolder(); const first = seam(); const second = seam();
  expect(holder.get()).toBeUndefined(); holder.set(first); expect(holder.get()).toBe(first);
  holder.clear(); expect(holder.get()).toBeUndefined(); holder.set(second); expect(holder.get()).toBe(second);
  holder.clear(); holder.clear(); expect(holder.get()).toBeUndefined();
});

test('the runtime barrel uses live public class re-exports without constructing host services', () => {
  expect(WorktreeRegistry).toBe(CanonicalWorktrees);
  expect(GlobalNetworkTransportInstaller).toBe(CanonicalTransport);
});
