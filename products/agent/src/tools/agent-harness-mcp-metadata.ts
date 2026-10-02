import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessMcpArgs {
  readonly mcpServerId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type McpServerLookupSource = 'mcpServerId' | 'target' | 'query';

type McpServerResolution =
  | { readonly status: 'found'; readonly server: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type McpServerRecord = ReturnType<NonNullable<NonNullable<CommandContext['clients']>['mcpApi']>['listServerSecurity']>[number];

interface McpToolRecord {
  readonly serverName: string;
  readonly toolName: string;
  readonly description?: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function resolveMcpApi(context: CommandContext): {
  readonly listServerSecurity: () => readonly McpServerRecord[];
  readonly listAllTools?: (() => Promise<readonly McpToolRecord[]>) | undefined;
} | null {
  const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
  if (!api || typeof api.listServerSecurity !== 'function') return null;
  return {
    listServerSecurity: () => api.listServerSecurity(),
    ...(typeof (api as { readonly listAllTools?: unknown }).listAllTools === 'function'
      ? { listAllTools: () => (api as { listAllTools: () => Promise<readonly McpToolRecord[]> }).listAllTools() }
      : {}),
  };
}

function lookupFromArgs(args: AgentHarnessMcpArgs): { readonly source: McpServerLookupSource; readonly input: string } | null {
  const mcpServerId = readString(args.mcpServerId);
  if (mcpServerId) return { source: 'mcpServerId', input: mcpServerId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function serverSearchText(server: McpServerRecord): string {
  return [
    server.name,
    server.connected ? 'connected' : 'disconnected',
    server.trustMode,
    server.role,
    server.schemaFreshness,
    server.quarantineReason ?? '',
    server.quarantineDetail ?? '',
    ...server.allowedHosts,
  ].join('\n').toLowerCase();
}

function describeCandidate(server: McpServerRecord): Record<string, unknown> {
  return {
    mcpServerId: server.name,
    connected: server.connected,
    trustMode: server.trustMode,
    role: server.role,
    schemaFreshness: server.schemaFreshness,
    modelRoute: mcpServerModelRoute(),
  };
}

function mcpServerModelRoute(): string {
  return 'agent_harness mode:"mcp_server" or mode:"run_command"';
}

function toolsByServer(tools: readonly McpToolRecord[]): ReadonlyMap<string, readonly McpToolRecord[]> {
  const grouped = new Map<string, McpToolRecord[]>();
  for (const tool of tools) {
    const entries = grouped.get(tool.serverName) ?? [];
    entries.push(tool);
    grouped.set(tool.serverName, entries);
  }
  return grouped;
}

function describeServer(
  server: McpServerRecord,
  options: {
    readonly includeParameters?: boolean;
    readonly tools?: readonly McpToolRecord[];
    readonly lookup?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const tools = options.tools ?? [];
  return {
    name: server.name,
    connected: server.connected,
    trustMode: server.trustMode,
    role: server.role,
    schemaFreshness: server.schemaFreshness,
    allowedPathCount: server.allowedPaths.length,
    allowedHostCount: server.allowedHosts.length,
    ...(server.quarantineReason ? { quarantineReason: server.quarantineReason } : {}),
    ...(server.quarantineDetail ? { quarantineDetail: server.quarantineDetail } : {}),
    modelRoute: mcpServerModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      tools: tools.map((tool) => ({
        name: tool.toolName,
        ...(tool.description ? { description: tool.description } : {}),
      })),
      toolCount: tools.length,
      policy: {
        effect: 'read-only',
        values: 'Server posture returns trust, role, connection, quarantine, and tool metadata; env values and secret config values are never returned.',
        mutation: 'MCP add/remove/reload/trust/role/quarantine operations stay explicit confirmation-gated workspace or slash-command flows.',
        allowAll: 'allow-all trust decisions remain routed through Settings -> MCP, not direct command escalation.',
      },
      modelAccess: {
        reviewCommand: '/mcp review',
        serversCommand: '/mcp servers',
        toolsCommand: `/mcp tools ${server.name}`,
        repairCommand: `/mcp repair ${server.name}`,
        authReviewCommand: '/mcp auth-review',
        configCommand: '/mcp config',
        workspaceActionIds: [
          'mcp-review',
          'mcp-tools-server',
          'mcp-repair',
          'mcp-config',
          'mcp-add-server',
          'mcp-settings',
        ],
        confirmationGatedCommands: [
          `/mcp trust ${server.name} <constrained|ask-on-risk|blocked> --yes`,
          `/mcp role ${server.name} <role> --yes`,
          `/mcp quarantine ${server.name} approve <operatorId> --yes`,
          `/mcp remove ${server.name} --yes`,
        ],
      },
    } : {
      toolCount: tools.length,
      summary: previewHarnessText(`${server.connected ? 'connected' : 'disconnected'} ${server.trustMode} ${server.schemaFreshness}`),
    }),
  };
}

async function readMcpTools(api: ReturnType<typeof resolveMcpApi>, includeParameters: boolean): Promise<readonly McpToolRecord[]> {
  if (!includeParameters || !api?.listAllTools) return [];
  try {
    return await api.listAllTools();
  } catch {
    return [];
  }
}

export function mcpServerCatalogStatus(context: CommandContext): Record<string, unknown> {
  const api = resolveMcpApi(context);
  if (!api) {
    return {
      modes: ['mcp_servers', 'mcp_server'],
      status: 'unavailable',
      readOnly: true,
    };
  }
  const servers = api.listServerSecurity();
  return {
    modes: ['mcp_servers', 'mcp_server'],
    servers: servers.length,
    connected: servers.filter((server) => server.connected).length,
    attention: servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined').length,
    readOnly: true,
  };
}

export async function mcpServerSummary(context: CommandContext, args: AgentHarnessMcpArgs): Promise<Record<string, unknown>> {
  const api = resolveMcpApi(context);
  if (!api) {
    return {
      status: 'unavailable',
      servers: [],
      returned: 0,
      total: 0,
      policy: 'MCP runtime API is unavailable in this Agent context.',
    };
  }
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const servers = api.listServerSecurity();
  const tools = toolsByServer(await readMcpTools(api, includeParameters));
  const filtered = servers
    .filter((server) => !query || serverSearchText(server).includes(query))
    .slice(0, readLimit(args.limit, 100));
  return {
    servers: filtered.map((server) => describeServer(server, {
      includeParameters,
      tools: tools.get(server.name) ?? [],
    })),
    returned: filtered.length,
    total: servers.length,
    connected: servers.filter((server) => server.connected).length,
    attention: servers.filter((server) => !server.connected || server.schemaFreshness === 'quarantined').length,
    policy: 'Read-only MCP server posture. Use confirmed workspace actions or slash-command mirrors for add/remove/reload/trust/role/quarantine mutations.',
  };
}

export async function describeHarnessMcpServer(context: CommandContext, args: AgentHarnessMcpArgs): Promise<McpServerResolution> {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'mcp_server requires mcpServerId, target, or query. Use mode:"mcp_servers" to inspect MCP server ids.',
    };
  }
  const api = resolveMcpApi(context);
  if (!api) {
    return {
      status: 'missing_lookup',
      usage: 'MCP runtime API is unavailable in this Agent context.',
    };
  }
  const servers = api.listServerSecurity();
  const normalized = lookup.input.toLowerCase();
  const exact = servers.find((server) => server.name === lookup.input);
  const tools = toolsByServer(await readMcpTools(api, true));
  if (exact) return { status: 'found', server: describeServer(exact, { includeParameters: true, tools: tools.get(exact.name) ?? [], lookup: { ...lookup, resolvedBy: 'id' } }) };
  const insensitive = servers.find((server) => server.name.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', server: describeServer(insensitive, { includeParameters: true, tools: tools.get(insensitive.name) ?? [], lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  const searched = servers.filter((server) => serverSearchText(server).includes(normalized));
  if (searched.length === 1) {
    return { status: 'found', server: describeServer(searched[0]!, { includeParameters: true, tools: tools.get(searched[0]!.name) ?? [], lookup: { ...lookup, resolvedBy: 'search' } }) };
  }
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(describeCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown MCP server ${lookup.input}. Use mode:"mcp_servers" to inspect MCP server ids.`,
  };
}
