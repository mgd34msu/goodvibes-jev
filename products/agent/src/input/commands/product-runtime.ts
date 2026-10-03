import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireReadModels, requireSecretsManager, requireServiceRegistry, requireShellPaths } from './runtime-services.ts';
import { requireYesFlag, stripYesFlag } from './confirmation.ts';

interface TrustReviewBundle {
  readonly version: 1;
  readonly capturedAt: number;
  readonly permissionMode: string;
  readonly secretKeys: readonly string[];
  readonly serviceNames: readonly string[];
  readonly pluginSummary: {
    readonly total: number;
    readonly trusted: number;
    readonly limited: number;
    readonly untrusted: number;
    readonly quarantined: number;
  };
  readonly mcpSummary: {
    readonly total: number;
    readonly constrained: number;
    readonly askOnRisk: number;
    readonly allowAll: number;
    readonly blocked: number;
    readonly quarantined: number;
  };
}

function countByMode<T extends string>(values: readonly T[], mode: T): number {
  return values.filter((value) => value === mode).length;
}

function buildTrustReviewBundle(ctx: CommandContext): Promise<TrustReviewBundle> {
  return (async () => {
    const secretKeys = await requireSecretsManager(ctx).list();
    const services = Object.keys(requireServiceRegistry(ctx).getAll()).sort((a, b) => a.localeCompare(b));
    const security = requireReadModels(ctx).security.getSnapshot();
    const plugins = security.plugins;
    const mcpServers = security.mcpServers;
    return {
      version: 1,
      capturedAt: Date.now(),
      permissionMode: String(ctx.platform.configManager.get('permissions.mode')),
      secretKeys,
      serviceNames: services,
      pluginSummary: {
        total: plugins.length,
        trusted: plugins.filter((plugin) => plugin.trustTier === 'trusted').length,
        limited: plugins.filter((plugin) => plugin.trustTier === 'limited').length,
        untrusted: plugins.filter((plugin) => plugin.trustTier === 'untrusted').length,
        quarantined: plugins.filter((plugin) => plugin.quarantined).length,
      },
      mcpSummary: {
        total: mcpServers.length,
        constrained: countByMode(mcpServers.map((server) => server.trustMode), 'constrained'),
        askOnRisk: countByMode(mcpServers.map((server) => server.trustMode), 'ask-on-risk'),
        allowAll: countByMode(mcpServers.map((server) => server.trustMode), 'allow-all'),
        blocked: countByMode(mcpServers.map((server) => server.trustMode), 'blocked'),
        quarantined: mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length,
      },
    };
  })();
}

function formatTrustReview(bundle: TrustReviewBundle): string {
  return [
    'Trust Review',
    `  permission mode: ${bundle.permissionMode}`,
    `  secrets stored: ${bundle.secretKeys.length}`,
    `  configured integrations: ${bundle.serviceNames.length}`,
    `  plugins: ${bundle.pluginSummary.total} (trusted ${bundle.pluginSummary.trusted}, limited ${bundle.pluginSummary.limited}, untrusted ${bundle.pluginSummary.untrusted}, quarantined ${bundle.pluginSummary.quarantined})`,
    `  MCP servers: ${bundle.mcpSummary.total} (constrained ${bundle.mcpSummary.constrained}, ask-on-risk ${bundle.mcpSummary.askOnRisk}, allow-all ${bundle.mcpSummary.allowAll}, blocked ${bundle.mcpSummary.blocked}, quarantined ${bundle.mcpSummary.quarantined})`,
  ].join('\n');
}

function inspectTrustBundle(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as TrustReviewBundle;
  return [
    'Trust Bundle Review',
    `  captured: ${new Date(parsed.capturedAt).toISOString()}`,
    `  permission mode: ${parsed.permissionMode}`,
    `  secrets stored: ${parsed.secretKeys.length}`,
    `  configured integrations: ${parsed.serviceNames.length}`,
    `  plugins: ${parsed.pluginSummary.total}`,
    `  MCP servers: ${parsed.mcpSummary.total}`,
  ].join('\n');
}

export function registerProductRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'trust',
    description: 'Review trust posture and export portable trust bundles',
    hidden: true,
    usage: '[review|bundle export <path> --yes|bundle inspect <path>]',
    async handler(args, ctx) {
      const parsed = stripYesFlag(args);
      const commandArgs = [...parsed.rest];
      const shellPaths = requireShellPaths(ctx);
      const sub = commandArgs[0] ?? 'review';
      if (sub === 'review') {
        const bundle = await buildTrustReviewBundle(ctx);
        ctx.print(formatTrustReview(bundle));
        return;
      }
      if (sub === 'bundle') {
        const mode = commandArgs[1];
        const pathArg = commandArgs[2];
        if ((mode === 'export' || mode === 'inspect') && !pathArg) {
          ctx.print(`Usage: /trust bundle ${mode} <path>${mode === 'export' ? ' --yes' : ''}`);
          return;
        }
        if (mode === 'export') {
          if (!parsed.yes) {
            requireYesFlag(ctx, `export trust bundle to ${pathArg}`, '/trust bundle export <path> --yes');
            return;
          }
          const bundle = await buildTrustReviewBundle(ctx);
          const targetPath = shellPaths.resolveWorkspacePath(pathArg!);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
          ctx.print(`Trust bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          try {
            ctx.print(inspectTrustBundle(shellPaths.resolveWorkspacePath(pathArg!)));
          } catch (error) {
            ctx.print(`Could not read that bundle file: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
      }
      ctx.print('Usage: /trust [review|bundle export <path> --yes|bundle inspect <path>]');
    },
  });
}
