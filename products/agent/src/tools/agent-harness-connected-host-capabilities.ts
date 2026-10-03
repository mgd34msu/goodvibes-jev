/**
 * agent-harness-connected-host-capabilities.ts, the connected-host capability
 * map the harness serves, and the route families behind it.
 *
 * Split out of agent-harness-metadata.ts when that module passed the 800-line
 * ceiling. The seam is the subject, not the line count: everything here is
 * about what a connected host can do and which SDK operator route reaches it,
 * while what stays behind is the local command-policy table. Its sibling
 * agent-harness-connected-host-status.ts already owned the status half.
 */
import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { resolveAgentConnectedHostConnection } from '../agent/routine-schedule-promotion.ts';
import { previewHarnessText } from './agent-harness-text.ts';
import { agentHarnessModes, hostActions, settingsActions } from './agent-harness-route-format.ts';
import { operatorBriefingRoutes } from './agent-operator-briefing-tool.ts';

export type ConnectedHostCapabilityResolution =
  | { readonly status: 'found'; readonly detail: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] };

function toolIsAvailable(toolRegistry: ToolRegistry, toolName: string): boolean {
  return toolRegistry.getToolDefinitions().some((tool) => tool.name === toolName);
}

function connectedHostCapabilityModelRoute(capability: Record<string, unknown>): string {
  const modelTools = Array.isArray(capability.modelTools)
    ? capability.modelTools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  if (modelTools.length > 0) return previewHarnessText(modelTools.join(' or '));
  return 'host action:"capability"';
}

function blockedConnectedHostModelRoute(): string {
  return hostActions('services', 'status');
}

export function connectedHostCapabilityMap(toolRegistry: ToolRegistry): readonly Record<string, unknown>[] {
  const withAvailability = (capability: Record<string, unknown> & { readonly modelTools: readonly string[] }): Record<string, unknown> => ({
    ...capability,
    modelRoute: connectedHostCapabilityModelRoute(capability),
    harnessRoute: 'agent_harness mode:"connected_host_capability"',
    modelAccess: {
      inspectCapability: 'host action:"capability"',
      liveStatus: 'host action:"status"',
      endpointPosture: 'host action:"services"',
      routeFamilies: 'host action:"capabilities" includeParameters:true',
      operate: connectedHostCapabilityModelRoute(capability),
    },
    available: capability.modelTools.every((toolName) => toolIsAvailable(toolRegistry, toolName)),
  });
  return [
    withAvailability({
      id: 'operator-briefing',
      effect: 'read-only-network',
      modelTools: ['agent_operator_briefing'],
      workspaceCategories: ['home', 'work', 'host', 'automation'],
      slashCommandFamilies: ['approval', 'automation', 'schedule'],
      purpose: 'Read pending work, approvals, automation, schedules, and scheduler capacity from public operator routes.',
    }),
    withAvailability({
      id: 'operator-actions',
      effect: 'confirmed-connected-host-state',
      modelTools: ['agent_operator_action'],
      workspaceCategories: ['automation', 'host'],
      allowedActions: [
        'approvals.approve',
        'approvals.deny',
        'approvals.cancel',
        'automation.jobs.run',
        'automation.jobs.disable',
        'automation.jobs.enable',
        'automation.runs.cancel',
        'automation.runs.retry',
        'automation.schedules.delete',
        'automation.schedules.disable',
        'automation.schedules.enable',
        'automation.schedules.run',
      ],
      purpose: 'Perform one explicit allowlisted approval, automation, run, or schedule action.',
    }),
    withAvailability({
      id: 'schedule-edit',
      effect: 'confirmed-connected-host-state',
      modelTools: ['schedule', 'agent_schedule_edit'],
      workspaceCategories: ['automation', 'personal-ops'],
      slashCommandFamilies: ['schedule'],
      methodIds: ['automation.jobs.update'],
      purpose: 'Edit one explicit connected schedule name, cadence, or prompt.',
    }),
    withAvailability({
      id: 'agent-knowledge-read',
      effect: 'read-only-network',
      modelTools: ['agent_knowledge'],
      workspaceCategories: ['knowledge', 'research'],
      slashCommandFamilies: ['knowledge'],
      allowedActions: [
        'status',
        'ask',
        'search',
        'sources',
        'nodes',
        'issues',
        'item',
        'map',
        'connectors',
        'connector',
        'connector_doctor',
      ],
      purpose: 'Read isolated Agent Knowledge status, answers, search results, source/node/issue lists, items, map summaries, and connector diagnostics through the Agent route family.',
    }),
    withAvailability({
      id: 'agent-knowledge-ingest',
      effect: 'confirmed-agent-knowledge-write',
      modelTools: ['agent_knowledge_ingest'],
      workspaceCategories: ['knowledge', 'research'],
      slashCommandFamilies: ['knowledge'],
      sourceKinds: ['url', 'file', 'urls_file', 'bookmarks_file', 'browser_history', 'connector'],
      purpose: 'Ingest explicit user-approved sources into isolated Agent Knowledge.',
    }),
    withAvailability({
      id: 'channels',
      effect: 'confirmed-external-delivery',
      modelTools: ['agent_channel_send'],
      workspaceCategories: ['channels'],
      slashCommandFamilies: ['channels', 'channel'],
      targetKinds: ['channel', 'route', 'webhook', 'link'],
      purpose: 'Send one explicit message through a configured Agent delivery target.',
    }),
    withAvailability({
      id: 'notifications',
      effect: 'confirmed-external-delivery',
      modelTools: ['agent_notify'],
      workspaceCategories: ['channels'],
      slashCommandFamilies: ['notify'],
      purpose: 'Send one explicit notification using configured notification routes.',
    }),
    withAvailability({
      id: 'reminders-and-schedules',
      effect: 'confirmed-connected-host-state',
      modelTools: ['schedule', 'agent_autonomy_schedule', 'agent_reminder_schedule'],
      workspaceCategories: ['automation', 'routines'],
      slashCommandFamilies: ['schedule', 'reminder'],
      scheduleKinds: ['at', 'every', 'cron'],
      purpose: 'Create one connected reminder or autonomous Agent schedule from a direct user request.',
    }),
    withAvailability({
      id: 'voice-media',
      effect: 'provider-network-and-artifacts',
      modelTools: ['agent_media_generate'],
      workspaceCategories: ['voice-media', 'artifacts'],
      slashCommandFamilies: ['media', 'image'],
      purpose: 'Generate media through configured Agent media providers and normal artifact storage.',
    }),
  ];
}

