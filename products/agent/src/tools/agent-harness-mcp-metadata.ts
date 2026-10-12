import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogMethods, captureCatalogSnapshot, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureCatalogReadRequest, selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import type { McpApi } from '@goodvibes-jev/engine/sdk/platform/mcp';

type McpCatalogContext = {
  readonly clients?: { readonly mcpApi?: Pick<McpApi, 'listServerSecurity' | 'listAllTools' | 'captureToolCatalog'> };
  readonly extensions?: { readonly mcpRegistry?: Pick<McpApi, 'listServerSecurity' | 'listAllTools' | 'captureToolCatalog'> };
};
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

type McpServerRecord = ReturnType<McpApi['listServerSecurity']>[number];
type McpToolRecord = Awaited<ReturnType<McpApi['listAllTools']>>[number];

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function resolveMcpApi(context: McpCatalogContext): {
  readonly listServerSecurity: () => readonly McpServerRecord[];
  readonly listAllTools?: (() => Promise<readonly McpToolRecord[]>) | undefined;
} | null {
  const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
  if (!api || typeof api.listServerSecurity !== 'function') return null;
  return {
    listServerSecurity: () => api.listServerSecurity(),
    ...(typeof api.listAllTools === 'function'
      ? { listAllTools: () => api.listAllTools() }
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

function captureMcpRead(context: McpCatalogContext, args: AgentHarnessMcpArgs, options: CatalogRankingOptions) {
  const request = captureCatalogReadRequest(args, options);
  const assertContext = captureCatalogMethods(context, ['clients', 'extensions']);
  const clients = context.clients, extensions = context.extensions;
  const assertClients = clients ? captureCatalogMethods(clients, ['mcpApi']) : () => {};
  const assertExtensions = extensions ? captureCatalogMethods(extensions, ['mcpRegistry']) : () => {};
  const api = clients?.mcpApi ?? extensions?.mcpRegistry;
  if (!api) { request.retain(() => { assertContext(); assertClients(); assertExtensions(); }, 'read-catalog.mcp.owner');
    return { request, source: null }; }
  const assertMethods = captureCatalogMethods(api, ['listServerSecurity', 'listAllTools', 'captureToolCatalog']);
  const listServers = api.listServerSecurity, listTools = api.listAllTools, captureCatalog = api.captureToolCatalog;
  const assertOwner = () => {
    assertContext(); assertClients(); assertExtensions(); assertMethods();
    if (context.clients !== clients || context.extensions !== extensions
      || (clients?.mcpApi ?? extensions?.mcpRegistry) !== api) throw new ToolInputProjectionError('held');
  };
  assertOwner();
  if (typeof captureCatalog !== 'function') throw new ToolInputProjectionError('unavailable');
  const catalog = captureCatalog.call(api, options);
  const assertCatalogMethods = captureCatalogMethods(catalog, ['listAllTools', 'assertCurrent']);
  const ownedListTools = catalog.listAllTools, nativeAssertCurrent = catalog.assertCurrent;
  if (typeof ownedListTools !== 'function' || typeof nativeAssertCurrent !== 'function') throw new ToolInputProjectionError('held');
  const assertCatalog = () => {
    assertOwner(); assertCatalogMethods();
    const result = nativeAssertCurrent.call(catalog);
    assertOwner(); assertCatalogMethods();
    return result;
  };
  request.retain(assertCatalog, 'read-catalog.mcp.catalog');
  const originalServers = listServers.call(api);
  const servers = captureCatalogSnapshot(originalServers);
  const assertServers = () => {
    assertOwner(); servers.assertCurrent(originalServers); servers.assertCurrent(listServers.call(api)); assertOwner();
  };
  request.retain(assertServers, 'read-catalog.mcp.servers');
  return { request, source: { api, listTools, catalog, ownedListTools, servers: servers.captured, assertOwner } };
}

async function captureMcpTools(source: NonNullable<ReturnType<typeof captureMcpRead>['source']>,
  request: ReturnType<typeof captureCatalogReadRequest<AgentHarnessMcpArgs>>, needed: boolean) {
  if (!needed) return { tools: [], assertFresh: async () => { request.assertCurrent(); } };
  source.assertOwner(); request.assertCurrent();
  let originalTools: readonly McpToolRecord[];
  try { originalTools = await source.ownedListTools.call(source.catalog); }
  catch { source.assertOwner(); request.assertCurrent(); throw new ToolInputProjectionError('held'); }
  source.assertOwner(); request.assertCurrent();
  const tools = captureCatalogSnapshot(originalTools);
  request.retain(() => { source.assertOwner(); tools.assertCurrent(originalTools); }, 'read-catalog.mcp.tools');
  return { tools: tools.captured, assertFresh: async () => {
    source.assertOwner(); request.assertCurrent();
    let current: readonly McpToolRecord[];
    try { current = await source.listTools.call(source.api); }
    catch { source.assertOwner(); request.assertCurrent(); throw new ToolInputProjectionError('held'); }
    source.assertOwner(); tools.assertCurrent(current); request.assertCurrent(); tools.assertCurrent(current);
  } };
}

export function mcpServerCatalogStatus(context: McpCatalogContext): Record<string, unknown> {
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

export async function mcpServerSummary(context: McpCatalogContext, args: AgentHarnessMcpArgs,
  options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const { request, source } = captureMcpRead(context, args, options);
  if (!source) return { status: 'unavailable', servers: [], returned: 0, total: 0,
    policy: 'MCP runtime API is unavailable in this Agent context.' };
  const query = readString(request.input.query), includeParameters = request.input.includeParameters === true;
  const acquired = await captureMcpTools(source, request, includeParameters || query.length > 0), tools = acquired.tools;
  request.assertCurrent();
  const result = await withModelReadingSource({ invocation: request.input, servers: source.servers, tools }, request.options, async (captured, current) => {
    const descriptions = (server: McpServerRecord) => ({ id: server.name,
      description: `MCP server ${server.name}`, evidence: { server, tools: captured.tools.filter(tool => tool.serverName === server.name) } });
    const selected = query ? await rankHarnessCatalog(captured.servers, query, descriptions, 'agent.mcp-server.search',
      { ...current, requirePreservedSource: true }) : { matches: captured.servers.map(entry => ({ entry })), judgments: [] };
    current.assertCurrent?.();
    const filtered = selected.matches.map(({ entry }) => entry).slice(0, readLimit(captured.invocation.limit, 100));
    const grouped = toolsByServer(captured.tools);
    return { servers: filtered.map(server => describeServer(server, { includeParameters, tools: grouped.get(server.name) ?? [] })),
      returned: filtered.length, total: captured.servers.length,
      connected: captured.servers.filter(server => server.connected).length,
      attention: captured.servers.filter(server => !server.connected || server.schemaFreshness === 'quarantined').length,
      ...(query ? { judgments: selected.judgments } : {}),
      policy: 'Read-only MCP server posture. Use confirmed workspace actions or slash-command mirrors for add/remove/reload/trust/role/quarantine mutations.' };
  });
  await acquired.assertFresh(); request.assertCurrent();
  return result;
}

export async function describeHarnessMcpServer(context: McpCatalogContext, args: AgentHarnessMcpArgs,
  options: CatalogRankingOptions = {}): Promise<McpServerResolution> {
  const { request, source } = captureMcpRead(context, args, options), lookup = lookupFromArgs(request.input);
  if (!lookup) return { status: 'missing_lookup', usage: 'mcp_server requires mcpServerId, target, or query. Use mode:"mcp_servers" to inspect MCP server ids.' };
  if (!source) return { status: 'missing_lookup', usage: 'MCP runtime API is unavailable in this Agent context.' };
  const acquired = await captureMcpTools(source, request, true), tools = acquired.tools;
  request.assertCurrent();
  const result = await withModelReadingSource({ invocation: request.input, servers: source.servers, tools }, request.options, async (captured, current): Promise<McpServerResolution> => {
    const exact = captured.servers.find(server => server.name === lookup.input);
    const insensitive = exact ?? captured.servers.find(server => server.name.toLowerCase() === lookup.input.toLowerCase());
    const selected = insensitive ?? await selectHarnessCatalog(captured.servers, lookup.input,
      server => ({ id: server.name, description: `MCP server ${server.name}`,
        evidence: { server, tools: captured.tools.filter(tool => tool.serverName === server.name) } }), current, 'agent.mcp-server.select');
    current.assertCurrent?.();
    if (!selected) return { status: 'missing_lookup', usage: `No MCP server was selected for ${lookup.input}. Use mode:"mcp_servers" to inspect MCP server ids.` };
    const grouped = toolsByServer(captured.tools);
    return { status: 'found', server: describeServer(selected, { includeParameters: true, tools: grouped.get(selected.name) ?? [],
      lookup: { ...lookup, resolvedBy: exact ? 'id' : insensitive ? 'case-insensitive-id' : 'selection' } }) };
  });
  await acquired.assertFresh(); request.assertCurrent();
  return result;
}
