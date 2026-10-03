import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { evaluateSessionMaintenance, formatSessionMaintenanceLines } from '@/runtime/index.ts';
import { estimateConversationTokens } from '@goodvibes-jev/engine/sdk/platform/core';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { buildSetupReviewSnapshot } from './local-setup-review.ts';
import { describeApprovalsUnavailable } from '../../runtime/client/approvals-view.ts';
import { buildProviderAccountSnapshot } from '../../runtime/provider-account-snapshot.ts';
import { getSettingsControlPlaneSnapshot } from '@/runtime/index.ts';
import { checkRecoveryFile, readLastSessionPointer } from '@/runtime/index.ts';
import {
  requireMemoryGovernor,
  requireProvider,
  requireProviderApi,
  requireReadModels,
  requireSecretsManager,
  requireServiceRegistry,
  requireSubscriptionManager,
  requireSessionMemoryStore,
} from './runtime-services.ts';

async function loadProviderAccountSnapshot(ctx: CommandContext) {
  return await buildProviderAccountSnapshot({
    providerModels: requireProvider(ctx).providerRegistry,
    services: requireServiceRegistry(ctx),
    subscriptions: requireSubscriptionManager(ctx),
    environment: {
      hasEnvironmentVariable: (name: string) => Boolean(process.env[name]),
    },
  });
}

type HealthReadModels = ReturnType<typeof requireReadModels>;
type HealthRemoteSnapshot = ReturnType<HealthReadModels['remote']['getSnapshot']>;
type HealthRemoteSession = HealthRemoteSnapshot['supervisor']['sessions'][number];
type HealthMcpSnapshot = ReturnType<HealthReadModels['mcp']['getSnapshot']>;
type HealthMcpServer = HealthMcpSnapshot['servers'][number];
type HealthStatusValue =
  | HealthRemoteSession['transportState']
  | HealthRemoteSession['heartbeat']['status']
  | HealthMcpServer['status']
  | HealthMcpServer['schemaFreshness'];

function formatHealthStatusValue(value: HealthStatusValue): string {
  if (value === 'quarantined') return 'needs review';
  return value.replace(/[_-]+/g, ' ');
}

/**
 * `/health approvals`, the asks waiting for this owner, from the daemon's
 * record unioned with whatever this process still holds.
 *
 * Written so an unreachable host and an empty list can never print the same
 * thing. When the daemon's record was not read, the reason is the FIRST line,
 * before any rows, and the rows that follow are labelled as this process's
 * own, a person scanning the output sees the caveat before the list, not
 * after it.
 */
async function renderApprovalsHealth(ctx: CommandContext): Promise<string> {
  const view = ctx.ops.approvalsView;
  if (!view) {
    return [
      'Health Review Approvals',
      '  the approvals view is not wired in this runtime, so no list can be shown.',
      '  This is not "no approvals waiting", nothing was read.',
    ].join('\n');
  }

  const snapshot = await view.refresh();
  const unavailable = describeApprovalsUnavailable(snapshot);
  const pending = snapshot.approvals.filter((approval) => approval.status === 'pending' || approval.status === 'claimed');

  const rows = pending.map((approval) => {
    const tool = typeof approval.request?.tool === 'string' && approval.request.tool.length > 0
      ? approval.request.tool
      : 'unnamed tool';
    const session = approval.sessionId ? ` session ${approval.sessionId}` : '';
    return `  ${approval.status} ${tool}${session} (${approval.id})`;
  });

  return [
    'Health Review Approvals',
    ...(unavailable === null ? [] : [`  ${unavailable}`]),
    `  source ${snapshot.hostRecordRead ? 'connected host record + this process' : 'this process only'}`,
    // How current the list is, which is a different claim from where it came
    // from: on the push channel a transition is here the moment the daemon
    // records it; without it the list is as fresh as the last re-read.
    `  updates ${snapshot.liveUpdates ? 'live from the connected host' : 'periodic re-read (no live stream)'}`,
    `  waiting ${pending.length}`,
    `  raised in this process and not on the host ${snapshot.localOnlyCount}`,
    ...(rows.length > 0
      ? rows
      : [snapshot.hostRecordRead
        ? '  nothing is waiting on the connected host or in this process'
        : '  nothing is waiting in this process; the host was not read, so it may still hold asks']),
  ].join('\n');
}