export function connectedHostRouteFamilies(): readonly Record<string, unknown>[] {
  return [
    {
      id: 'agent-knowledge',
      prefixes: ['/api/goodvibes-agent/knowledge/*'],
      modelTools: ['agent_knowledge', 'agent_knowledge_ingest'],
      modelRoute: 'agent_knowledge or agent_knowledge_ingest',
      boundary: 'Agent-owned knowledge segment only; no fallback to default or non-Agent knowledge.',
    },
    {
      id: 'operator-read',
      // The briefing tool's own route set, not a second copy of it: this report
      // exists to tell an operator what that tool reaches, and a hand-kept list
      // beside it is a claim nothing keeps true.
      routes: operatorBriefingRoutes().map((route) => route.path),
      modelTools: ['agent_operator_briefing'],
      modelRoute: 'agent_operator_briefing',
      boundary: 'Read-only public operator briefing routes.',
    },
    {
      id: 'operator-actions',
      routes: ['public operator action methods for approvals, automation jobs, automation runs, and schedules'],
      modelTools: ['agent_operator_action'],
      modelRoute: 'agent_operator_action',
      boundary: 'Allowlisted confirmed mutations only; no arbitrary route invocation.',
    },
    {
      id: 'delivery',
      routes: ['configured channel, notification, and delivery targets'],
      modelTools: ['agent_channel_send', 'agent_notify'],
      modelRoute: 'agent_channel_send or agent_notify',
      boundary: 'Explicit user-approved delivery only. Account creation is authorized separately and is recorded in the account register, not blocked here.',
    },
    {
      id: 'connected-schedules',
      routes: ['public schedule creation, patch, run, toggle, and delete routes'],
      modelTools: ['schedule', 'agent_autonomy_schedule', 'agent_reminder_schedule', 'agent_schedule_edit', 'agent_operator_action'],
      modelRoute: 'schedule action:"list|create|remind|edit|run|pause|resume|delete"',
      boundary: 'Connected schedules only, so scheduled work stays listable and cancellable; no unregistered local scheduler.',
    },
  ];
}

function normalizeCapabilityQuery(value: string): string {
  return value.trim().toLowerCase();
}

function recordTextMatches(record: Record<string, unknown>, query: string): boolean {
  if (!query) return false;
  const values = Object.values(record).flatMap((value) => Array.isArray(value) ? value : [value]);
  return values
    .filter((value): value is string | number | boolean => (
      typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ))
    .map((value) => String(value).toLowerCase())
    .some((value) => value === query || value.includes(query));
}

function relatedConnectedHostRouteFamilies(capability: Record<string, unknown>): readonly Record<string, unknown>[] {
  const modelTools = Array.isArray(capability.modelTools)
    ? capability.modelTools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const capabilityId = typeof capability.id === 'string' ? capability.id : '';
  return connectedHostRouteFamilies().filter((family) => {
    const familyTools = Array.isArray(family.modelTools)
      ? family.modelTools.filter((tool): tool is string => typeof tool === 'string')
      : [];
    if (familyTools.some((tool) => modelTools.includes(tool))) return true;
    return capabilityId.length > 0 && recordTextMatches(family, capabilityId);
  });
}

