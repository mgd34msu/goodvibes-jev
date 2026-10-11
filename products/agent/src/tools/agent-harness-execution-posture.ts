import type { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { captureCatalogData, captureCatalogMethods, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { CommandContext } from '../input/command-registry.ts';
import { browserControlPosture } from './agent-harness-browser-control.ts';
import { delegationDecisionCards } from './agent-harness-delegation-posture.ts';
import { fileRecoveryCatalogStatus } from './agent-harness-file-recovery.ts';
import { interactiveRuntimeCapabilitySummary } from './agent-harness-interactive-runtime-records.ts';
import { sudoExecutionPosture } from './agent-harness-sudo-posture.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessExecutionArgs {
  readonly executionRouteId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type ExecutionResolution =
  | { readonly status: 'found'; readonly route: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type ExecutionLookupSource = 'executionRouteId' | 'target' | 'query';
type ExecutionEffect = 'read-only' | 'local-effect' | 'external-read' | 'delegated-work' | 'setup-gap';
type ExecutionAvailability = 'ready' | 'setup-needed' | 'fallback-only';

interface ExecutionSupervisionRoute {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly modelRoute: string;
  readonly requiresConfirmation?: boolean;
}

interface ExecutionRoute {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly userOutcome: string;
  readonly effect: ExecutionEffect;
  readonly preferredWhen: string;
  readonly useInsteadWhen?: string;
  readonly toolNames?: readonly string[];
  readonly anyToolNames?: readonly string[];
  readonly browserMcp?: boolean;
  readonly modelRoute: string;
  readonly recoveryRoute?: string;
  readonly safety: string;
  readonly nextStep: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function lookupFromArgs(args: AgentHarnessExecutionArgs): { readonly source: ExecutionLookupSource; readonly input: string } | null {
  const executionRouteId = readString(args.executionRouteId);
  if (executionRouteId) return { source: 'executionRouteId', input: executionRouteId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function routeDefinitions(): readonly ExecutionRoute[] {
  return [
    {
      id: 'local-read-search-analyze',
      label: 'Local read, search, and analysis',
      detail: 'Use workspace read/search/inspect/analyze tools to understand files, diffs, logs, and project structure before taking action.',
      userOutcome: 'The user gets direct answers from the current workspace without delegation ceremony.',
      effect: 'read-only',
      preferredWhen: 'The task needs project context, code review, log triage, or file inspection and the current workspace is the target.',
      useInsteadWhen: 'Use delegation only when the user needs a remote workspace, parallel review, or isolated runner.',
      anyToolNames: ['read', 'find', 'inspect', 'analyze'],
      modelRoute: 'read/find/inspect/analyze',
      safety: 'Read-only tools must stay bounded to the current permitted workspace and avoid raw secret disclosure.',
      nextStep: 'Call the narrowest read/search/analyze tool that answers the user request.',
    },
    {
      id: 'local-edit-write',
      label: 'Local file edit and write',
      detail: 'Use local edit/write tools for explicit implementation, fix, patch, or document changes when this Agent workspace is the intended target.',
      userOutcome: 'The user gets the requested change in place without a handoff when local permissions are already sufficient.',
      effect: 'local-effect',
      preferredWhen: 'The user asks to implement, fix, patch, refactor, update docs, or edit files in the current workspace.',
      useInsteadWhen: 'Use delegation for isolated worktrees, remote machines, parallel workers, or work that needs a separate coding UI.',
      anyToolNames: ['edit', 'write'],
      modelRoute: 'edit/write',
      recoveryRoute: 'execution action:"recovery"',
      safety: 'Respect user-owned dirty worktree changes, keep edits scoped, and verify with tests or static checks when feasible.',
      nextStep: 'Use local edit/write tooling, then run targeted verification through the local shell route when appropriate.',
    },
    {
      id: 'local-shell-command',
      label: 'Local shell command',
      detail: 'Run bounded foreground shell commands for discovery, builds, tests, formatting, verification, and explicit user-supervised sudo when the user request and workspace allow it.',
      userOutcome: 'The user sees progress and results from the actual environment without extra routing decisions.',
      effect: 'local-effect',
      preferredWhen: 'The task needs command output, project tests, build checks, package inspection, safe one-off automation, or visible privilege escalation in the current workspace.',
      useInsteadWhen: 'Use execution action:"processes" plus terminal/process for user-approved long-running local commands; use delegation or connected-host tasks for isolation, remote execution, or parallelism.',
      toolNames: ['exec'],
      modelRoute: 'exec',
      safety: 'Use foreground serial commands, avoid destructive operations unless explicitly requested, keep sudo visible and user-supervised, block hidden background sudo prompts, and report verification results clearly.',
      nextStep: 'Call exec for bounded foreground commands, inspect setup_item sudo-execution-posture before escalation, or inspect execution action:"processes" before starting tracked long-running local work.',
    },
    {
      id: 'web-fetch-research',
      label: 'Web and URL evidence',
      detail: 'Use registered web_search or fetch tools for current public information, source inspection, and evidence gathering.',
      userOutcome: 'The user gets sourced current information without pretending local knowledge is fresh.',
      effect: 'external-read',
      preferredWhen: 'The request depends on current, public, or third-party information.',
      useInsteadWhen: 'Use research run/source/report tools when the answer needs a durable research ledger or citation repair.',
      anyToolNames: ['web_search', 'fetch'],
      modelRoute: 'web_search/fetch',
      safety: 'Read-only browsing must use relevant sources, attribution, and source limits; authenticated or mutating web actions need explicit tools.',
      nextStep: 'Call web_search or fetch, then capture durable sources when a longer research workflow is useful.',
    },
    {
      id: 'browser-or-desktop-control',
      label: 'Browser or desktop control',
      detail: 'Use browser, desktop, or computer-control MCP/tooling only when a trusted server or first-class tool is configured.',
      userOutcome: 'The user can automate real UI flows when setup is present, and gets a clear setup gap when it is not.',
      effect: 'setup-gap',
      preferredWhen: 'The user asks for browser navigation, UI testing, screenshots, screen recording, or device/desktop actions.',
      useInsteadWhen: 'Use read-only web tools for research that does not require controlling a live browser or desktop.',
      browserMcp: true,
      modelRoute: 'mcp/browser tools',
      safety: 'Browser and desktop control must use trusted servers, constrained paths/hosts, and visible confirmation for external effects.',
      nextStep: 'Inspect MCP/browser setup, then use the configured browser tool or report the setup blocker.',
    },
    {
      id: 'delegation-isolation-parallel-remote',
      label: 'Delegation, isolation, parallelism, or remote work',
      detail: 'Use GoodVibes TUI/shared-session delegation when the user benefits from isolation, remote execution, separate worktrees, parallel workers, or delegated review.',
      userOutcome: 'The user gets heavier execution routed to the right supervised environment without blocking ordinary local work.',
      effect: 'delegated-work',
      preferredWhen: 'The task needs a remote host, isolated worktree, parallel agent, separate coding UI, or user-requested delegated review.',
      useInsteadWhen: 'Use local read/edit/exec when the current workspace and permissions are sufficient for a normal implementation or verification task.',
      modelRoute: 'delegation action:"status"',
      safety: 'Delegated work submission must preserve the full original ask and remain visible and confirmation-gated.',
      nextStep: 'Inspect delegation action:"status" or action:"route" before submitting a confirmed handoff.',
    },
  ];
}

function safeToolDefinitions(toolRegistry: ToolRegistry): readonly ReturnType<ToolRegistry['getToolDefinitions']>[number][] {
  try {
    return toolRegistry.getToolDefinitions();
  } catch {
    throw new ToolInputProjectionError('unavailable');
  }
}

function registeredToolNames(toolRegistry: ToolRegistry): ReadonlySet<string> {
  return new Set(safeToolDefinitions(toolRegistry).map((tool) => tool.name));
}

function routeAvailability(route: ExecutionRoute, context: CommandContext, toolRegistry: ToolRegistry): ExecutionAvailability {
  if (route.id === 'delegation-isolation-parallel-remote') return 'ready';
  if (route.browserMcp) return browserControlPosture(context, toolRegistry).configured ? 'ready' : 'setup-needed';
  const names = registeredToolNames(toolRegistry);
  if (route.toolNames?.every((name) => names.has(name))) return 'ready';
  if (route.anyToolNames?.some((name) => names.has(name))) return 'ready';
  return route.effect === 'read-only' ? 'fallback-only' : 'setup-needed';
}

function availableTools(route: ExecutionRoute, toolRegistry: ToolRegistry): readonly string[] {
  const names = registeredToolNames(toolRegistry);
  return [...(route.toolNames ?? []), ...(route.anyToolNames ?? [])].filter((name) => names.has(name));
}

function routeSearchText(route: ExecutionRoute): string {
  return [
    route.id,
    route.label,
    route.detail,
    route.userOutcome,
    route.effect,
    route.preferredWhen,
    route.useInsteadWhen ?? '',
    route.modelRoute,
    route.recoveryRoute ?? '',
    route.nextStep,
    ...(route.toolNames ?? []),
    ...(route.anyToolNames ?? []),
  ].join('\n');
}

function describeCandidate(route: ExecutionRoute, context: CommandContext, toolRegistry: ToolRegistry): Record<string, unknown> {
  return {
    executionRouteId: route.id,
    label: route.label,
    effect: route.effect,
    availability: routeAvailability(route, context, toolRegistry),
    modelRoute: route.modelRoute,
  };
}

function executionSupervisionRoutes(context: CommandContext, route: ExecutionRoute): readonly ExecutionSupervisionRoute[] {
  const routes: ExecutionSupervisionRoute[] = [];
  if (route.id === 'local-shell-command') {
    routes.push(
      {
        id: 'process-monitor',
        label: 'Runtime Activity Monitor',
        available: typeof context.openProcessModal === 'function',
        modelRoute: 'workspace action:"open" surfaceId:"process-monitor"',
        requiresConfirmation: true,
      },
      {
        id: 'live-tail',
        label: 'Live Process Output',
        available: typeof context.openLiveTail === 'function',
        modelRoute: 'workspace action:"open" surfaceId:"live-tail"',
        requiresConfirmation: true,
      },
    );
  }
  return routes;
}

function executionSupervisionSummary(context: CommandContext): Record<string, unknown> {
  return {
    processMonitorAvailable: typeof context.openProcessModal === 'function',
    liveTailAvailable: typeof context.openLiveTail === 'function',
    routes: [
      'workspace action:"open" surfaceId:"process-monitor"',
      'workspace action:"open" surfaceId:"live-tail"',
    ],
  };
}

function describeRoute(
  route: ExecutionRoute,
  context: CommandContext,
  toolRegistry: ToolRegistry,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const availability = routeAvailability(route, context, toolRegistry);
  const tools = availableTools(route, toolRegistry);
  const supervisionRoutes = executionSupervisionRoutes(context, route);
  const browserControl = route.browserMcp ? browserControlPosture(context, toolRegistry) : null;
  const delegationCards = route.id === 'delegation-isolation-parallel-remote' ? delegationDecisionCards(context) : null;
  return {
    executionRouteId: route.id,
    label: route.label,
    effect: route.effect,
    availability,
    ...(tools.length > 0 ? { availableTools: tools } : {}),
    ...(supervisionRoutes.length > 0 ? { supervisionRoutes } : {}),
    modelRoute: route.modelRoute,
    ...(route.recoveryRoute ? { recoveryRoute: route.recoveryRoute } : {}),
    preferredWhen: options.includeParameters ? route.preferredWhen : previewHarnessText(route.preferredWhen),
    nextStep: options.includeParameters ? route.nextStep : previewHarnessText(route.nextStep),
    ...(options.includeParameters
      ? {
        detail: route.detail,
        userOutcome: route.userOutcome,
        useInsteadWhen: route.useInsteadWhen ?? null,
        safety: route.safety,
        toolNames: route.toolNames ?? [],
        anyToolNames: route.anyToolNames ?? [],
        browserMcp: route.browserMcp === true,
        ...(browserControl ? { browserControl } : {}),
        ...(delegationCards ? { delegationDecisionCards: delegationCards } : {}),
        modelAccess: {
          inspectPosture: 'execution action:"status"',
          inspectRoute: `execution action:"route" id:"${route.id}"`,
          inspectTools: 'agent_harness mode:"tools"',
          inspectDelegation: 'delegation action:"status"',
          inspectFileRecovery: route.recoveryRoute ?? 'execution action:"recovery"',
        },
      }
      : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };
}

function executionSources(context: CommandContext, toolRegistry: ToolRegistry) {
  return captureCatalogData({
    sessionId: context.session.runtime.sessionId,
    routes: routeDefinitions().map(route => ({ route,
      full: describeRoute(route, context, toolRegistry, { includeParameters: true }),
      summary: describeRoute(route, context, toolRegistry),
    })),
    tools: safeToolDefinitions(toolRegistry),
    browserControl: browserControlPosture(context, toolRegistry),
    delegationCards: delegationDecisionCards(context),
    sudo: sudoExecutionPosture(context),
    interactiveRuntime: interactiveRuntimeCapabilitySummary(context),
    fileRecovery: fileRecoveryCatalogStatus(context),
    supervision: executionSupervisionSummary(context),
  });
}

function captureExecutionBackend(context: CommandContext, toolRegistry: ToolRegistry) {
  const guards = [captureCatalogMethods(context, ['workspace', 'session', 'clients', 'extensions', 'platform', 'openProcessModal', 'openLiveTail']),
    captureCatalogMethods(toolRegistry, ['getToolDefinitions']), captureCatalogMethods(context.workspace, ['fileUndoManager', 'shellPaths']),
    captureCatalogMethods(context.session, ['runtime']), captureCatalogMethods(context.session.runtime, ['sessionId']),
    captureCatalogMethods(context.extensions, ['mcpRegistry', 'daemonRuntime']), captureCatalogMethods(context.platform, ['readModels'])];
  if (context.clients) guards.push(captureCatalogMethods(context.clients, ['operator', 'operatorSdk', 'mcpApi']));
  if (context.workspace.shellPaths) guards.push(captureCatalogMethods(context.workspace.shellPaths, ['workingDirectory', 'homeDirectory']));
  const retainPublished = (subject: object, key: string) => {
    guards.push(captureCatalogMethods(subject, [key]));
    const revision = JSON.stringify(captureCatalogData(Reflect.get(subject, key)));
    guards.push(() => { if (JSON.stringify(captureCatalogData(Reflect.get(subject, key))) !== revision) throw new ToolInputProjectionError('stale'); });
  };
  const readModels: unknown = Reflect.get(context.platform, 'readModels');
  if (readModels && typeof readModels === 'object') for (const key of ['execution', 'computer', 'browser']) retainPublished(readModels, key);
  const daemonRuntime: unknown = Reflect.get(context.extensions, 'daemonRuntime');
  if (daemonRuntime && typeof daemonRuntime === 'object') retainPublished(daemonRuntime, 'interactiveRuntime');
  const operatorSdk: unknown = context.clients ? Reflect.get(context.clients, 'operatorSdk') : undefined;
  if (operatorSdk && typeof operatorSdk === 'object') retainPublished(operatorSdk, 'execution');
  if (context.workspace.fileUndoManager) guards.push(captureCatalogMethods(context.workspace.fileUndoManager, ['peekUndo', 'undoDepth', 'redoDepth']));
  const mcp = context.clients?.mcpApi ?? context.extensions.mcpRegistry;
  if (mcp) guards.push(captureCatalogMethods(mcp, ['listServerSecurity']));
  return () => { for (const guard of guards) guard(); };
}

function retainExecutionSources(context: CommandContext, toolRegistry: ToolRegistry, sources: ReturnType<typeof executionSources>, options: CatalogRankingOptions, assertBackend: () => void) {
  const revision = JSON.stringify(sources);
  const assertCurrent = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    assertBackend();
    if (JSON.stringify(executionSources(context, toolRegistry)) !== revision) throw new ToolInputProjectionError('stale');
    assertBackend();
  };
  options.retainCurrent?.(assertCurrent, 'agent.harness.execution-posture.sources');
  assertCurrent();
  return assertCurrent;
}

async function matchingRoutes(sources: ReturnType<typeof executionSources>, input: string, options: CatalogRankingOptions) {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  if (!input) return { matches: sources.routes.map(entry => ({ entry, judgment: undefined })), judgments: [] };
  return rankHarnessCatalog(sources.routes, input, entry => ({ id: entry.route.id,
    description: routeSearchText(entry.route), evidence: entry }), 'agent.harness.execution-posture',
    { ...options, requirePreservedSource: true });
}

export function executionPostureCatalogStatus(context: CommandContext, toolRegistry: ToolRegistry): Record<string, unknown> {
  const routes = routeDefinitions();
  const statuses = routes.map((route) => routeAvailability(route, context, toolRegistry));
  return {
    modes: ['execution_posture', 'execution_route', 'browser_control_route'],
    routes: routes.length,
    readyRoutes: statuses.filter((status) => status === 'ready').length,
    setupNeededRoutes: statuses.filter((status) => status === 'setup-needed').length,
    readOnly: true,
  };
}

export async function executionPostureSummary(context: CommandContext, toolRegistry: ToolRegistry, args: AgentHarnessExecutionArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const query = readString(args.query);
  const includeParameters = args.includeParameters === true;
  const assertBackend = captureExecutionBackend(context, toolRegistry);
  const sources = executionSources(context, toolRegistry);
  const assertCurrent = retainExecutionSources(context, toolRegistry, sources, options, assertBackend);
  const selected = await matchingRoutes(sources, query, { ...options, assertCurrent });
  assertCurrent();
  const routes = selected.matches.slice(0, readLimit(args.limit, 100));
  const browserControl = sources.browserControl;
  const delegationCards = sources.delegationCards;
  return {
    status: 'available',
    summary: {
      localFirstPolicy: 'Use local read/edit/exec when the current workspace and permissions are sufficient.',
      delegationPolicy: 'Use delegation for isolation, parallelism, remote execution, separate worktrees, or user-requested delegated review.',
      browserControl: browserControl.status,
      browserControlSetup: browserControl,
      delegationDecisionCards: delegationCards,
      sudoPosture: sources.sudo,
      interactiveRuntime: sources.interactiveRuntime,
      executionHistory: 'execution action:"history"',
      backgroundProcesses: 'execution action:"processes"',
      fileRecovery: sources.fileRecovery,
      supervision: sources.supervision,
      registeredExecutionTools: sources.tools.map(tool => tool.name).filter((name) => ['read', 'find', 'inspect', 'analyze', 'edit', 'write', 'exec', 'fetch', 'web_search'].includes(name)).sort(),
    },
    decisionRules: [
      'Do not delegate ordinary local implementation, fix, review, or verification work when local tools and permissions are sufficient.',
      'Do delegate when isolation, parallelism, remote execution, a separate worktree, or a requested delegated review improves the user outcome.',
      'Report setup gaps directly for browser/desktop control instead of pretending browser automation exists.',
      'Treat PTY, sudo, live output, and browser/desktop command execution as ready only when certified SDK/daemon runtime records publish exact visible routes and receipts.',
      'Use tracked background processes for approved long-running local commands instead of hidden exec background mode.',
    ],
    routes: routes.map(({ entry, judgment }) => ({ ...(includeParameters ? entry.full : entry.summary), ...(judgment ? { judgment } : {}) })),
    judgments: selected.judgments,
    returned: routes.length,
    total: sources.routes.length,
    policy: 'Read-only execution posture. It selects routes and safety boundaries; actual tool calls remain governed by each first-class tool policy.',
  };
}

export async function describeHarnessExecutionRoute(context: CommandContext, toolRegistry: ToolRegistry, args: AgentHarnessExecutionArgs, options: CatalogRankingOptions = {}): Promise<ExecutionResolution> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const assertBackend = captureExecutionBackend(context, toolRegistry);
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'execution action:"route" requires executionRouteId, target, or query. Use execution action:"status" to inspect execution route ids.',
    };
  }
  const sources = executionSources(context, toolRegistry);
  const assertCurrent = retainExecutionSources(context, toolRegistry, sources, options, assertBackend);
  const all = sources.routes;
  const normalized = lookup.input.toLowerCase();
  const exact = all.find(({ route }) => route.id === lookup.input);
  if (exact) return { status: 'found', route: { ...exact.full, lookup: { ...lookup, resolvedBy: 'id' } } };
  const insensitive = all.find(({ route }) => route.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', route: { ...insensitive.full, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } } };
  const selected = lookup.source === 'executionRouteId' ? { matches: [], judgments: [] }
    : await matchingRoutes(sources, lookup.input, { ...options, assertCurrent });
  assertCurrent();
  const searched = selected.matches;
  if (searched.length === 1 && searched[0]!.judgment?.reading.verdict === 'yes' && searched[0]!.judgment.reading.outcome === 'act') return { status: 'found', route: { ...searched[0]!.entry.full, judgment: searched[0]!.judgment, lookup: { ...lookup, resolvedBy: 'search' } } };
  if (searched.length > 0) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(({ entry, judgment }) => ({ ...describeCandidate(entry.route, context, toolRegistry), judgment })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown execution route ${lookup.input}. Use execution action:"status" to list route ids.`,
  };
}
