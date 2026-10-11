import { join } from 'node:path';
import { ConfigManager } from '../../sdk/src/platform/config/manager.js';
import { AutomationManager } from '../../sdk/src/platform/automation/manager.js';
import { AutomationJobStore } from '../../sdk/src/platform/automation/store/jobs.js';
import { AutomationRunStore } from '../../sdk/src/platform/automation/store/runs.js';
import { AutomationRouteStore } from '../../sdk/src/platform/automation/store/routes.js';
import { RouteBindingManager } from '../../sdk/src/platform/channels/index.js';
import { SharedSessionBroker } from '../../sdk/src/platform/control-plane/session-broker.js';
import type { AutomationJob, ManagedAutomationJob } from '../../sdk/src/platform/automation/jobs.js';

export function automationMutationFixture(directory: string) {
  const path = join(directory, 'jobs.json');
  const store = new AutomationJobStore(path);
  const config = new ConfigManager({ workingDir: directory, homeDir: directory, surfaceRoot: 'test-automation-mutation' });
  const routes = new RouteBindingManager({ store: new AutomationRouteStore(join(directory, 'routes.json')) });
  const broker = new SharedSessionBroker({ storePath: join(directory, 'sessions.json'), routeBindings: routes,
    agentStatusProvider: { getStatus: () => null }, messageSender: { send: () => false } });
  const manager = new AutomationManager({ configManager: config, jobStore: store, runStore: new AutomationRunStore(join(directory, 'runs.json')),
    routeBindings: routes, sessionBroker: broker, spawnTask: () => 'synthetic-local-agent', agentStatusProvider: { getStatus: () => null } });
  const create = async (name = 'Original') => managedAutomationJob(await manager.createJob({ name, prompt: 'Synthetic local reminder', schedule: { kind: 'every', intervalMs: 3_600_000 }, enabled: false }));
  return { path, store, config, routes, broker, manager, create, async close() { manager.stop(); config.stopWatchingConfigFiles(); await broker.stop(); } };
}

export function managedAutomationJob(job: AutomationJob | null | undefined): ManagedAutomationJob {
  if (!job || typeof job.mutationRevision !== 'string' || !job.mutationRevision) throw new Error('The actual manager did not return a job revision.');
  return { ...job, mutationRevision: job.mutationRevision };
}