function describeConnectedHostCapabilityCandidates(
  entries: readonly { readonly status: 'allowed' | 'blocked'; readonly capability: Record<string, unknown> }[],
): readonly Record<string, unknown>[] {
  return entries.slice(0, 8).map((entry) => ({
    status: entry.status,
    capabilityId: typeof entry.capability.id === 'string' ? entry.capability.id : '',
    purpose: typeof entry.capability.purpose === 'string' ? entry.capability.purpose : undefined,
    reason: typeof entry.capability.reason === 'string' ? entry.capability.reason : undefined,
    modelRoute: entry.status === 'allowed'
      ? connectedHostCapabilityModelRoute(entry.capability)
      : blockedConnectedHostModelRoute(),
  }));
}

function connectedHostCapabilityDetail(entry: { readonly status: 'allowed' | 'blocked'; readonly capability: Record<string, unknown> }): Record<string, unknown> {
  if (entry.status === 'allowed') {
    return {
      status: 'allowed',
      capability: entry.capability,
      modelRoute: connectedHostCapabilityModelRoute(entry.capability),
      harnessRoute: 'agent_harness mode:"connected_host_capability"',
      relatedRouteFamilies: relatedConnectedHostRouteFamilies(entry.capability),
      modelAccess: {
        inspectCapability: 'host action:"capability"',
        connectedHostInventory: 'host action:"capabilities" includeParameters:true',
        liveStatus: 'host action:"status"',
        endpointPosture: 'host action:"services"',
        operate: connectedHostCapabilityModelRoute(entry.capability),
      },
      operatorMethodMode: 'Use host action:"methods" for the public operator and Agent Knowledge method catalog. Use action:"method" for one method.',
      servicePostureMode: 'Use host action:"services" for endpoint binding, network-facing posture, issue, and redacted-log diagnostics. Use action:"service" for one endpoint.',
      statusMode: 'Use host action:"status" for live read-only reachability, token posture, and Agent Knowledge route readiness.',
      boundary: 'Use only the listed first-class model tools, slash-command families, and workspace categories. Mutations still require explicit confirmation through those tools or command routes.',
    };
  }
  return {
    status: 'blocked',
    capability: entry.capability,
    modelRoute: blockedConnectedHostModelRoute(),
    harnessRoute: 'agent_harness mode:"connected_host_capability"',
    allowed: false,
    available: false,
    modelAccess: {
      inspectCapability: 'host action:"capability"',
      connectedHostInventory: 'host action:"capabilities" includeParameters:true',
      liveStatus: 'host action:"status"',
      endpointPosture: 'host action:"services"',
      operate: 'not exposed',
    },
    boundary: 'This connected-host surface is intentionally not exposed to the model as an Agent operation.',
    servicePostureMode: 'Use host action:"services" or action:"service" only for read-only endpoint diagnostics.',
    statusMode: 'Use host action:"status" only for read-only readiness diagnostics.',
  };
}

export function describeConnectedHostCapability(
  toolRegistry: ToolRegistry,
  rawQuery: string,
): ConnectedHostCapabilityResolution | null {
  const query = normalizeCapabilityQuery(rawQuery);
  if (!query) return null;

  const entries = [
    ...connectedHostCapabilityMap(toolRegistry).map((capability) => ({ status: 'allowed' as const, capability })),
    ...blockedConnectedHostCapabilities().map((capability) => ({ status: 'blocked' as const, capability })),
  ];
  const exact = entries.find((entry) => entry.capability.id === rawQuery);
  if (exact) return { status: 'found', detail: connectedHostCapabilityDetail(exact) };
  const insensitive = entries.find((entry) => typeof entry.capability.id === 'string' && entry.capability.id.toLowerCase() === query);
  if (insensitive) return { status: 'found', detail: connectedHostCapabilityDetail(insensitive) };
  const searched = entries.filter((entry) => recordTextMatches(entry.capability, query));
  if (searched.length === 1) return { status: 'found', detail: connectedHostCapabilityDetail(searched[0]!) };
  if (searched.length > 1) return { status: 'ambiguous', input: rawQuery, candidates: describeConnectedHostCapabilityCandidates(searched) };

  return null;
}