export function registerHealthRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'health',
    aliases: ['doctor'],
    description: 'Health workspace for startup posture, connected host readiness, provider health, and Agent continuity',
    hidden: true,
    usage: '[review|setup|approvals|host|provider|accounts|auth|settings|remote|mcp|memory|continuity|maintenance|repair [domain]]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      try {

      if (sub === 'open' || sub === 'panel') {
        ctx.print('Open Agent Workspace -> Home for the workspace view, or run /health review for the compact command output.');
        return;
      }

      if (sub === 'provider') {
        const providerApi = requireProviderApi(ctx);
        const currentModel = await providerApi.getCurrentModel().catch(() => null);
        const accounts = await loadProviderAccountSnapshot(ctx);
        ctx.print([
          'Health Review Provider',
          `  selected model ${currentModel?.registryKey ?? 'unknown'}`,
          `  providers ${providerApi.listProviderIds().length}`,
          `  configured accounts ${accounts.configuredCount}`,
          `  account issues ${accounts.issueCount}`,
          ...(accounts.issueCount > 0
            ? accounts.providers.flatMap((provider) => provider.issues.map((issue) => `  ${provider.providerId} ${issue}`))
            : ['  no provider account issues detected']),
          '  next /model',
          '  next /provider',
          '  next /accounts review',
        ].join('\n'));
        return;
      }

      if (sub === 'approvals') {
        ctx.print(await renderApprovalsHealth(ctx));
        return;
      }

      const readModels = requireReadModels(ctx);

      if (sub === 'host' || sub === 'services') {
        const registry = requireServiceRegistry(ctx);
        const all = registry.getAll();
        const keys = Object.keys(all);
        const inspections = await Promise.all(keys.map((name) => registry.inspect(name)));
        const issues = inspections
          .filter((inspection): inspection is NonNullable<typeof inspection> => inspection !== null)
          .flatMap((inspection) => {
            const findings: string[] = [];
            if (!inspection.hasPrimaryCredential) findings.push(`${inspection.config.name} missing primary credential`);
            if (inspection.config.authType === 'basic' && !inspection.hasPasswordCredential) findings.push(`${inspection.config.name} missing password credential`);
            if (!inspection.config.baseUrl) findings.push(`${inspection.config.name} no baseUrl configured`);
            return findings;
          });
        ctx.print([
          'Health Review Connected Host Integrations',
          `  configured integrations ${keys.length}`,
          `  issues ${issues.length}`,
          ...(issues.length > 0 ? issues.map((issue) => `  ${issue}`) : ['  all configured host integrations passed readiness checks']),
        ].join('\n'));
        return;
      }

      if (sub === 'accounts') {
        const accounts = await loadProviderAccountSnapshot(ctx);
        ctx.print([
          'Health Review Accounts',
          `  providers ${accounts.providers.length}`,
          `  configured ${accounts.configuredCount}`,
          `  issues ${accounts.issueCount}`,
          ...accounts.providers.flatMap((provider) => {
            const findings = [
              ...provider.issues.map((issue) => `  ${provider.providerId} ${issue}`),
              ...(provider.fallbackRisk ? [`  ${provider.providerId} ${provider.fallbackRisk}`] : []),
            ];
            return findings;
          }),
        ].join('\n'));
        return;
      }

      if (sub === 'auth') {
        const auth = readModels.localAuth.getSnapshot();
        ctx.print([
          'Health Review Connected Host Auth',
          '  owner connected GoodVibes host',
          `  compatibility users visible ${auth.userCount}`,
          `  compatibility sessions visible ${auth.sessionCount}`,
          `  bootstrap file signal ${auth.bootstrapCredentialPresent ? 'present' : 'cleared'}`,
          '  Agent action review provider/subscription auth only; do not mutate connected-host auth users or bootstrap credentials.',
          ...(auth.bootstrapCredentialPresent ? ['  issue bootstrap cleanup belongs outside Agent'] : []),
        ].join('\n'));
        return;
      }

      if (sub === 'settings') {
        const settings = readModels.settings.getSnapshot();
        const issues: string[] = [];
        if (settings.conflictCount > 0) issues.push(`${settings.conflictCount} conflicting setting import(s) need review`);
        if (settings.recentFailureCount > 0) issues.push(`${settings.recentFailureCount} recent sync/managed failure(s) recorded`);
        if (settings.hasStagedManagedBundle) issues.push('pending managed settings bundle is awaiting apply or rollback');
        if (settings.managedLockCount > 0) issues.push(`${settings.managedLockCount} managed lock(s) currently enforced`);
        ctx.print([
          'Health Review Settings',
          `  available ${settings.available ? 'yes' : 'no'}`,
          `  managed locks ${settings.managedLockCount}`,
          `  conflicts ${settings.conflictCount}`,
          `  recent failures ${settings.recentFailureCount}`,
          `  pending managed bundle ${settings.hasStagedManagedBundle ? 'present' : 'none'}`,
          ...(issues.length > 0 ? issues.map((issue) => `  issue ${issue}`) : ['  no active settings-control issues detected']),
          '  next /settings',
          '  next /config <key>',
          '  next /health repair settings',
        ].join('\n'));
        return;
      }

      if (sub === 'remote') {
        const snapshot = readModels.remote.getSnapshot().supervisor;
        const issues = snapshot.sessions.flatMap((session) => {
          const lines: string[] = [];
          if (session.transportState === 'degraded' || session.transportState === 'reconnecting' || session.transportState === 'terminal_failure') {
            lines.push(`${session.runnerId} transport ${formatHealthStatusValue(session.transportState)}`);
          }
          if (session.heartbeat.status !== 'fresh') {
            lines.push(`${session.runnerId} heartbeat ${formatHealthStatusValue(session.heartbeat.status)}`);
          }
          if (session.lastError) {
            lines.push(`${session.runnerId} ${session.lastError}`);
          }
          return lines;
        });
        ctx.print([
          'Health Review Remote',
          `  sessions ${snapshot.sessions.length}`,
          `  active connections ${snapshot.activeConnections}`,
          `  degraded ${snapshot.degradedConnections}`,
          ...(issues.length > 0 ? issues.map((issue) => `  issue ${issue}`) : ['  no active remote recovery issues detected']),
          '  next /delegate <build/fix/review task> for explicit TUI build work',
          '  next repair remote build-host state outside Agent',
        ].join('\n'));
        return;
      }

      if (sub === 'memory') {
        // Live MemoryGovernor snapshot, the same data ops.memory.get serves.
        // The governor is composed and started by this runtime root
        // (runtime/services.ts, wireDaemonMemoryGovernance); a context without
        // one (an older host runtime predating memory governance) degrades to
        // the honest unavailable line below, never a fabricated snapshot.
        let snapshot: ReturnType<ReturnType<typeof requireMemoryGovernor>['snapshot']>;
        try {
          snapshot = requireMemoryGovernor(ctx).snapshot();
        } catch {
          ctx.print([
            'Health Review Memory',
            '  available: no',
            '  reason: no memory governor is running in this build (older host runtime without memory governance)',
          ].join('\n'));
          return;
        }
        ctx.print([
          'Health Review Memory',
          `  tier ${snapshot.tier}`,
          `  rss ${snapshot.rssMb} MB of ${snapshot.budgetMb} MB budget (${snapshot.usedPct}%)`,
          `  heap used ${snapshot.heapUsedMb} MB${snapshot.heapTotalMb !== undefined ? ` of ${snapshot.heapTotalMb} MB` : ''}`,
          `  expensive work ${snapshot.refusingExpensiveWork ? 'refused (critical pressure)' : 'admitted'}`,
          `  tier thresholds ${snapshot.thresholds.elevatedPct}% elevated, ${snapshot.thresholds.highPct}% high, ${snapshot.thresholds.criticalPct}% critical`,
          `  leak tripwire ${snapshot.tripwire.armed ? `ARMED (${snapshot.tripwire.rateMbPerSec} MB/s sustained ${snapshot.tripwire.sustainedSec}s)` : 'not armed'}`,
          `  caches ${snapshot.caches.length}`,
          ...snapshot.caches.map((cache) => `    ${cache.id} ${cache.entries} entries${cache.estimatedBytes !== undefined ? ` (~${Math.round(cache.estimatedBytes / 1024)} KiB)` : ''}, ${cache.name}`),
          `  paused background jobs ${snapshot.pausedJobs.length === 0 ? 'none' : snapshot.pausedJobs.join(', ')}`,
          '  next /config memory.budgetMb',
          '  next /health maintenance',
        ].join('\n'));
        return;
      }

      if (sub === 'mcp') {
        const mcp = readModels.mcp.getSnapshot();
        const issues = mcp.servers.flatMap((server) => {
          const lines: string[] = [];
          if (server.status !== 'connected' && server.status !== 'configured') {
            lines.push(`${server.name} status ${formatHealthStatusValue(server.status)}`);
          }
          if (server.schemaFreshness !== 'fresh') {
            lines.push(`${server.name} tool-definition review ${formatHealthStatusValue(server.schemaFreshness)}`);
          }
          if (server.lastError) {
            lines.push(`${server.name} ${server.lastError}`);
          }
          return lines;
        });
        ctx.print([
          'Health Review MCP',
          `  servers ${mcp.servers.length}`,
          `  connected ${mcp.connectedServerNames.length}`,
          `  tools ${mcp.availableToolCount}`,
          `  total calls ${mcp.totalCalls}`,
          `  total errors ${mcp.totalErrors}`,
          ...(issues.length > 0 ? issues.map((issue) => `  issue ${issue}`) : ['  no active MCP lifecycle issues detected']),
          '  next /mcp review',
          '  next /mcp auth-review',
          '  next /mcp repair',
        ].join('\n'));
        return;
      }

      if (sub === 'continuity') {
        const continuity = readModels.continuity.getSnapshot();
        const returnMode = String(ctx.platform.configManager.get('behavior.returnContextMode') ?? 'off');
        const issues: string[] = [];
        if (!continuity.lastSessionPointer) issues.push('no last-session pointer is recorded');
        if (continuity.recoveryFilePresent) issues.push(`recovery file present for ${continuity.sessionId || '(unknown session)'}`);
        if (returnMode === 'off') issues.push('return-context summaries are disabled');
        ctx.print([
          'Health Review Continuity',
          `  return context mode ${returnMode}`,
          `  last session pointer ${continuity.lastSessionPointer ?? 'none'}`,
          `  recovery file ${continuity.recoveryFilePresent ? 'present' : 'clear'}`,
          ...(continuity.returnContext ? [`  recovery activity ${continuity.returnContext.activityLabel}`, `  recovery status ${continuity.returnContext.statusLabel}`] : []),
          ...(issues.length > 0 ? issues.map((issue) => `  issue ${issue}`) : ['  no active session continuity issues detected']),
          '  next /session list',
          '  next /session hotspots',
        ].join('\n'));
        return;
      }

      if (sub === 'maintenance') {
        const session = readModels.session.getSnapshot();
        const providerApi = requireProviderApi(ctx);
        const currentModel = await providerApi.getCurrentModel().catch(() => null); // best-effort: null handled as unknown context window
        const llmMessages = typeof ctx.session.conversationManager.getMessagesForLLM === 'function'
          ? ctx.session.conversationManager.getMessagesForLLM()
          : [];
        const maintenance = evaluateSessionMaintenance({
          configManager: ctx.platform.configManager,
          currentTokens: estimateConversationTokens(llmMessages),
          contextWindow: currentModel?.contextWindow ?? 0,
          messageCount: llmMessages.length,
          sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
          session: session.session,
        });
        ctx.print([
          'Health Review Maintenance',
          ...formatSessionMaintenanceLines(maintenance, 'guided'),
        ].join('\n'));
        return;
      }

      if (sub === 'repair') {
        const domain = (args[1] ?? 'review').toLowerCase();
        const lines = ['Health Repair'];
        if (domain === 'settings') {
          const settings = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
          lines.push('  domain settings');
          lines.push(...(
            settings.conflicts.length > 0
              ? ['  /settings', '  /config <key>', '  host-owned managed setting repair stays external']
              : ['  no active settings repair actions suggested']
          ));
          lines.push('  verify /health settings');
        } else if (domain === 'auth') {
          lines.push('  domain auth');
          lines.push('  /auth review');
          lines.push('  /provider');
          lines.push('  /subscription providers');
          lines.push('  connected host auth users/bootstrap cleanup manage outside Agent');
          lines.push('  verify /health auth');
        } else if (domain === 'accounts') {
          lines.push('  domain accounts');
          lines.push('  /accounts review');
          lines.push('  /accounts routes <provider>');
          lines.push('  /accounts repair <provider>');
          lines.push('  /auth show <provider>');
          lines.push('  verify /health accounts');
        } else if (domain === 'host' || domain === 'services') {
          lines.push('  domain host');
          lines.push('  /health host');
          lines.push('  connected host repair belongs outside Agent');
          lines.push('  verify /health host');
        } else if (domain === 'remote') {
          lines.push('  domain remote');
          lines.push('  /delegate <build/fix/review task> for explicit TUI build work');
          lines.push('  remote build-host setup and recovery belong outside Agent');
          lines.push('  verify /health remote');
        } else if (domain === 'mcp') {
          lines.push('  domain mcp');
          lines.push('  /mcp review');
          lines.push('  /mcp auth-review');
          lines.push('  /mcp repair [server]');
          lines.push('  verify /health mcp');
        } else if (domain === 'memory') {
          lines.push('  domain memory');
          lines.push('  /health memory');
          lines.push('  /config memory.budgetMb');
          lines.push('  /config memory.hardLimitPct');
          lines.push('  tier thresholds and the leak tripwire are configurable under settings -> Memory Governance');
          lines.push('  verify /health memory');
        } else if (domain === 'continuity') {
          lines.push('  domain continuity');
          lines.push('  /session list');
          lines.push('  /session resume <id>');
          lines.push('  /session hotspots');
          lines.push('  verify /health continuity');
        } else if (domain === 'maintenance') {
          lines.push('  domain maintenance');
          lines.push('  /health maintenance');
          lines.push('  /mode');
          lines.push('  /compact');
          lines.push('  verify /health maintenance');
        } else {
          lines.push('  domains settings, auth, accounts, host, remote, mcp, memory, continuity, maintenance');
          lines.push('  use /health repair <domain>');
        }
        ctx.print(lines.join('\n'));
        return;
      }

      const session = readModels.session.getSnapshot();
      const providerApi = requireProviderApi(ctx);
      const currentModel = await providerApi.getCurrentModel().catch(() => null); // best-effort: null handled as unknown context window
      const llmMessages = typeof ctx.session.conversationManager.getMessagesForLLM === 'function'
        ? ctx.session.conversationManager.getMessagesForLLM()
        : [];
      const contextWindow = currentModel?.contextWindow ?? 0;
      const maintenance = evaluateSessionMaintenance({
        configManager: ctx.platform.configManager,
        currentTokens: estimateConversationTokens(llmMessages),
        contextWindow,
        messageCount: llmMessages.length,
        sessionMemoryCount: requireSessionMemoryStore(ctx).list().length,
        session: session.session,
      });

      const snapshot = await buildSetupReviewSnapshot(ctx);
      const accountSnapshot = await loadProviderAccountSnapshot(ctx);
      const settingsSnapshot = getSettingsControlPlaneSnapshot(ctx.platform.configManager);
      if (sub === 'setup') {
        ctx.print([
          'Health Review Setup',
          ...snapshot.issues.map((issue) => `  [${issue.severity.toUpperCase()}] ${issue.area} ${issue.message}`),
          ...(snapshot.hostIntegrationIssues.length > 0
            ? ['', '  Connected host integration issues', ...snapshot.hostIntegrationIssues.map((issue) => `    - ${issue}`)]
            : []),
        ].join('\n'));
        return;
      }

      ctx.print([
        'Health Review',
        `  session ${snapshot.sessionId}`,
        `  setup issues ${snapshot.issues.length}`,
        `  host integration issues ${snapshot.hostIntegrationIssues.length}`,
        `  active subscriptions ${snapshot.activeSubscriptionCount}`,
        `  account issues ${accountSnapshot.issueCount}`,
        `  settings conflicts ${settingsSnapshot.conflicts.length}`,
        `  managed locks ${settingsSnapshot.managedLockCount}`,
        `  connected host auth owner outside Agent`,
        ...formatSessionMaintenanceLines(maintenance, 'guided').map((line) => `  ${line}`),
        ...(snapshot.issues.length > 0 ? ['', ...snapshot.issues.map((issue) => `  [${issue.severity.toUpperCase()}] ${issue.area} ${issue.message}`)] : []),
        ...(snapshot.hostIntegrationIssues.length > 0 ? ['', ...snapshot.hostIntegrationIssues.map((issue) => `  host integration ${issue}`)] : []),
        '',
        'Next steps',
        '  /health review',
        '  /health approvals',
        '  /health host',
        '  /health accounts',
        '  /health auth',
        '  /health settings',
        '  /health memory',
        '  /health maintenance',
        '  /health repair <domain>',
        '  /setup',
      ].join('\n'));
      } catch (error) {
        ctx.print(`Health command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
}
