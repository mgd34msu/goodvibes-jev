import { existsSync, readFileSync } from 'node:fs';
import type { CommandContext } from '../command-registry.ts';
import { discoverSkills } from '../../agent/skill-discovery.ts';
import { getPluginDirectories } from '@goodvibes-jev/engine/sdk/platform/plugins';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import { requireProviderApi, requireReadModels, requireServiceRegistry, requireShellPaths, requireSubscriptionManager } from './runtime-services.ts';

export interface SetupReviewSnapshot {
  readonly sessionId: string;
  readonly providerCount: number;
  readonly serviceCount: number;
  readonly oauthProviderCount: number;
  readonly builtinSubscriptionProviderCount: number;
  readonly activeSubscriptionCount: number;
  readonly pendingSubscriptionCount: number;
  readonly hostIntegrationIssues: string[];
  readonly skillCount: number;
  readonly pluginCount: number;
  readonly quarantinedPluginCount: number;
  readonly pluginDirectories: string[];
  readonly managedHookCount: number;
  readonly managedHookChainCount: number;
  readonly mcpServerCount: number;
  readonly quarantinedMcpCount: number;
  readonly elevatedMcpCount: number;
  readonly remoteRunnerCount: number;
  readonly issues: Array<{ readonly severity: 'pass' | 'warn' | 'fail'; readonly area: string; readonly message: string }>;
  readonly services: string[];
}

export async function buildSetupReviewSnapshot(ctx: CommandContext): Promise<SetupReviewSnapshot> {
  const shellPaths = requireShellPaths(ctx);
  const serviceRegistry = requireServiceRegistry(ctx);
  const services = Object.keys(serviceRegistry.getAll()).sort((a, b) => a.localeCompare(b));
  const serviceConfigs = serviceRegistry.getAll();
  const hostIntegrationIssues: string[] = [];
  for (const name of services) {
    const inspection = await serviceRegistry.inspect(name);
    if (!inspection?.hasPrimaryCredential) {
      hostIntegrationIssues.push(`${name}: missing primary credential`);
    }
  }

  const skills = await discoverSkills(shellPaths);
  const security = requireReadModels(ctx).security.getSnapshot();
  const plugins = security.plugins;
  const mcpServers = security.mcpServers;
  const pluginDirectories = getPluginDirectories({
    cwd: shellPaths.workingDirectory,
    homeDir: shellPaths.homeDirectory,
  });
  const providerCount = (await requireProviderApi(ctx).listModels()).length;
  const remoteRunnerCount = ctx.ops.remoteRuntime?.listContracts().length ?? 0;
  const oauthProviderCount = Object.values(serviceConfigs).filter((service) => service.authType === 'oauth' && service.oauth).length;
  const builtinSubscriptionProviderCount = listBuiltinSubscriptionProviders().length;
  const subscriptionManager = requireSubscriptionManager(ctx);
  const activeSubscriptionCount = subscriptionManager.list().length;
  const pendingSubscriptionCount = subscriptionManager.listPending().length;
  const quarantinedPluginCount = plugins.filter((plugin) => plugin.quarantined).length;
  const quarantinedMcpCount = mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length;
  const elevatedMcpCount = mcpServers.filter((server) => server.trustMode === 'allow-all').length;
  const hooksPath = shellPaths.resolveProjectPath('hooks.managed.json');
  let managedHookCount = 0;
  let managedHookChainCount = 0;
  if (existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as { hooks?: unknown[]; chains?: unknown[] };
      managedHookCount = parsed.hooks?.length ?? 0;
      managedHookChainCount = parsed.chains?.length ?? 0;
    } catch {
      // Ignore malformed hook config during snapshot collection.
    }
  }

  const issues: SetupReviewSnapshot['issues'] = [
    {
      severity: providerCount > 0 ? 'pass' : 'fail',
      area: 'providers',
      message: providerCount > 0 ? `${providerCount} model(s) available` : 'no models available',
    },
    {
      severity: (services.length === 0 && oauthProviderCount === 0 && builtinSubscriptionProviderCount === 0) ? 'warn' : hostIntegrationIssues.length === 0 ? 'pass' : 'warn',
      area: 'host',
      message: (services.length === 0 && oauthProviderCount === 0 && builtinSubscriptionProviderCount === 0)
        ? 'no connected host integrations configured'
        : hostIntegrationIssues.length === 0
          ? `${services.length} host integration(s), ${oauthProviderCount + builtinSubscriptionProviderCount} oauth provider(s), ${activeSubscriptionCount} active subscription override(s)`
          : `${hostIntegrationIssues.length} host integration configuration issue(s)`,
    },
    {
      severity: quarantinedPluginCount === 0 ? 'pass' : 'warn',
      area: 'plugins',
      message: quarantinedPluginCount === 0
        ? `${plugins.length} plugin(s) discovered`
        : `${quarantinedPluginCount} plugin(s) quarantined`,
    },
    {
      severity: quarantinedMcpCount === 0 && elevatedMcpCount === 0 ? 'pass' : 'warn',
      area: 'mcp',
      message: quarantinedMcpCount > 0 || elevatedMcpCount > 0
        ? `${quarantinedMcpCount} quarantined, ${elevatedMcpCount} elevated`
        : `${mcpServers.length} server(s) known`,
    },
  ];

  return {
    sessionId: ctx.session.runtime.sessionId,
    providerCount,
    serviceCount: services.length,
    oauthProviderCount,
    builtinSubscriptionProviderCount,
    activeSubscriptionCount,
    pendingSubscriptionCount,
    hostIntegrationIssues,
    skillCount: skills.length,
    pluginCount: plugins.length,
    quarantinedPluginCount,
    pluginDirectories,
    managedHookCount,
    managedHookChainCount,
    mcpServerCount: mcpServers.length,
    quarantinedMcpCount,
    elevatedMcpCount,
    remoteRunnerCount,
    issues,
    services,
  };
}
