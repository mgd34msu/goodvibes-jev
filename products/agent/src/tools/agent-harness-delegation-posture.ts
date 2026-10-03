import type { CommandContext } from '../input/command-registry.ts';
import { previewHarnessText } from './agent-harness-text.ts';

export interface AgentHarnessDelegationArgs {
  readonly delegationRouteId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type DelegationResolution =
  | { readonly status: 'found'; readonly route: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type DelegationLookupSource = 'delegationRouteId' | 'target' | 'query';

interface DelegationRoute {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly effect: 'read-only' | 'main-conversation' | 'delegated-work' | 'blocked';
  readonly lane?: DelegationLaneId;
  readonly bestFor?: readonly string[];
  readonly requiredFields?: readonly string[];
  readonly optionalFields?: readonly string[];
  readonly successEvidence?: readonly string[];
  readonly statusRoutes?: readonly string[];
  readonly recoveryRoutes?: readonly string[];
  readonly command?: string;
  readonly commandTemplate?: string;
  readonly workspaceActionId?: string;
  readonly confirmationRequired?: boolean;
  readonly reviewPolicy?: 'explicit-only' | 'not-applicable';
}

type DelegationLaneId =
  | 'local-first'
  | 'tui-shared-session'
  | 'delegated-review'
  | 'remote-runner'
  | 'hidden-fanout-blocked';

interface DelegationDecisionCard {
  readonly id: string;
  readonly lane: DelegationLaneId;
  readonly label: string;
  readonly status: 'ready' | 'operator-needed' | 'blocked';
  readonly userBenefit: string;
  readonly chooseWhen: readonly string[];
  readonly doNotUseWhen: readonly string[];
  readonly routeIds: readonly string[];
  readonly requiredFields: readonly string[];
  readonly supervision: readonly string[];
  readonly confirmationBoundary: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(parsed)));
}

