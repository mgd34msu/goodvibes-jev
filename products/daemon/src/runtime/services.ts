/** The product's async composition boundary over its real runtime graph. */
import { createDisposalScope } from './disposal-wiring.js';
import { createRuntimeBaseServices } from './service-graph.js';
import { createDaemonHandlerComposition } from './daemon-handler-composition.js';
import { resumeContracts } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.js';
export type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.js';
export { startDeviceHousekeeping } from './device-posture-composition.js';

/** Await before passing this owned graph to DaemonServer. */
export async function createRuntimeServices(options: RuntimeServicesOptions): Promise<RuntimeServices> {
  if (typeof options.inboxFactory !== 'function') {
    throw new Error('An explicit daemon inbox factory is required until built-in provider composition is restored.');
  }
  const { services, handlerOptions } = await createRuntimeBaseServices(options);
  const scope = createDisposalScope('Daemon runtime acquisition');
  scope.registry.add('runtime graph', services.close);
  const distributedRuntimeReady = services.distributedRuntime.start();
  // Own the in-flight initialization even if an earlier surface fails before
  // the borrowed remote registration is acquired and awaits it.
  scope.registry.add('distributed runtime startup and writes', async () => {
    await Promise.allSettled([distributedRuntimeReady]);
    await services.distributedRuntime.writes.drain();
  });
  void distributedRuntimeReady.catch(() => {});
  try {
    const daemonHandlers = await createDaemonHandlerComposition({ ...handlerOptions, distributedRuntimeReady });
    scope.registry.add('daemon handler surfaces', daemonHandlers.close);
    await resumeContracts(services.contractRunner, services.workingDirectory);
    return { ...services, daemonHandlers, close: scope.close, dispose: scope.dispose };
  } catch (startupError) {
    try { await scope.close(); }
    catch (cleanupError) { throw new AggregateError([startupError, cleanupError], 'Daemon runtime startup and cleanup failed'); }
    throw startupError;
  }
}
