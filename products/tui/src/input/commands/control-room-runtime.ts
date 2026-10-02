import type { CommandRegistry } from '../command-registry.ts';
import { buildMcpAttackPathReview } from '@/runtime/index.ts';
import { buildKnowledgeInjectionPrompt, selectKnowledgeForTask } from '@goodvibes-jev/engine/sdk/platform/state';
import { listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/sdk/platform/config';
import { requireReadModels, requireSubscriptionManager, requireTokenAuditor } from './runtime-services.ts';
import { getMemoryApi, getMemorySpine } from './recall-query.ts';

export function registerControlRoomRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'cockpit',
    aliases: [],
    description: 'Open Agents (the old operator cockpit)',
    handler(_args, ctx) {
      if (ctx.openCockpitView) {
        ctx.openCockpitView();
        return;
      }
      ctx.print('The Agents view is not available in this runtime.');
    },
  });

  registry.register({
    name: 'orchestration',
    aliases: ['orch'],
    description: 'Inspect contracts and cancel legacy agent graphs or subtrees',
    usage: '[show [contractId] | cancel graph <graphId> | cancel subtree <agentId>]',
    handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.openOrchestrationView) {
          ctx.openOrchestrationView();
          return;
        }
      }
      const subcommand = args[0]?.toLowerCase() ?? 'show';

      if (subcommand === 'show') {
        const contracts = requireReadModels(ctx).contracts.getSnapshot().contracts;
        const contractId = args[1];
        const contract = contractId ? contracts.find((entry) => entry.id === contractId) : contracts[0];
        if (!contract) {
          ctx.print(contractId ? `Unknown contract: ${contractId}` : 'No contracts recorded yet.');
          return;
        }
        const lines = [
          `Contract ${contract.id}`,
          `  request: ${contract.ask}`,
          `  status: ${contract.status}`,
          `  groups: ${contract.groups.size}`,
          `  units: ${contract.units.size}`,
        ];
        for (const unit of [...contract.units.values()].slice(0, 12)) {
          lines.push(`  - ${unit.id} ${unit.role ?? 'unit'} ${unit.status}${unit.title ? ` ${unit.title}` : ''}`);
        }
        if (contract.reason) lines.push(`  reason: ${contract.reason}`);
        lines.push(`  manage: /workstream status ${contract.id}`);
        ctx.print(lines.join('\n'));
        return;
      }

      if (subcommand === 'cancel') {
        const mode = args[1]?.toLowerCase();
        const target = args[2];
        const manager = ctx.ops.agentManager;
        if (!manager) {
          ctx.print('Agent manager is not available in this runtime.');
          return;
        }
        if (!mode || !target) {
          ctx.print('Usage: /orchestration cancel graph <graphId> | /orchestration cancel subtree <agentId>');
          return;
        }
        if (mode === 'graph') {
          const cancelled = manager.cancelGraph(target);
          ctx.print(cancelled.length > 0
            ? `Cancelled ${cancelled.length} agent${cancelled.length !== 1 ? 's' : ''} in graph ${target}.`
            : `No cancellable agents found in graph ${target}.`);
          return;
        }
        if (mode === 'subtree') {
          const cancelled = manager.cancelSubtree(target);
          ctx.print(cancelled.length > 0
            ? `Cancelled ${cancelled.length} agent${cancelled.length !== 1 ? 's' : ''} in subtree rooted at ${target}.`
            : `No cancellable agents found in subtree rooted at ${target}.`);
          return;
        }
        ctx.print(`Unknown orchestration cancel target: ${mode}`);
        return;
      }

      ctx.print(`Unknown orchestration subcommand: ${subcommand}`);
    },
  });

  registry.register({
    name: 'communication',
    aliases: ['comms'],
    description: 'Inspect structured agent communication routes and recent activity',
    handler(_args, ctx) {
      if (ctx.openCommunicationView) {
        ctx.openCommunicationView();
        return;
      }
      ctx.print('The Agents view is not available in this runtime.');
    },
  });

  registry.register({
    name: 'security',
    aliases: [],
    description: 'Inspect security posture, attack paths, and review state',
    usage: '[review | attack-paths | tokens]',
    handler(args, ctx) {
      if (args.length === 0) {
        if (ctx.openSecurityView) {
          ctx.openSecurityView();
          return;
        }
        ctx.print('The Security view is not available in this runtime.');
        return;
      }

      const subcommand = args[0]?.toLowerCase() ?? 'review';
      const audit = requireTokenAuditor(ctx).auditAll(Date.now());
      const securitySnapshot = requireReadModels(ctx).security.getSnapshot();
      const policySnapshot = ctx.extensions.policyRuntimeState?.getSnapshot();
      if (!policySnapshot) {
        ctx.print('Policy runtime state is not available in this runtime.');
        return;
      }
      const attackPaths = buildMcpAttackPathReview({
        servers: securitySnapshot.mcpServers,
        recentDecisions: securitySnapshot.recentMcpDecisions,
      });

      if (subcommand === 'tokens') {
        if (audit.results.length === 0) {
          ctx.print('No registered API tokens are currently under audit.');
          return;
        }
        ctx.print([
          `Token Audit (${audit.results.length})`,
          ...audit.results.map((result) => (
            `  ${result.label}  policy=${result.scope.policyId}  scope=${result.scope.outcome}  rotation=${result.rotation.outcome}  blocked=${result.blocked ? 'yes' : 'no'}`
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
          `MCP Attack-Path Review`,
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

  registry.register({
    name: 'project-memory',
    aliases: ['pmem'],
    description: 'Inspect durable project memory: risks, runbooks, and architecture notes',
    usage: '[open | queue [limit] | explain <task...> [--scope <path> ...]]',
    async handler(args, ctx) {
      const subcommand = (args[0] ?? 'open').toLowerCase();
      if (subcommand === 'open') {
        if (ctx.openMemoryView) {
          ctx.openMemoryView();
          return;
        }
        ctx.print('The Memory view is not available in this runtime.');
        return;
      }
      if (subcommand === 'queue') {
        // Repointed onto the memory spine (SDK 1.2.0 full-detach) so the
        // queue reflects the daemon's own canonical store when adopted.
        const memory = getMemorySpine(ctx);
        if (!memory) return;
        const limit = Math.max(1, parseInt(args[1] ?? '10', 10) || 10);
        const queue = await memory.reviewQueue(limit);
        if (queue.length === 0) {
          ctx.print('Knowledge review queue is empty.');
          return;
        }
        ctx.print([
          `Knowledge Review Queue (${queue.length})`,
          ...queue.map((record) => `  ${record.id}  [${record.scope}/${record.cls}] ${record.reviewState} ${record.confidence}%  ${record.summary}`),
        ].join('\n'));
        return;
      }
      if (subcommand === 'explain') {
        // Stays on the local MemoryApi: `explain` is a host-side projection
        // over whatever read surface is active, not a store operation
        // (docs/decisions/2026-07-06-memory-wire-full-detach.md, SDK repo).
        const memory = getMemoryApi(ctx);
        if (!memory) return;
        const scopeIdx = args.indexOf('--scope');
        const scopeValues = scopeIdx !== -1
          ? args.slice(scopeIdx + 1).filter((token) => !token.startsWith('--'))
          : [];
        const taskTokens = args.slice(1).filter((token, index) => {
          if (token === '--scope') return false;
          if (scopeIdx !== -1 && index + 1 > scopeIdx) return false;
          return true;
        });
        const task = taskTokens.join(' ').trim();
        if (!task) {
          ctx.print('Usage: /project-memory explain <task...> [--scope <path> ...]');
          return;
        }
        const injections = await selectKnowledgeForTask(memory, task, scopeValues);
        const prompt = buildKnowledgeInjectionPrompt(injections);
        ctx.print(prompt ?? 'No reviewed project knowledge matched that task.');
        return;
      }
      if (ctx.openMemoryView) {
        ctx.openMemoryView();
        return;
      }
      ctx.print(`Unknown project-memory subcommand: ${subcommand}`);
    },
  });
}
