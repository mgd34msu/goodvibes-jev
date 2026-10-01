import type { CommandRegistry } from '../command-registry.ts';
import { buildMcpAttackPathReview } from '@/runtime/index.ts';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import { requireReadModels, requireSubscriptionManager, requireTokenAuditor } from './runtime-services.ts';

export function registerSecurityRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'security',
    aliases: [],
    description: 'Inspect security posture, attack paths, and review state',
    hidden: true,
    usage: '[review | attack-paths | tokens]',
    handler(args, ctx) {
      const subcommand = args[0]?.toLowerCase() ?? 'review';
      if (subcommand === 'open' || subcommand === 'panel') {
        ctx.print('Open Agent Workspace -> Tools & Permissions for permission settings, or run /security review for the security report.');
        return;
      }
      const audit = requireTokenAuditor(ctx).auditAll(Date.now());
      const securitySnapshot = requireReadModels(ctx).security.getSnapshot();
      const policySnapshot = ctx.extensions.policyRuntimeState?.getSnapshot();
      if (!policySnapshot) {
        ctx.print('Policy state is not available in this Agent session.');
        return;
      }
      const attackPaths = buildMcpAttackPathReview({
        servers: securitySnapshot.mcpServers,
        recentDecisions: securitySnapshot.recentMcpDecisions,
      });

      if (subcommand === 'tokens') {
        if (audit.results.length === 0) {
          ctx.print('No registered API tokens are currently available for security review.');
          return;
        }
        ctx.print([
          `Token Review (${audit.results.length})`,
          ...audit.results.map((result) => (
            `  ${result.label}  policy ${result.scope.policyId}  scope ${result.scope.outcome}  rotation ${result.rotation.outcome}  blocked ${result.blocked ? 'yes' : 'no'}`
          )),
        ].join('\n'));
        return;
      }

      if (subcommand === 'attack-paths') {
        if (attackPaths.findings.length === 0) {
          ctx.print('No MCP attack-path findings are currently active.');
          return;
        }
        ctx.print([
          'MCP Attack-Path Review',
          `  summary: ${attackPaths.summary}`,
          ...attackPaths.findings.slice(0, 12).map((finding) => (
            `  ${finding.severity.toUpperCase()} ${finding.serverName}  ${finding.route}\n    ${finding.reason}`
          )),
        ].join('\n'));
        return;
      }

      const plugins = ctx.extensions.pluginManager?.list() ?? [];
      const subscriptions = requireSubscriptionManager(ctx);
      const builtinProviders = listBuiltinSubscriptionProviders();
      ctx.print([
        'Security Review',
        `  tokens: ${audit.results.length}`,
        `  blocked tokens: ${audit.blocked.length}`,
        `  scope violations: ${audit.scopeViolations.length}`,
        `  rotation overdue: ${audit.rotationOverdue.length}`,
        `  rotation warnings: ${audit.rotationWarnings.length}`,
        `  built-in subscription providers: ${builtinProviders.length}`,
        `  active subscriptions: ${subscriptions.list().length}`,
        `  pending subscriptions: ${subscriptions.listPending().length}`,
        `  policy lint findings: ${policySnapshot.lintFindings.length}`,
        `  policy preflight: ${policySnapshot.lastPreflightReview?.status ?? 'n/a'}`,
        `  mcp servers: ${securitySnapshot.mcpServers.length}`,
        `  mcp quarantined: ${securitySnapshot.mcpServers.filter((server) => server.schemaFreshness === 'quarantined').length}`,
        `  mcp elevated: ${securitySnapshot.mcpServers.filter((server) => server.trustMode === 'allow-all').length}`,
        `  mcp attack-path findings: ${attackPaths.findings.length}`,
        `  quarantined plugins: ${plugins.filter((plugin) => plugin.quarantined).length}`,
        `  untrusted plugins: ${plugins.filter((plugin) => plugin.trustTier === 'untrusted').length}`,
      ].join('\n'));
    },
  });
}