function lookupFromArgs(args: AgentHarnessDelegationArgs): { readonly source: DelegationLookupSource; readonly input: string } | null {
  const delegationRouteId = readString(args.delegationRouteId);
  if (delegationRouteId) return { source: 'delegationRouteId', input: delegationRouteId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function routes(): readonly DelegationRoute[] {
  return [
    {
      id: 'delegate-build-task',
      label: 'Delegate build/fix/review task',
      detail: 'Send one explicit build, fix, implementation, patch, or review task to GoodVibes TUI/shared-session routes when isolation, remote execution, parallelism, a separate coding UI, or user-requested handoff is useful.',
      effect: 'delegated-work',
      lane: 'tui-shared-session',
      bestFor: [
        'Separate coding UI',
        'Isolation or separate worktree ownership',
        'Remote execution handled by the GoodVibes host or TUI',
        'Parallel implementation or verification that should not block the main Agent conversation',
      ],
      requiredFields: ['full original user ask', 'delegation reason', 'success criteria or expected evidence'],
      optionalFields: ['workspace/worktree hint', 'deadline/priority', 'review requested yes/no'],
      successEvidence: ['delegation receipt/session id', 'status update', 'diff or artifact summary', 'verification result when available'],
      statusRoutes: ['/delegate status', '/health remote', 'delegation action:"status"'],
      recoveryRoutes: ['Open GoodVibes TUI shared session', 'Use local Agent read/edit/exec when the current workspace is sufficient'],
      commandTemplate: '/delegate <full original user ask>',
      workspaceActionId: 'delegate-task',
      confirmationRequired: true,
      reviewPolicy: 'explicit-only',
    },
    {
      id: 'delegate-build-task-with-review',
      label: 'Delegate with requested review',
      detail: 'Request delegated review only when the user explicitly asks for review or explicitly requests review as part of an isolated or remote build/fix/review handoff.',
      effect: 'delegated-work',
      lane: 'delegated-review',
      bestFor: [
        'User explicitly asks for code review',
        'Implementation handoff needs an independent review owner',
        'Risky change needs WRFC-style evidence before merge/apply decisions',
      ],
      requiredFields: ['full original user ask', 'explicit review request', 'review focus', 'success criteria or expected evidence'],
      optionalFields: ['files/components in scope', 'known risks', 'deadline/priority'],
      successEvidence: ['review receipt/session id', 'findings or approval summary', 'artifact/diff references', 'follow-up questions when blocked'],
      statusRoutes: ['/delegate status', '/health remote', 'delegation action:"route" delegationRouteId:"delegate-build-task-with-review"'],
      recoveryRoutes: ['Use local Agent review when the current workspace is sufficient', 'Open GoodVibes TUI shared session for review follow-up'],
      commandTemplate: '/delegate --review <full original user ask>',
      workspaceActionId: 'delegate-task',
      confirmationRequired: true,
      reviewPolicy: 'explicit-only',
    },
    {
      id: 'delegation-status',
      label: 'Delegation status',
      detail: 'Inspect build-delegation receipts and shared-session status without starting coding work.',
      effect: 'read-only',
      lane: 'tui-shared-session',
      bestFor: ['Checking whether a delegated build/fix/review task was submitted', 'Finding the shared-session receipt before follow-up'],
      requiredFields: [],
      optionalFields: ['session id or task text when available'],
      successEvidence: ['receipt/session id', 'latest shared-session status'],
      statusRoutes: ['/delegate status'],
      recoveryRoutes: ['/health remote', 'Open GoodVibes TUI in the target workspace'],
      command: '/delegate status',
      workspaceActionId: 'delegation-status',
      reviewPolicy: 'not-applicable',
    },
    {
      id: 'ordinary-agent-work',
      label: 'Ordinary Agent work',
      detail: 'Planning, research, operations, memory, configuration, approvals, automation observability, media generation, and ordinary local read/edit/exec work stay in the main Agent conversation or first-class Agent tools.',
      effect: 'main-conversation',
      lane: 'local-first',
      bestFor: ['Normal chat', 'Planning and research', 'Current-workspace implementation or verification with available local tools'],
      requiredFields: [],
      optionalFields: ['work plan item', 'verification command', 'user-visible success criteria'],
      successEvidence: ['direct answer', 'local diff', 'test result', 'artifact id when an Agent tool saves one'],
      statusRoutes: ['main conversation', 'execution action:"status"', 'execution action:"history"'],
      recoveryRoutes: ['execution action:"recovery"', 'execution action:"route" id:"local-edit-write"'],
      reviewPolicy: 'not-applicable',
    },
    {
      id: 'local-agent-execution',
      label: 'Local Agent execution',
      detail: 'Agent may use local read, edit, analyze, fetch, and bounded foreground shell tools when the current workspace and permissions are sufficient for the user request.',
      effect: 'main-conversation',
      lane: 'local-first',
      bestFor: ['Current workspace code changes', 'Targeted tests/builds', 'Foreground command verification', 'Direct file recovery through Agent snapshots'],
      requiredFields: ['user request or task objective'],
      optionalFields: ['files/components in scope', 'verification command', 'risk notes'],
      successEvidence: ['changed files', 'command/test output', 'execution history record', 'file recovery snapshot when edits were made'],
      statusRoutes: ['execution action:"history"', 'execution action:"route" id:"local-shell-command"'],
      recoveryRoutes: ['execution action:"recovery"', 'agent_harness mode:"run_file_recovery"'],
      reviewPolicy: 'not-applicable',
    },
    {
      id: 'remote-runner-inspection',
      label: 'Remote runner inspection',
      detail: 'Inspect GoodVibes remote build-host pools, contracts, artifacts, and review summaries when the host exposes them; mutation-heavy remote pool assignment and artifact import are not Agent-owned actions.',
      effect: 'read-only',
      lane: 'remote-runner',
      bestFor: ['Checking remote build-host health', 'Reviewing runner contracts', 'Reviewing remote artifacts that already exist'],
      requiredFields: [],
      optionalFields: ['runner id', 'artifact id', 'pool id'],
      successEvidence: ['remote health summary', 'runner contract summary', 'remote artifact review summary'],
      statusRoutes: ['/health remote', 'remote tool read-only modes: pools, contracts, artifacts, review'],
      recoveryRoutes: ['Repair remote build-host state outside Agent', 'Use /delegate for build/fix/review execution changes'],
      command: '/health remote',
      reviewPolicy: 'not-applicable',
    },
    {
      id: 'hidden-local-fanout-blocked',
      label: 'Hidden local fanout blocked',
      detail: 'Do not spawn invisible local coding workers, background exec batches, or untracked parallel subagents from Agent. Convert the request into local serial work, a visible work plan, a research run, an explicit schedule, or confirmed GoodVibes TUI/shared-session delegation.',
      effect: 'blocked',
      lane: 'hidden-fanout-blocked',
      bestFor: ['Policy explanation when a request implies hidden background implementation work'],
      requiredFields: [],
      optionalFields: ['visible work-plan item', 'delegation reason', 'success criteria'],
      successEvidence: ['chosen visible route', 'confirmation receipt when delegated'],
      statusRoutes: ['execution action:"status"', 'autonomy action:"intake"'],
      recoveryRoutes: ['delegation action:"status"', 'Agent Workspace -> Work & Approvals'],
      reviewPolicy: 'not-applicable',
    },
  ];
}

export function delegationDecisionCards(context: CommandContext): readonly DelegationDecisionCard[] {
  const operatorAttached = Boolean(context.clients?.operator);
  return [
    {
      id: 'delegate-decision-local-first',
      lane: 'local-first',
      label: 'Keep it in Agent',
      status: 'ready',
      userBenefit: 'Fastest path for current-workspace work: no handoff, no duplicate context, direct verification and recovery.',
      chooseWhen: [
        'The current Agent workspace is the target.',
        'Local read/edit/exec tools can complete and verify the work.',
        'The user did not ask for a separate runner, worktree, or delegated review.',
      ],
      doNotUseWhen: [
        'The work needs a remote machine, separate worktree, independent review owner, or parallel execution lane.',
      ],
      routeIds: ['ordinary-agent-work', 'local-agent-execution'],
      requiredFields: ['task objective'],
      supervision: ['execution action:"status"', 'execution action:"history"', 'execution action:"recovery"'],
      confirmationBoundary: 'Use normal Agent tool confirmations; no shared-session delegation is submitted.',
    },
    {
      id: 'delegate-decision-tui-handoff',
      lane: 'tui-shared-session',
      label: 'Delegate to GoodVibes TUI',
      status: operatorAttached ? 'ready' : 'operator-needed',
      userBenefit: 'Best route when the user benefits from the coding TUI, shared sessions, isolation, worktree ownership, or remote host workflows.',
      chooseWhen: [
        'The task is explicit build/fix/implementation/review work.',
        'Delegation improves the user outcome versus staying local.',
        'The full original ask, reason, and success criteria can be preserved.',
      ],
      doNotUseWhen: [
        'The task is ordinary local work that Agent can complete directly.',
        'The user has not confirmed a mutating delegation submission.',
      ],
      routeIds: ['delegate-build-task', 'delegation-status'],
      requiredFields: ['full original user ask', 'delegation reason', 'success criteria or expected evidence'],
      supervision: ['/delegate status', '/health remote', 'GoodVibes TUI shared session'],
      confirmationBoundary: 'Submitting delegated work requires a confirmed workspace form or slash command and an attached operator client.',
    },
    {
      id: 'delegate-decision-review',
      lane: 'delegated-review',
      label: 'Request delegated review',
      status: operatorAttached ? 'ready' : 'operator-needed',
      userBenefit: 'Adds an independent review owner only when the user explicitly asks for it or the handoff needs review as part of the task.',
      chooseWhen: [
        'The user asks for review, WRFC, second pass, or independent verification.',
        'The delegated task has review focus and expected evidence.',
      ],
      doNotUseWhen: [
        'Review is only implied by the existence of a handoff.',
        'A local code review in the current workspace is sufficient.',
      ],
      routeIds: ['delegate-build-task-with-review', 'delegation-status'],
      requiredFields: ['full original user ask', 'explicit review request', 'review focus', 'success criteria or expected evidence'],
      supervision: ['/delegate status', 'GoodVibes TUI shared session'],
      confirmationBoundary: 'The --review lane is explicit-only; Agent must not add review by default.',
    },
    {
      id: 'delegate-decision-remote-inspect',
      lane: 'remote-runner',
      label: 'Inspect remote runners',
      status: 'ready',
      userBenefit: 'Keeps remote-host state understandable without exposing mutation-heavy pool or artifact operations through Agent.',
      chooseWhen: [
        'The user asks about remote build-host health, runner contracts, or existing remote artifacts.',
      ],
      doNotUseWhen: [
        'The user asks Agent to create pools, assign runners, import artifacts, or dispatch hidden remote work.',
      ],
      routeIds: ['remote-runner-inspection'],
      requiredFields: [],
      supervision: ['/health remote', 'remote read-only tool modes: pools/contracts/artifacts/review'],
      confirmationBoundary: 'Remote build-host mutation belongs outside Agent or through explicit GoodVibes TUI delegation.',
    },
    {
      id: 'delegate-decision-hidden-fanout',
      lane: 'hidden-fanout-blocked',
      label: 'Block hidden fanout',
      status: 'blocked',
      userBenefit: 'Protects the user from invisible work, unclear ownership, unreviewed side effects, and orphaned background jobs.',
      chooseWhen: [
        'A request implies invisible local subagents, background exec batches, untracked remote dispatch, or unmanaged parallel coding workers.',
      ],
      doNotUseWhen: [
        'The work can be expressed as a visible work plan, research run, schedule, local serial tool use, or confirmed delegation.',
      ],
      routeIds: ['hidden-local-fanout-blocked'],
      requiredFields: [],
      supervision: ['execution action:"status"', 'autonomy action:"intake"', 'work plan'],
      confirmationBoundary: 'Hidden fanout is never confirmed from Agent; convert to a visible owned route.',
    },
  ];
}

function routeSearchText(route: DelegationRoute): string {
  return [
    route.id,
    route.label,
    route.detail,
    route.effect,
    route.lane ?? '',
    route.command ?? '',
    route.commandTemplate ?? '',
    route.workspaceActionId ?? '',
    route.reviewPolicy ?? '',
    ...(route.bestFor ?? []),
    ...(route.requiredFields ?? []),
    ...(route.optionalFields ?? []),
    ...(route.successEvidence ?? []),
    ...(route.statusRoutes ?? []),
    ...(route.recoveryRoutes ?? []),
  ].join('\n').toLowerCase();
}

function describeCandidate(route: DelegationRoute): Record<string, unknown> {
  return {
    delegationRouteId: route.id,
    label: route.label,
    effect: route.effect,
    lane: route.lane ?? 'local-first',
    confirmationRequired: route.confirmationRequired === true,
    modelRoute: delegationRouteModelRoute(route),
  };
}

function delegationRouteModelRoute(route: DelegationRoute): string {
  return route.effect === 'main-conversation' ? 'main conversation' : `delegation action:"route" id:"${route.id}"`;
}

function describeRoute(
  context: CommandContext,
  route: DelegationRoute,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    delegationRouteId: route.id,
    label: route.label,
    ...(options.includeParameters ? { detail: route.detail } : { summary: previewHarnessText(route.detail) }),
    effect: route.effect,
    lane: route.lane ?? 'local-first',
    confirmationRequired: route.confirmationRequired === true,
    reviewPolicy: route.reviewPolicy ?? 'not-applicable',
    modelRoute: delegationRouteModelRoute(route),
    runtime: {
      sessionId: context.session.runtime.sessionId,
      operatorClientAttached: Boolean(context.clients?.operator),
    },
    ...(options.includeParameters ? {
      ...(route.command ? { command: route.command } : {}),
      ...(route.commandTemplate ? { commandTemplate: route.commandTemplate } : {}),
      ...(route.workspaceActionId ? { workspaceActionId: route.workspaceActionId } : {}),
      bestFor: route.bestFor ?? [],
      requiredFields: route.requiredFields ?? [],
      optionalFields: route.optionalFields ?? [],
      successEvidence: route.successEvidence ?? [],
      statusRoutes: route.statusRoutes ?? [],
      recoveryRoutes: route.recoveryRoutes ?? [],
    } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      policy: {
        effect: route.effect,
        values: 'Delegation posture returns policy, route, confirmation, and runtime availability metadata only; it does not submit delegated work.',
        mutation: 'Delegated work submission stays a visible confirmed workspace or slash-command flow and must preserve the full original user ask.',
      },
      modelAccess: {
        inspectDelegation: 'delegation action:"status"',
        inspectRoute: 'delegation action:"route"',
        workspaceAction: route.workspaceActionId ? `workspace action:"action" actionId:"${route.workspaceActionId}"` : null,
        runWorkspaceAction: route.workspaceActionId ? `workspace action:"run" actionId:"${route.workspaceActionId}" confirm:true explicitUserRequest:"..."` : null,
        runCommand: route.command ? `workspace action:"run_command" command:"${route.command}" confirm:true explicitUserRequest:"..."` : null,
        runCommandTemplate: route.commandTemplate ? `workspace action:"run_command" command:"${route.commandTemplate}" confirm:true explicitUserRequest:"..."` : null,
      },
    } : {}),
  };
}

