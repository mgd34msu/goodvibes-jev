import { statSync } from 'node:fs';
import { buildProviderAccountSnapshot } from '../runtime/provider-account-snapshot.ts';
import { requireLocalUserAuthManager, requirePlatform, requireProvider, requireSecretsManager, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from '../input/commands/runtime-services.ts';
import { collectOnboardingSnapshot } from '../runtime/onboarding/index.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { buildCliServicePosture, type CliServicePosture } from '../cli/service-posture.ts';
import type { AgentHarnessSetupArgs, SetupLookupSource, SetupPlanStatus, SurfaceRegistryLike, SetupSmokeArtifactStore } from './agent-harness-setup-posture-types.ts';
import type { OnboardingStep1CapabilityItem } from '../runtime/onboarding/index.ts';

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map((entry) => readString(entry)).filter(Boolean) : [];
}

export function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

export function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

export function quoteRouteValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function operatorMethodRoute(methodId: string, confirmed: boolean): string {
  return `agent_operator_method methodId:"${quoteRouteValue(methodId)}" input:{}${confirmed ? ' confirm:true explicitUserRequest:"..."' : ''}`;
}

export function safeIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

export function provisionConnectedHostTokenRoute(): string {
  return 'setup action:"token" setupItemId:"connected-host-auth" confirm:true explicitUserRequest:"..."';
}

export function safeFileMode(path: string): string | null {
  try {
    return `0${(statSync(path).mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}

export function setupSmokeArtifactStore(context: CommandContext): SetupSmokeArtifactStore | null {
  const candidate = (context.platform as { readonly artifactStore?: unknown }).artifactStore;
  if (candidate && typeof candidate === 'object') {
    return candidate as SetupSmokeArtifactStore;
  }
  return null;
}

export function surfaceRegistry(context: CommandContext): SurfaceRegistryLike | undefined {
  const candidate = (context.platform as { readonly surfaceRegistry?: unknown }).surfaceRegistry;
  if (candidate && typeof candidate === 'object' && 'syncConfiguredSurfaces' in candidate) {
    return candidate as SurfaceRegistryLike;
  }
  return undefined;
}

export function setupServiceRuntime(context: CommandContext) {
  const shellPaths = requireShellPaths(context);
  return {
    configManager: requirePlatform(context).configManager,
    workingDirectory: shellPaths.workingDirectory,
    homeDirectory: shellPaths.homeDirectory,
  };
}

export async function collectServicePosture(context: CommandContext): Promise<CliServicePosture | null> {
  try {
    return await buildCliServicePosture(setupServiceRuntime(context), {
      probe: true,
      logTailBytes: 0,
    });
  } catch {
    return null;
  }
}

export async function collectSnapshot(context: CommandContext) {
  const registry = surfaceRegistry(context);
  return await collectOnboardingSnapshot({
    config: requirePlatform(context).configManager,
    shellPaths: requireShellPaths(context),
    acknowledgementScope: 'project',
    subscriptions: requireSubscriptionManager(context),
    secrets: requireSecretsManager(context),
    auth: requireLocalUserAuthManager(context),
    services: requireServiceRegistry(context),
    ...(registry ? {
      surfaces: {
        list: () => registry.syncConfiguredSurfaces(),
      },
    } : {}),
    providerAccounts: {
      loadSnapshot: () => buildProviderAccountSnapshot({
        providerModels: requireProvider(context).providerRegistry,
        services: requireServiceRegistry(context),
        subscriptions: requireSubscriptionManager(context),
        environment: {
          hasEnvironmentVariable: (name: string) => Boolean(process.env[name]),
        },
      }),
    },
  });
}

export function lookupFromArgs(args: AgentHarnessSetupArgs): { readonly source: SetupLookupSource; readonly input: string } | null {
  const setupItemId = readString(args.setupItemId);
  if (setupItemId) return { source: 'setupItemId', input: setupItemId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

export function itemSearchText(item: OnboardingStep1CapabilityItem): string {
  return [
    item.id,
    item.label,
    item.detail,
    item.selected ? 'selected ready configured enabled' : 'optional attention unselected',
  ].join('\n').toLowerCase();
}
export function summarizeLocalBehavior(snapshot: Awaited<ReturnType<typeof collectSnapshot>>): Record<string, unknown> {
  const discovery = snapshot.localBehaviorDiscovery;
  return {
    personas: discovery.personas,
    skills: discovery.skills,
    routines: discovery.routines,
  };
}

export function setupProviderSignalIds(snapshot: Awaited<ReturnType<typeof collectSnapshot>>): readonly string[] {
  return [...new Set<string>([
    ...(snapshot.providerAccounts?.providers ?? [])
      .filter((provider) => provider.activeRoute !== 'unconfigured' || provider.oauthReady || provider.pendingLogin)
      .map((provider) => provider.providerId),
    ...snapshot.services.oauthProviderIds,
    ...snapshot.services.services
      .filter((service) => service.hasPrimaryCredential || service.hasPasswordCredential)
      .map((service) => service.providerId),
    ...snapshot.subscriptions.activeProviderIds,
    ...snapshot.subscriptions.pendingProviderIds,
  ])].sort((left, right) => left.localeCompare(right));
}

export function capabilityById(items: readonly OnboardingStep1CapabilityItem[], id: OnboardingStep1CapabilityItem['id']): OnboardingStep1CapabilityItem {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Missing onboarding capability ${id}`);
  return item;
}

export function setupPlanStatusForCapability(
  item: OnboardingStep1CapabilityItem,
  fallback: Exclude<SetupPlanStatus, 'check' | 'ready'>,
): SetupPlanStatus {
  return item.selected ? 'ready' : fallback;
}
