import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { interactiveRuntimeCapabilitySummary, interactiveRuntimeParityStatus } from './agent-harness-interactive-runtime-records.ts';
import { isAgentMcpCallRouteInstalled } from './agent-mcp-call-route.ts';
import { toolsDeclaringCapability } from './agent-tool-capability-declarations.ts';
import type { AgentHarnessInteractiveRuntimeRecord } from './agent-harness-interactive-runtime-records.ts';

type BrowserControlStatus = 'ready' | 'attention' | 'setup-needed';
type BrowserControlDecisionStatus = 'ready-to-inspect-tool' | 'review-connector-first' | 'setup-needed';

export interface BrowserControlRouteArgs {
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

interface BrowserControlMcpServer {
  readonly name: string;
  readonly connected: boolean;
  readonly role: string;
  readonly trustMode: string;
  readonly schemaFreshness: string;
  readonly readiness: 'ready' | 'attention';
  readonly modelRoute: string;
}

interface BrowserControlWorkflow {
  readonly id: string;
  readonly label: string;
  readonly status: BrowserControlStatus;
  readonly summary: string;
  readonly next: string;
  readonly inspectRoute: string;
  readonly setupRoute: string;
  readonly safety: string;
}

interface BrowserControlDecision {
  readonly id: string;
  readonly status: BrowserControlDecisionStatus;
  readonly modelRoute: string;
  readonly userRoute: string;
  readonly nextStep: string;
  readonly reason: string;
  readonly safety: string;
}

/**
 * A route that can actually be called right now.
 *
 * Readiness is computed from this list and nothing else. A capability that
 * reports "ready" while every named route is uninvocable is the exact failure
 * this file used to have: it advertised availability:"ready" and pointed the
 * model at MCP browser tools that no tool mode could invoke, and the model
 * spent a session improvising around a route that did not exist.
 */
export interface BrowserControlInvocationRoute {
  readonly kind: 'first-class-tool' | 'mcp-tool-call' | 'daemon-certified-route';
  readonly toolName: string;
  readonly modelRoute: string;
  readonly summary: string;
}

export interface BrowserControlPosture {
  readonly status: BrowserControlStatus;
  readonly configured: boolean;
  readonly needsReview: boolean;
  /** Every route that can be invoked as-is. Empty means nothing can drive a browser. */
  readonly invocationRoutes: readonly BrowserControlInvocationRoute[];
  /** Named blockers when nothing is invocable, each with the fix. */
  readonly blockers: readonly string[];
  /** Registered tools that DECLARED browser control. Never inferred from text. */
  readonly declaredControlTools: readonly string[];
  /** Same list as declaredControlTools, kept for existing readers of this posture. */
  readonly toolMatches: readonly string[];
  readonly mcpServers: readonly BrowserControlMcpServer[];
  readonly certifiedRuntimeRecords: readonly AgentHarnessInteractiveRuntimeRecord[];
  readonly runtime: Record<string, unknown>;
  readonly workflows: readonly BrowserControlWorkflow[];
  readonly setupChecklist: readonly string[];
  readonly fallbackRoutes: readonly string[];
  readonly executionRoute: string;
  readonly setupRoute: string;
  readonly recommendedRoute: string;
  readonly policy: string;
}

type McpServerRecord = ReturnType<NonNullable<NonNullable<CommandContext['clients']>['mcpApi']>['listServerSecurity']>[number];

/**
 * MCP server roles that declare browser control. `role` is set deliberately in
 * the server's configuration, so it is a statement rather than a guess. Server
 * names and descriptions are never scanned: a server called "browser-notes"
 * must not become a browser-control provider because of its name.
 */
const BROWSER_CONTROL_MCP_ROLES = new Set(['browser']);

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function quoteRouteValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function safeToolDefinitions(toolRegistry: ToolRegistry | undefined): readonly ReturnType<ToolRegistry['getToolDefinitions']>[number][] {
  if (!toolRegistry) return [];
  try {
    return toolRegistry.getToolDefinitions();
  } catch {
    return [];
  }
}

function safeMcpServers(context: CommandContext): readonly McpServerRecord[] {
  try {
    const api = context.clients?.mcpApi ?? context.extensions?.mcpRegistry;
    return api?.listServerSecurity?.() ?? [];
  } catch {
    return [];
  }
}

function describeMcpServer(server: McpServerRecord): BrowserControlMcpServer {
  const ready = server.connected && server.schemaFreshness === 'fresh' && server.trustMode !== 'blocked';
  return {
    name: server.name,
    connected: server.connected,
    role: server.role,
    trustMode: server.trustMode,
    schemaFreshness: server.schemaFreshness,
    readiness: ready ? 'ready' : 'attention',
    modelRoute: `agent_harness mode:"mcp_server" mcpServerId:"${server.name}"`,
  };
}

function workflowStatus(configured: boolean, needsReview: boolean): BrowserControlStatus {
  if (configured) return 'ready';
  return needsReview ? 'attention' : 'setup-needed';
}

function browserControlWorkflows(
  configured: boolean,
  needsReview: boolean,
  recommendedRoute: string,
  setupRoute: string,
): readonly BrowserControlWorkflow[] {
  const status = workflowStatus(configured, needsReview);
  const inspectRoute = configured ? recommendedRoute : setupRoute;
  const next = configured
    ? `Call ${recommendedRoute}, this route is invocable now.`
    : needsReview
      ? 'Review trust/schema freshness before treating this browser or desktop connector as usable.'
      : 'Configure a trusted browser/desktop MCP server or first-class tool before attempting live UI control.';
  return [
    {
      id: 'browser-navigation',
      label: 'Browser navigation',
      status,
      summary: 'Drive a real browser only when a trusted browser tool or MCP server is configured.',
      next,
      inspectRoute,
      setupRoute,
      safety: 'Use read-only web/fetch routes for research unless the user explicitly needs live browser state or authentication.',
    },
    {
      id: 'screenshot-observation',
      label: 'Screenshot or screen observation',
      status,
      summary: 'Capture or inspect the screen through configured screenshot/screen-recording tooling.',
      next,
      inspectRoute,
      setupRoute,
      safety: 'Screenshots can expose secrets or private data; inspect setup and ask before capturing sensitive surfaces.',
    },
    {
      id: 'desktop-control',
      label: 'Desktop control',
      status,
      summary: 'Use desktop/computer-control only after trust, host, and confirmation boundaries are clear.',
      next,
      inspectRoute,
      setupRoute,
      safety: 'Desktop actions are external effects; destructive or account-changing actions require explicit user confirmation.',
    },
  ];
}

/**
 * The routes that can be invoked, derived from what is registered right now:
 * the first-class browser tool, and MCP browser tools once the mcp call route
 * exists to invoke them. Nothing is listed on the strength of a keyword match.
 */
function browserInvocationRoutes(
  registry: ToolRegistry | undefined,
  mcpServers: readonly BrowserControlMcpServer[],
  certifiedExecuteRoute: string | null,
): readonly BrowserControlInvocationRoute[] {
  const routes: BrowserControlInvocationRoute[] = [];
  const registeredNames = new Set(safeToolDefinitions(registry).map((tool) => tool.name));
  const declared = new Set(toolsDeclaringCapability('browser-control'));
  if (registeredNames.has('browser') && declared.has('browser')) {
    routes.push({
      kind: 'first-class-tool',
      toolName: 'browser',
      modelRoute: 'browser action:"navigate" url:"https://example.com"',
      summary: 'Drive a real browser directly: navigate, snapshot, click, type, read the page, screenshot. Provisions its own browser on first use.',
    });
  }
  if (certifiedExecuteRoute) {
    // A certified daemon record counts only when it declares a route that
    // RUNS something. A record that offers inspection alone describes browser
    // control without providing it, which is not readiness.
    routes.push({
      kind: 'daemon-certified-route',
      toolName: certifiedExecuteRoute.split(' ')[0] ?? 'execution',
      modelRoute: certifiedExecuteRoute,
      summary: 'Run browser or desktop control through the connected host, using the route its certified record declares.',
    });
  }
  if (registeredNames.has('mcp') && isAgentMcpCallRouteInstalled()) {
    for (const server of mcpServers) {
      if (server.readiness !== 'ready') continue;
      routes.push({
        kind: 'mcp-tool-call',
        toolName: 'mcp',
        modelRoute: `mcp mode:"call" qualifiedName:"mcp:${server.name}:<tool>" input:{...}`,
        summary: `Call a tool on the connected MCP server "${server.name}". List its tools with mcp mode:"tools" serverName:"${server.name}".`,
      });
    }
  }
  return routes;
}

export function browserControlPosture(context: CommandContext, toolRegistry?: ToolRegistry): BrowserControlPosture {
  const registry = toolRegistry ?? context.extensions?.toolRegistry;
  const registeredNames = new Set(safeToolDefinitions(registry).map((tool) => tool.name));
  const declaredControlTools = toolsDeclaringCapability('browser-control')
    .filter((toolName) => registeredNames.has(toolName));

  const mcpServers = safeMcpServers(context)
    .filter((server) => BROWSER_CONTROL_MCP_ROLES.has(server.role))
    .map(describeMcpServer)
    .sort((left, right) => left.name.localeCompare(right.name));

  const needsReview = mcpServers.some((server) => server.readiness === 'attention');
  const runtime = interactiveRuntimeCapabilitySummary(context);
  const runtimeParity = interactiveRuntimeParityStatus(context);
  const certifiedExecuteRoute = runtimeParity.browserDesktopRecords[0]?.routes
    .find((route) => route.id === 'execute')?.modelRoute ?? null;
  const invocationRoutes = browserInvocationRoutes(registry, mcpServers, certifiedExecuteRoute);
  // Readiness is invocability. A connected MCP server, a tool whose name looks
  // browser-shaped, or a certified record that only offers inspection are all
  // reported below as context; none of them make this capability usable.
  const configured = invocationRoutes.length > 0;
  const blockers = configured
    ? []
    : [
      'No browser route can be invoked from this session.',
      ...(mcpServers.length > 0 && !isAgentMcpCallRouteInstalled()
        ? ['MCP browser servers are connected but this session has no route that can call them.']
        : []),
      'Fix: the first-class browser tool provides browser control with no setup, if it is missing from the tool list, this build did not register it.',
    ];
  const recommendedRoute = invocationRoutes[0]?.modelRoute ?? 'agent_harness mode:"mcp_servers" query:"browser desktop"';
  const setupRoute = 'setup action:"item" setupItemId:"browser-desktop-control"';
  return {
    status: configured ? 'ready' : needsReview ? 'attention' : 'setup-needed',
    configured,
    needsReview,
    invocationRoutes,
    blockers,
    declaredControlTools,
    toolMatches: declaredControlTools,
    mcpServers,
    certifiedRuntimeRecords: runtimeParity.browserDesktopRecords.slice(0, 5),
    runtime,
    workflows: browserControlWorkflows(configured, needsReview, recommendedRoute, setupRoute),
    setupChecklist: [
      'Inspect browser/desktop MCP servers and first-class tools before attempting live UI control.',
      'Prefer constrained trust, fresh schemas, and explicit allowed hosts/paths.',
      'Use web_search or fetch instead when the task only needs public web information.',
      'Ask for confirmation before screenshots, authenticated browsing, account changes, purchases, sends, or destructive desktop actions.',
    ],
    fallbackRoutes: [
      'execution action:"route" id:"web-fetch-research"',
      'agent_harness mode:"mcp_servers" query:"browser desktop"',
    ],
    executionRoute: 'execution action:"route" id:"browser-or-desktop-control"',
    setupRoute,
    recommendedRoute,
    policy: 'Browser and desktop control stays explicit: no live UI control is assumed unless a trusted tool, fresh constrained MCP server, or certified daemon browser/desktop command receipt is configured.',
  };
}

function workflowSearchText(workflow: BrowserControlWorkflow): string {
  return [
    workflow.id,
    workflow.label,
    workflow.summary,
    workflow.next,
    workflow.safety,
  ].join('\n').toLowerCase();
}

function selectBrowserControlWorkflow(posture: BrowserControlPosture, input: string): BrowserControlWorkflow {
  const normalized = input.toLowerCase();
  if (!normalized) return posture.workflows[0]!;
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const scored = posture.workflows
    .map((workflow, index) => {
      let score = 0;
      const text = workflowSearchText(workflow);
      if (workflow.id.includes(normalized) || workflow.label.toLowerCase().includes(normalized)) score += 1_000;
      for (const token of tokens) {
        if (workflow.id.includes(token)) score += 250;
        if (workflow.label.toLowerCase().includes(token)) score += 200;
        if (text.includes(token)) score += 40;
      }
      if (workflow.id === 'browser-navigation' && /browse|browser|navigate|url|page|click|form|login|web/.test(normalized)) score += 450;
      if (workflow.id === 'screenshot-observation' && /screenshot|screen|observe|record|capture|visual|see/.test(normalized)) score += 450;
      if (workflow.id === 'desktop-control' && /desktop|computer|app|window|keyboard|mouse|type|os/.test(normalized)) score += 450;
      return { workflow, score, index };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return scored[0]?.workflow ?? posture.workflows[0]!;
}

function toolCandidateRoutes(toolMatches: readonly string[]): readonly Record<string, unknown>[] {
  return toolMatches.slice(0, 8).map((toolName) => ({
    toolName,
    inspectRoute: `agent_harness mode:"tool" toolName:"${quoteRouteValue(toolName)}" includeParameters:true`,
    modelRoute: `${toolName} ...`,
    safety: 'Inspect the tool schema and policy before invoking a live browser, screenshot, or desktop-control action.',
  }));
}

function mcpCandidateRoutes(mcpServers: readonly BrowserControlMcpServer[]): readonly Record<string, unknown>[] {
  return mcpServers.slice(0, 8).map((server) => ({
    serverName: server.name,
    readiness: server.readiness,
    connected: server.connected,
    trustMode: server.trustMode,
    schemaFreshness: server.schemaFreshness,
    inspectRoute: server.modelRoute,
    safety: 'Review trust and schema freshness before using MCP browser or desktop-control tools.',
  }));
}

function browserControlDecision(
  posture: BrowserControlPosture,
  workflow: BrowserControlWorkflow,
  toolRoutes: readonly Record<string, unknown>[],
  mcpRoutes: readonly Record<string, unknown>[],
): BrowserControlDecision {
  const firstToolRoute = readString(toolRoutes[0]?.inspectRoute);
  const firstReadyMcpRoute = readString(mcpRoutes.find((route) => route.readiness === 'ready')?.inspectRoute);
  const firstReviewMcpRoute = readString(mcpRoutes[0]?.inspectRoute);
  if (posture.configured) {
    const route = posture.invocationRoutes[0];
    return {
      id: 'inspect-configured-browser-control',
      status: 'ready-to-inspect-tool',
      modelRoute: route?.modelRoute ?? (firstToolRoute || firstReadyMcpRoute || posture.recommendedRoute || posture.executionRoute),
      userRoute: 'Agent Workspace -> Work & Approvals or Tools & MCP',
      nextStep: route
        ? `Call ${route.modelRoute} directly. ${route.summary}`
        : `Inspect the configured ${workflow.label.toLowerCase()} tool/server before acting.`,
      reason: route
        ? `${route.toolName} is registered and can be invoked from this session.`
        : 'A browser/desktop control tool or fresh trusted MCP server is configured.',
      safety: workflow.safety,
    };
  }
  if (posture.needsReview) {
    return {
      id: 'review-browser-control-connector',
      status: 'review-connector-first',
      modelRoute: firstReviewMcpRoute || 'computer action:"mcp" query:"browser desktop" includeParameters:true',
      userRoute: 'Agent Workspace -> Tools & MCP',
      nextStep: 'Review connector trust, connectivity, and schema freshness before treating browser or desktop control as available.',
      reason: 'A browser/desktop connector exists but needs trust, connectivity, or schema review.',
      safety: 'Do not use stale or untrusted browser/desktop connectors for screenshots, authenticated pages, or desktop actions.',
    };
  }
  return {
    id: 'setup-browser-control',
    status: 'setup-needed',
    modelRoute: posture.setupRoute,
    userRoute: 'Agent Workspace -> Start',
    nextStep: 'Configure a trusted browser/desktop tool or MCP server, or use the public web/fetch fallback when live UI state is not required.',
    reason: 'No trusted browser/desktop control tool or fresh MCP server is configured.',
    safety: 'This planner does not open, observe, or control the browser or desktop.',
  };
}

export function browserControlRouteSummary(
  context: CommandContext,
  toolRegistry: ToolRegistry,
  args: BrowserControlRouteArgs,
): Record<string, unknown> {
  const input = readString(args.query) || readString(args.target);
  const includeParameters = args.includeParameters === true;
  const posture = browserControlPosture(context, toolRegistry);
  const workflow = selectBrowserControlWorkflow(posture, input);
  const toolRoutes = toolCandidateRoutes(posture.toolMatches);
  const mcpRoutes = mcpCandidateRoutes(posture.mcpServers);
  const decision = browserControlDecision(posture, workflow, toolRoutes, mcpRoutes);
  return {
    mode: 'browser_control_route',
    request: input || null,
    status: posture.status,
    configured: posture.configured,
    needsReview: posture.needsReview,
    invocationRoutes: posture.invocationRoutes,
    ...(posture.blockers.length > 0 ? { blockers: posture.blockers } : {}),
    workflow,
    decision,
    toolCandidates: toolRoutes,
    mcpCandidates: mcpRoutes,
    fallbackRoutes: posture.fallbackRoutes,
    routes: {
      controlPosture: 'computer action:"control" includeParameters:true',
      setup: posture.setupRoute,
      mcpReview: 'computer action:"mcp" query:"browser desktop" includeParameters:true',
      publicWebFallback: posture.fallbackRoutes[0] ?? 'execution action:"route" id:"web-fetch-research"',
    },
    ...(includeParameters ? { posture } : {}),
    policy: {
      effect: 'read-only-route-plan',
      boundary: 'This route selects the safest browser/desktop control workflow only. It never opens a browser, captures a screenshot, controls the desktop, or invokes a browser/MCP tool by itself.',
      confirmation: 'Live browser, screenshot, authenticated browsing, account-changing, purchase, send, or destructive desktop actions require the selected tool-specific confirmation boundary and explicit user request.',
    },
  };
}