export function delegationPostureCatalogStatus(context: CommandContext): Record<string, unknown> {
  return {
    modes: ['delegation_posture', 'delegation_route'],
    routes: routes().length,
    decisionCards: delegationDecisionCards(context).length,
    operatorClientAttached: Boolean(context.clients?.operator),
    readOnly: true,
  };
}

export function delegationPostureSummary(context: CommandContext, args: AgentHarnessDelegationArgs): Record<string, unknown> {
  const query = readString(args.query).toLowerCase();
  const includeParameters = args.includeParameters === true;
  const filtered = routes()
    .filter((route) => !query || routeSearchText(route).includes(query))
    .slice(0, readLimit(args.limit, 100));
  return {
    status: 'available',
    summary: {
      routes: routes().length,
      decisionCards: delegationDecisionCards(context).length,
      operatorClientAttached: Boolean(context.clients?.operator),
      sessionId: context.session.runtime.sessionId,
      delegatedReviewPolicy: 'explicit-build-delegation-only',
      normalChatPolicy: 'ordinary assistant work and suitable local execution stay in the main Agent conversation',
      codingOwnership: 'Agent may use local read/edit/exec when the current workspace is sufficient; GoodVibes TUI/shared-session routes own isolation, remote execution, separate worktrees, coding panels, and delegated review coordination',
    },
    decisionCards: delegationDecisionCards(context),
    routes: filtered.map((route) => describeRoute(context, route, { includeParameters })),
    returned: filtered.length,
    total: routes().length,
    policy: 'Read-only delegation posture. Delegation submission requires an explicit build/fix/review/implementation user request, visible confirmation, and preservation of the full original ask.',
  };
}

export function describeHarnessDelegationRoute(context: CommandContext, args: AgentHarnessDelegationArgs): DelegationResolution {
  const lookup = lookupFromArgs(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'delegation action:"route" requires delegationRouteId, target, or query. Use delegation action:"status" to inspect delegation route ids.',
    };
  }
  const all = routes();
  const normalized = lookup.input.toLowerCase();
  const exact = all.find((route) => route.id === lookup.input);
  if (exact) return { status: 'found', route: describeRoute(context, exact, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' } }) };
  const insensitive = all.find((route) => route.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', route: describeRoute(context, insensitive, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  const searched = all.filter((route) => routeSearchText(route).includes(normalized));
  if (searched.length === 1) return { status: 'found', route: describeRoute(context, searched[0]!, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) };
  if (searched.length > 1) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.slice(0, 8).map(describeCandidate),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown delegation route ${lookup.input}. Use delegation action:"status" to inspect delegation route ids.`,
  };
}