export function connectedHostSummary(
  context: CommandContext,
  toolRegistry: ToolRegistry,
  options: { readonly includeParameters?: boolean } = {},
): Record<string, unknown> {
  const shellPaths = context.workspace.shellPaths;
  const homeDirectory = shellPaths?.homeDirectory ?? context.platform.configManager.getHomeDirectory() ?? '';
  const connection = resolveAgentConnectedHostConnection(context.platform.configManager, homeDirectory);
  const routeFamilies = connectedHostRouteFamilies();
  const capabilities = connectedHostCapabilityMap(toolRegistry);
  const blockedCapabilities = blockedConnectedHostCapabilities();
  return {
    baseUrl: connection.baseUrl,
    operatorToken: connection.token ? 'configured' : 'missing',
    tokenPath: connection.tokenPath,
    ownership: 'goodvibes-daemon',
    lifecycle: 'GoodVibes Agent can inspect daemon posture and use confirmed operator methods for supported service lifecycle/listener changes.',
    modes: {
      servicePosture: agentHarnessModes('service_posture', 'service_endpoint'),
      operatorMethods: agentHarnessModes('operator_methods', 'operator_method'),
      liveStatus: agentHarnessModes('connected_host_status'),
      capabilityDetail: agentHarnessModes('connected_host_capability'),
      daemonAliases: agentHarnessModes('daemon', 'daemon_status'),
    },
    modelRoute: hostActions('capabilities', 'capability'),
    modelAccess: {
      inventory: 'host action:"capabilities" includeParameters:true',
      liveStatus: 'host action:"status"',
      capabilityDetail: 'host action:"capability" capabilityId:"..."',
      servicePosture: 'host action:"services"',
      daemonAliases: 'agent_harness mode:"daemon" or mode:"daemon_status"',
      daemonStatusAlias: 'agent_harness mode:"daemon_status"',
      lifecycle: 'use setup or agent_operator_method with confirm:true and explicitUserRequest for supported daemon service methods.',
    },
    counts: {
      routeFamilies: routeFamilies.length,
      allowedCapabilities: capabilities.length,
      availableCapabilities: capabilities.filter((capability) => capability.available === true).length,
      blockedCapabilities: blockedCapabilities.length,
    },
    ...(options.includeParameters === true ? {
      routeFamilies,
      capabilities,
      blockedCapabilities,
    } : {}),
  };
}

export function blockedConnectedHostCapabilities(): readonly Record<string, unknown>[] {
  return [
    {
      id: 'connected-host-lifecycle',
      confirmationGated: ['start', 'stop', 'restart', 'install', 'upgrade', 'expose-listener', 'mutate-listener'],
      modelRoute: 'agent_operator_method',
      harnessRoute: 'agent_harness mode:"connected_host_capability"',
      modelAccess: {
        inspectCapability: 'host action:"capability"',
        liveStatus: 'host action:"status"',
        endpointPosture: 'host action:"services"',
        operate: 'agent_operator_method with confirm:true and explicitUserRequest when the daemon contract exposes the method',
      },
      reason: 'Lifecycle changes are powerful daemon operations. They are available only through explicit setup or confirmed operator methods, never as ambient background side effects.',
    },
    {
      id: 'non-agent-knowledge',
      blocked: ['default-knowledge', 'non-agent-knowledge-segments', 'fallback-knowledge'],
      modelRoute: blockedConnectedHostModelRoute(),
      harnessRoute: 'agent_harness mode:"connected_host_capability"',
      modelAccess: {
        inspectCapability: 'host action:"capability"',
        allowedAgentKnowledge: 'agent_knowledge or agent_knowledge_ingest',
        liveStatus: 'host action:"status"',
        operate: 'not exposed',
      },
      reason: 'Agent model tools must stay inside the isolated Agent Knowledge route family.',
    },
    {
      id: 'hidden-background-work',
      blocked: ['hidden-agent-jobs', 'implicit-delegated-review', 'untracked-local-schedulers'],
      modelRoute: blockedConnectedHostModelRoute(),
      harnessRoute: 'agent_harness mode:"connected_host_capability"',
      modelAccess: {
        inspectCapability: 'host action:"capability"',
        allowedAutonomy: 'agent tool spawn/batch-spawn, schedules, automation jobs, or confirmed delegation with visible status/cancel routes',
        liveStatus: 'host action:"status"',
        operate: 'use a visible autonomy route',
      },
      reason: 'Autonomy is allowed when it is visible, statused, and cancellable. Hidden jobs are blocked.',
    },
    {
      id: 'arbitrary-connected-host-mutations',
      confirmationGated: ['route-discovery-mutation', 'account-creation', 'automation-definition-creation'],
      modelRoute: 'agent_operator_method',
      harnessRoute: 'agent_harness mode:"connected_host_capability"',
      modelAccess: {
        inspectCapability: 'host action:"capability"',
        allowedActions: 'agent_operator_action for simple allowlisted mutations or agent_operator_method for exact confirmed daemon contract methods',
        liveStatus: 'host action:"status"',
        operate: 'agent_operator_method with confirm:true and explicitUserRequest',
      },
      reason: 'Daemon mutations must resolve to a documented SDK operator method and carry explicit user authorization.',
    },
  ];
}
