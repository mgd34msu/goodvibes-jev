import { captureSecretsReadSource, captureSubscriptionReadSource, captureServiceReadSource, listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import { retainCliConfig } from '@goodvibes-jev/engine/terminal-shell';
import type { CommandContext } from '../input/command-registry.ts';
import { requireShellPaths } from '../input/commands/runtime-services.ts';
import { setupWizardCheckpointPath } from '../agent/setup-wizard-checkpoint.ts';
import { getOnboardingRuntimeStatePath, getOnboardingCheckMarkerPath, getOnboardingCompletionMarkerPath } from '../runtime/onboarding/index.ts';
import { captureCatalogMethods, captureCatalogSnapshot } from './agent-harness-catalog-ranking.ts';
import { setupSmokeArtifactStore } from './agent-harness-setup-posture-utils.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogContextPaths, captureCatalogFile } from './agent-harness-stateful-catalog-source.ts';

const nativeDateRoot = globalThis;
const nativeOwnDescriptor = Object.getOwnPropertyDescriptor;
const initialDateDescriptor = nativeOwnDescriptor(nativeDateRoot, 'Date');
const nativeDate: DateConstructor | undefined = initialDateDescriptor && 'value' in initialDateDescriptor ? initialDateDescriptor.value : undefined;

/** Original native setup sources; this guard never calls an outer invocation callback. */
export function captureSetupReadSource(context: CommandContext): () => void {
  const guards: (() => void)[] = [];
  const assertCurrent = () => { for (const guard of guards) guard(); };
  const retain = (guard: () => void) => { assertCurrent(); guard(); guards.push(guard); assertCurrent(); };
  retain(captureCatalogContextPaths(context, [
    ['platform', 'configManager'], ['workspace', 'shellPaths', 'workingDirectory'], ['workspace', 'shellPaths', 'homeDirectory'],
    ['workspace', 'shellPaths', 'resolveUserPath'], ['workspace', 'shellPaths', 'resolveProjectPath'],
    ['platform', 'subscriptionManager', 'list'], ['platform', 'subscriptionManager', 'listPending'], ['platform', 'subscriptionManager', 'captureReadSource'],
    ['platform', 'secretsManager', 'inspect'], ['platform', 'secretsManager', 'listDetailed'], ['platform', 'secretsManager', 'captureReadSource'],
    ['platform', 'localUserAuthManager', 'inspect'], ['platform', 'serviceRegistry', 'getAll'], ['platform', 'serviceRegistry', 'inspect'], ['platform', 'serviceRegistry', 'captureReadSource'],
    ['platform', 'surfaceRegistry', 'syncConfiguredSurfaces'], ['platform', 'artifactStore', 'list'],
    ['provider', 'providerRegistry', 'listModels'], ['provider', 'providerRegistry', 'captureProviderCatalogIds'], ['clients', 'agentKnowledgeApi'], ['extensions', 'toolRegistry'],
  ]));
  const config = retainCliConfig(context.platform.configManager);
  retain(config.assertCurrent);
  const shellPaths = requireShellPaths(context);
  for (const path of [setupWizardCheckpointPath(shellPaths), getOnboardingRuntimeStatePath(shellPaths, 'project'),
    getOnboardingCheckMarkerPath(shellPaths, 'user'), getOnboardingCompletionMarkerPath(shellPaths, 'user')]) retain(captureCatalogFile(path));
  const secrets = context.platform.secretsManager;
  if (secrets) retain(captureSecretsReadSource(secrets));
  const auth = context.platform.localUserAuthManager;
  if (auth) {
    const original = auth.inspect(), snapshot = captureCatalogSnapshot(original);
    retain(captureCatalogFile(original.userStorePath));
    retain(captureCatalogFile(original.bootstrapCredentialPath));
    retain(() => { snapshot.assertCurrent(auth.inspect()); });
  }
  const subscriptions = context.platform.subscriptionManager;
  if (subscriptions) {
    retain(captureSubscriptionReadSource(subscriptions));
    const active = captureCatalogSnapshot(subscriptions.list()), pending = captureCatalogSnapshot(subscriptions.listPending());
    retain(() => { active.assertCurrent(subscriptions.list()); pending.assertCurrent(subscriptions.listPending()); });
  }
  const services = context.platform.serviceRegistry;
  if (services) {
    retain(captureServiceReadSource(services));
    const records = captureCatalogSnapshot(services.getAll());
    retain(() => { records.assertCurrent(services.getAll()); });
  }
  const models = context.provider.providerRegistry;
  const modelOwner = models.captureProviderCatalogIds();
  const modelOwnerCurrent = captureCatalogMethods(modelOwner, ['assertCurrent']);
  retain(() => { modelOwnerCurrent(); modelOwner.assertCurrent(); modelOwnerCurrent(); });
  const listModels = models.listModels, modelRows = captureCatalogSnapshot(listModels.call(models));
  retain(() => { modelRows.assertCurrent(listModels.call(models)); });
  const serviceRows = services ? captureCatalogSnapshot(services.getAll()) : undefined;
  const active = subscriptions ? captureCatalogSnapshot(subscriptions.list()) : undefined;
  const pending = subscriptions ? captureCatalogSnapshot(subscriptions.listPending()) : undefined;
  const environment = process.env, processCurrent = captureCatalogMethods(process, ['env']);
  const originalDate = nativeOwnDescriptor(nativeDateRoot, 'Date');
  if (typeof nativeDate !== 'function' || !originalDate || !('value' in originalDate) || originalDate.value !== nativeDate) throw new ToolInputProjectionError('held');
  const globalClockCurrent = () => {
    const current = nativeOwnDescriptor(nativeDateRoot, 'Date');
    if (!current || !('value' in current) || current.value !== nativeDate
      || current.enumerable !== originalDate.enumerable || current.configurable !== originalDate.configurable
      || current.writable !== originalDate.writable) throw new ToolInputProjectionError('held');
  };
  const clock = nativeDate, clockCurrent = captureCatalogMethods(clock, ['now']), now = clock.now;
  globalClockCurrent(); clockCurrent();
  const capturedAt = now.call(clock);
  const expirationPhase = (expiresAt: number | undefined) => {
    globalClockCurrent(); clockCurrent();
    const observed = now.call(clock);
    if (observed < capturedAt) throw new ToolInputProjectionError('held');
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return 'unspecified';
    return expiresAt <= observed ? 'expired' : expiresAt <= observed + 24 * 60 * 60 * 1000 ? 'expiring' : 'healthy';
  };
  const expirations = (active?.captured ?? []).map(entry => ({ expiresAt: entry.expiresAt, phase: expirationPhase(entry.expiresAt) }));
  const serviceValues = Object.values(serviceRows?.captured ?? {});
  const providerIds = new Set([
    ...modelRows.captured.map(model => model.provider), ...serviceValues.map(service => service.providerId ?? service.name),
    ...(active?.captured ?? []).map(entry => entry.provider), ...(pending?.captured ?? []).map(entry => entry.provider),
    ...listBuiltinSubscriptionProviders().map(entry => entry.provider),
  ]);
  const presence = new Map<string, boolean>();
  for (const providerId of providerIds) {
    const service = serviceValues.find(entry => (entry.providerId ?? entry.name) === providerId);
    const keys = new Set<string>(service?.tokenKey ? [service.tokenKey] : []);
    for (const model of modelRows.captured.filter(entry => entry.provider === providerId)) {
      const raw: unknown = Object.getOwnPropertyDescriptor(model, 'providerEnvVars')?.value;
      if (Array.isArray(raw)) for (const key of raw) if (typeof key === 'string' && key.trim().length > 0) keys.add(key);
    }
    const normalized = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (normalized) { keys.add(`${normalized}_API_KEY`); keys.add(`${normalized}_KEY`); }
    for (const key of keys) presence.set(key, Boolean(environment[key]));
  }
  retain(() => {
    processCurrent(); globalClockCurrent(); clockCurrent();
    if (process.env !== environment) throw new ToolInputProjectionError('held');
    for (const [key, present] of presence) if (Boolean(environment[key]) !== present) throw new ToolInputProjectionError('held');
    for (const entry of expirations) if (expirationPhase(entry.expiresAt) !== entry.phase) throw new ToolInputProjectionError('held');
  });
  const artifactStore = setupSmokeArtifactStore(context);
  if (artifactStore?.list) {
    const listCurrent = captureCatalogMethods(artifactStore, ['list']), list = artifactStore.list;
    const records = captureCatalogSnapshot(list.call(artifactStore, 100));
    retain(() => { listCurrent(); records.assertCurrent(list.call(artifactStore, 100)); listCurrent(); });
  }
  assertCurrent(); return assertCurrent;
}
