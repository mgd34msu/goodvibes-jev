import { attemptGroupProgress } from './attempt-group-progress';
/**
 * The Work view's one list, as data (design doc "Data views", Work row).
 *
 * Sessions, hosted sessions, the fleet (agents, workstreams, watchers,
 * background processes, observed external agents), runtime tasks, CI watches
 * and approvals used to be seven pages. They answer one question, "what is
 * running for me, and what needs me", so they become one list in three
 * groups: Needs you (pending approvals, input asks, pick-a-winner, merge
 * conflicts), Running, and Finished. Each row carries a kind (Sessions,
 * Agents, Processes) the page filters on with its segmented control.
 *
 * Rows follow the kit Row: a status dot with a word, a title, one line of
 * meta, one right value. Cost is a right value only when the daemon priced it;
 * an unpriced node shows no cost at all (no "price unknown" chips).
 *
 * Pure: every function here is a projection of the fetched records.
 */
import type { StatusTone } from '../../components/ui/StatusDot';
import type {
  ContractRecord,
  ApprovalRecord,
  FleetAttemptGroup,
  FleetProcessNode,
  HostedSessionRecord,
  OperatorMethodOutput,
  RuntimeTaskSummary,
} from '../../lib/goodvibes';
import {
  attemptGroupIds,
  buildFleetRows,
  formatDurationMs,
  isAwaitingApprovalState,
  isObservedKind,
  isStalledState,
  isTerminalState,
  readHeadline,
  readStallTell,
} from '../../lib/fleet';
import { readExecPromptAsk, isTerminalApprovalStatus } from '../../lib/approvals';
import { hostedStatusLabel } from '../../lib/hosted-sessions';
import { isClosedStatus, isReapedStatus, kindLabel as sessionKindLabel, projectLabel, type UnionSessionRecord } from '../../lib/sessions-union';
import { whenLabel } from '../../lib/when-label';

/**
 * A relative time for a row or a detail, or '' when the record carries no
 * real time (missing, zero, or before 2000): never an epoch date.
 */
/** Short time label ("5m ago", "Nov 14"); '' for a missing or epoch time. */
export { whenLabel };

/** Sentence-case a status word for display. */
export function sentenceCase(word: string): string {
  const trimmed = word.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : trimmed;
}

export type CiWatch = OperatorMethodOutput<'ci.watches.list'>['watches'][number];

/** The segmented filter's kinds. `all` shows every kind. */
export type WorkKind = 'sessions' | 'agents' | 'processes';

export type WorkItemType = 'approval' | 'attempt-group' | 'fleet' | 'session' | 'hosted' | 'task' | 'ci-watch' | 'contract';

export type WorkGroup = 'needs' | 'running' | 'finished';

export interface WorkItem {
  /** Unique across types: `${type}:${id}`. */
  readonly key: string;
  readonly type: WorkItemType;
  readonly id: string;
  readonly kind: WorkKind;
  readonly group: WorkGroup;
  readonly title: string;
  /** One line of plain meta. */
  readonly meta: string;
  readonly tone: StatusTone;
  /** The word beside the dot (status is never color alone). */
  readonly status: string;
  /** Right-aligned value: a known cost, a duration, a count. */
  readonly value?: string;
  /** Tree depth for fleet rows (children indent under their parent). */
  readonly depth: number;
  /** The daemon's attention reason for a needs-you fleet row. */
  readonly attentionReason?: string;
  /** For sorting within a group; newer first where no tree order applies. */
  readonly sortAt: number;
  /** An externally launched agent GoodVibes only observes (not counted as its own work). */
  readonly external?: boolean;
}

export interface WorkSources {
  readonly contracts?: readonly ContractRecord[];
  readonly approvals: readonly ApprovalRecord[];
  readonly nodes: readonly FleetProcessNode[];
  readonly attemptGroups: readonly FleetAttemptGroup[];
  readonly sessions: readonly UnionSessionRecord[];
  readonly hosted: readonly HostedSessionRecord[];
  readonly tasks: readonly RuntimeTaskSummary[];
  readonly ciWatches: readonly CiWatch[];
  /** Nodes come from the fleet archive (fleet.archived.list), not the live fleet. */
  readonly archived?: boolean;
}

/** Fleet kinds that are an agent (a model loop) rather than a process around one. */
const AGENT_KINDS = new Set(['agent', 'acp-agent', 'observed-external', 'wrfc-chain', 'wrfc-subtask']);

export function fleetKindOf(node: Pick<FleetProcessNode, 'kind'>): WorkKind {
  return AGENT_KINDS.has(node.kind) ? 'agents' : 'processes';
}

/** Plain words for a fleet kind, sentence case. Unknown kinds render verbatim. */
export function fleetKindPhrase(kind: string): string {
  switch (kind) {
    case 'agent': return 'Agent';
    case 'acp-agent': return 'External agent';
    case 'observed-external': return 'External';
    case 'wrfc-chain': return 'Review chain';
    case 'wrfc-subtask': return 'Review step';
    case 'workflow': return 'Workflow';
    case 'trigger': return 'Trigger';
    case 'schedule': return 'Schedule';
    case 'watcher': return 'Watcher';
    case 'background-process': return 'Background process';
    case 'workstream': return 'Workstream';
    case 'phase': return 'Phase';
    case 'work-item': return 'Work item';
    case 'code-index': return 'Code index';
    default: return kind.trim() || 'Unknown kind';
  }
}

/** Plain words for a fleet process state. Unknown states render verbatim. */
export function fleetStatePhrase(state: string): string {
  switch (state) {
    case 'thinking': return 'thinking';
    case 'executing-tool': return 'running a tool';
    case 'awaiting-approval': return 'waiting for approval';
    case 'streaming': return 'writing';
    case 'stalled': return 'stalled';
    case 'retrying': return 'retrying';
    case 'done': return 'done';
    case 'failed': return 'failed';
    case 'killed': return 'stopped';
    case 'interrupted': return 'interrupted';
    case 'idle': return 'idle';
    case 'queued': return 'queued';
    case 'paused': return 'paused';
    default: return state.trim() || 'unknown state';
  }
}

export function fleetTone(node: Pick<FleetProcessNode, 'state' | 'needsAttention'>): StatusTone {
  if (node.needsAttention) return 'warn';
  if (isStalledState(node.state) || isAwaitingApprovalState(node.state)) return 'warn';
  if (node.state === 'failed' || node.state === 'killed') return 'bad';
  if (isTerminalState(node.state)) return 'idle';
  if (node.state === 'idle' || node.state === 'paused' || node.state === 'queued') return 'idle';
  return 'live';
}

/** Human words for a fleet attention reason (the dot's word on a needs-you row). */
export function attentionPhrase(reason: string): string {
  if (reason === 'approval') return 'Needs approval';
  if (reason === 'input') return 'Needs input';
  if (reason === 'pick') return 'Needs your pick';
  if (reason === 'conflict') return 'Merge conflict';
  return reason.trim() || 'Needs you';
}

/**
 * A cost string only when the daemon priced it (priced or estimated with a
 * figure). Unpriced and unknown return undefined: the row shows nothing rather
 * than a "price unknown" marker.
 */
export function knownCost(node: Pick<FleetProcessNode, 'costUsd' | 'costState' | 'kind'>): string | undefined {
  if (isObservedKind(node.kind)) return undefined;
  if (node.costState === 'unpriced' || node.costUsd == null) return undefined;
  const amount = `$${node.costUsd.toFixed(2)}`;
  return node.costState === 'estimated' ? `~${amount}` : amount;
}

export function approvalTitle(record: ApprovalRecord): string {
  const exec = readExecPromptAsk(record);
  if (exec) return `Answer: ${exec.prompt || exec.command || 'a running command'}`;
  const summary = record.request.analysis.summary.trim();
  return summary ? `Approve ${record.request.tool}: ${summary}` : `Approve ${record.request.tool}`;
}

export function approvalRequester(record: ApprovalRecord): string {
  const attribution = record.request.attribution;
  if (!attribution) return 'Agent';
  switch (attribution.kind) {
    case 'background-agent': return `Agent ${attribution.agentId}`;
    case 'mcp-server': return `MCP server ${attribution.serverName}`;
    case 'sandbox-escalation': return `Sandbox ${attribution.sandbox}`;
    case 'exec-prompt': return 'A running command';
    default: return 'Agent';
  }
}

function approvalItem(record: ApprovalRecord): WorkItem {
  const terminal = isTerminalApprovalStatus(record.status);
  const risk = record.request.analysis.riskLevel;
  const exec = readExecPromptAsk(record);
  let status = 'Needs approval';
  let tone: StatusTone = 'warn';
  if (exec) status = 'Needs input';
  if (record.status === 'claimed') { status = 'Claimed'; tone = 'info'; }
  if (terminal) {
    status = record.status === 'approved' ? 'Approved' : record.status === 'denied' ? 'Denied' : record.status === 'expired' ? 'Expired' : 'Cancelled';
    tone = record.status === 'approved' ? 'ok' : record.status === 'denied' ? 'bad' : 'idle';
  }
  const metaParts = [approvalRequester(record)];
  if (risk && !exec) metaParts.push(`${risk} risk`);
  metaParts.push(whenLabel(record.resolvedAt ?? record.createdAt));
  return {
    key: `approval:${record.id}`,
    type: 'approval',
    id: record.id,
    kind: 'agents',
    group: terminal ? 'finished' : 'needs',
    title: approvalTitle(record),
    meta: metaParts.filter(Boolean).join(' · '),
    tone,
    status,
    depth: 0,
    sortAt: record.resolvedAt ?? record.createdAt,
  };
}

function attemptGroupItem(group: FleetAttemptGroup): WorkItem {
  const progress = attemptGroupProgress(group);
  const { count } = progress;
  const meta = `Workstream · ${progress.meta}`;
  return {
    key: `attempt-group:${group.groupId}`,
    type: 'attempt-group',
    id: group.groupId,
    kind: 'processes',
    group: progress.ready || progress.held ? 'needs' : 'running',
    title: progress.ready
      ? `Pick a winner: ${count} attempt${count === 1 ? '' : 's'}${group.sourceTitle ? ` for ${group.sourceTitle}` : ''}`
      : `Best of ${count}: ${group.sourceTitle || group.groupId}`,
    meta,
    tone: progress.tone,
    status: progress.status,
    depth: 0,
    sortAt: 0,
  };
}

function fleetMeta(node: FleetProcessNode): string {
  const parts = [fleetKindPhrase(node.kind)];
  const headline = readHeadline(node);
  if (node.needsAttention?.detail) parts.push(node.needsAttention.detail);
  else if (headline) parts.push(headline.text);
  else parts.push(fleetStatePhrase(node.state));
  const stall = readStallTell(node);
  if (stall) parts.push(`quiet ${formatDurationMs(stall.quietForMs)}`);
  return parts.join(' · ');
}

function fleetItem(node: FleetProcessNode, depth: number, pendingApprovalSessions: ReadonlySet<string>): WorkItem {
  const reason = node.needsAttention?.reason;
  // An approval-blocked node is already in Needs you as its approval; the node
  // itself stays under Running (its state says it is waiting) so the same ask
  // never shows twice.
  const approvalDuplicate = reason === 'approval'
    && Boolean(node.sessionRef?.sessionId && pendingApprovalSessions.has(node.sessionRef.sessionId));
  const needs = Boolean(reason) && !approvalDuplicate;
  const terminal = isTerminalState(node.state);
  const status = needs && reason ? attentionPhrase(reason) : fleetStatePhrase(node.state);
  return {
    key: `fleet:${node.id}`,
    type: 'fleet',
    id: node.id,
    kind: fleetKindOf(node),
    group: needs ? 'needs' : terminal ? 'finished' : 'running',
    title: node.label || node.id,
    meta: fleetMeta(node),
    tone: fleetTone(node),
    status: status.charAt(0).toUpperCase() + status.slice(1),
    value: knownCost(node) ?? (terminal || typeof node.elapsedMs !== 'number' ? undefined : formatDurationMs(node.elapsedMs)),
    depth,
    ...(reason ? { attentionReason: reason } : {}),
    ...(isObservedKind(node.kind) ? { external: true } : {}),
    sortAt: node.startedAt ?? 0,
  };
}

function sessionItem(record: UnionSessionRecord): WorkItem {
  const closed = isClosedStatus(record.status);
  const reaped = isReapedStatus(record);
  const parts = [sessionKindLabel(record.kind), projectLabel(record.project)];
  if (record.pendingInputCount > 0) parts.push(`${record.pendingInputCount} waiting`);
  parts.push(whenLabel(record.updatedAt));
  const status = reaped ? 'Reaped' : closed ? 'Closed' : sentenceCase(record.status) || 'Active';
  return {
    key: `session:${record.id}`,
    type: 'session',
    id: record.id,
    kind: 'sessions',
    group: closed ? 'finished' : 'running',
    title: record.title || record.id,
    meta: parts.filter(Boolean).join(' · '),
    tone: record.lastError ? 'bad' : closed ? 'idle' : 'ok',
    status,
    value: record.messageCount > 0 ? `${record.messageCount} msg${record.messageCount === 1 ? '' : 's'}` : undefined,
    depth: 0,
    sortAt: record.updatedAt,
  };
}

function hostedItem(session: HostedSessionRecord): WorkItem {
  const terminated = session.status === 'terminated';
  return {
    key: `hosted:${session.id}`,
    type: 'hosted',
    id: session.id,
    kind: 'sessions',
    group: terminated ? 'finished' : 'running',
    title: session.title || session.id,
    meta: ['Hosted', session.workspaceRoot, `${session.turnCount} turn${session.turnCount === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
    tone: terminated ? 'idle' : session.status === 'running' ? 'live' : 'ok',
    status: sentenceCase(hostedStatusLabel(session.status)),
    depth: 0,
    sortAt: session.updatedAt,
  };
}

const FINISHED_TASK = new Set(['completed', 'failed', 'cancelled']);

function taskItem(task: RuntimeTaskSummary): WorkItem {
  const finished = FINISHED_TASK.has(task.status);
  const tone: StatusTone = task.status === 'failed' ? 'bad'
    : task.status === 'blocked' ? 'warn'
      : task.status === 'running' ? 'live'
        : finished ? 'idle' : 'info';
  return {
    key: `task:${task.id}`,
    type: 'task',
    id: task.id,
    kind: 'processes',
    group: finished ? 'finished' : 'running',
    title: task.title || task.id,
    meta: ['Task', task.kind, task.owner ? `owner ${task.owner}` : '', task.error ?? ''].filter(Boolean).join(' · '),
    tone,
    status: task.status ? task.status.charAt(0).toUpperCase() + task.status.slice(1) : 'Unknown',
    depth: 0,
    sortAt: task.startedAt ?? task.queuedAt,
  };
}

export function ciWatchLabel(watch: Pick<CiWatch, 'repo' | 'ref' | 'prNumber'>): string {
  if (watch.prNumber) return `${watch.repo} #${watch.prNumber}`;
  return watch.ref ? `${watch.repo}@${watch.ref}` : watch.repo;
}

function ciItem(watch: CiWatch): WorkItem {
  const overall = watch.lastOverall ?? '';
  const tone: StatusTone = overall === 'passed' ? 'ok' : overall === 'failed' ? 'bad' : overall === 'pending' ? 'live' : 'idle';
  return {
    key: `ci-watch:${watch.id}`,
    type: 'ci-watch',
    id: watch.id,
    kind: 'processes',
    group: 'running',
    title: ciWatchLabel(watch),
    meta: ['CI watch', `delivers to ${watch.deliveryChannel}`, watch.triggerFixSession ? 'starts a fix session on failure' : ''].filter(Boolean).join(' · '),
    tone,
    status: overall ? overall.charAt(0).toUpperCase() + overall.slice(1) : 'Watching',
    depth: 0,
    sortAt: watch.createdAt,
  };
}

/**
 * Collapse best-of-N sibling nodes out of the tree: a node that is an attempt
 * of a group fleet.attempts.list tracks is represented by the group's row.
 */
export function visibleFleetNodes(
  nodes: readonly FleetProcessNode[],
  groups: readonly FleetAttemptGroup[],
): FleetProcessNode[] {
  if (groups.length === 0) return [...nodes];
  const groupIds = new Set(groups.map((g) => g.groupId));
  if (attemptGroupIds(nodes).size === 0) return [...nodes];
  return nodes.filter((n) => {
    const ref = (n as { attemptGroup?: { groupId?: unknown } }).attemptGroup;
    const gid = ref && typeof ref.groupId === 'string' ? ref.groupId : '';
    return !(gid && groupIds.has(gid));
  });
}

/** Fixed wire lifecycle projection only; this does not judge contract progress. */
function contractItem(contract: ContractRecord): WorkItem {
  const terminal = contract.status === 'passed' || contract.status === 'failed' || contract.status === 'cancelled';
  return {
    key: `contract:${contract.id}`,
    type: 'contract',
    id: contract.id,
    kind: 'processes',
    group: terminal ? 'finished' : 'running',
    title: contract.goal || contract.ask || contract.id,
    meta: `Contract · ${contract.groups.length} groups · ${contract.units.length} units`,
    status: sentenceCase(contract.status),
    tone: contract.status === 'passed' ? 'ok' : contract.status === 'failed' ? 'bad' : terminal ? 'idle' : 'live',
    depth: 0,
    sortAt: contract.createdAt,
  };
}

/** Every row, in display order within each group. */
export function buildWorkItems(sources: WorkSources): WorkItem[] {
  const pendingApprovalSessions = new Set(
    sources.approvals
      .flatMap((a) => (!isTerminalApprovalStatus(a.status) && a.sessionId ? [a.sessionId] : [])),
  );
  const nodes = sources.archived ? [...sources.nodes] : visibleFleetNodes(sources.nodes, sources.attemptGroups);
  const contractRows = new Map((sources.contracts ?? []).map((contract) => [`contract:${contract.id}`, contractItem(contract)]));
  const representedContracts = new Set<string>();
  const fleetRows = buildFleetRows(nodes).map(({ node, depth }) => {
    // The engine's contract adapter names roots contract:<id>. Replace just
    // that summary row, retaining the existing fleet children and controls.
    const contract = node.kind === 'contract' ? contractRows.get(node.id) : undefined;
    if (contract && !sources.archived) {
      representedContracts.add(node.id);
      const fleet = fleetItem(node, depth, pendingApprovalSessions);
      return { ...contract, depth, ...(contract.group !== 'finished' && fleet.group === 'needs'
        ? { group: fleet.group, tone: fleet.tone, attentionReason: fleet.attentionReason } : {}) };
    }
    return fleetItem(node, depth, pendingApprovalSessions);
  });
  if (sources.archived) return fleetRows.map((item) => ({ ...item, group: 'finished' as const }));

  const approvals = [...sources.approvals].map(approvalItem).sort((a, b) => b.sortAt - a.sortAt);
  const attempts = sources.attemptGroups.map(attemptGroupItem);
  const hosted = sources.hosted.map(hostedItem).sort((a, b) => b.sortAt - a.sortAt);
  const sessions = sources.sessions.map(sessionItem).sort((a, b) => b.sortAt - a.sortAt);
  const tasks = sources.tasks.map(taskItem).sort((a, b) => b.sortAt - a.sortAt);
  const ci = sources.ciWatches.map(ciItem).sort((a, b) => b.sortAt - a.sortAt);

  // Fleet rows keep their tree order (parents before children); the other
  // sources follow, newest first.
  const contracts = [...contractRows.entries()].filter(([id]) => !representedContracts.has(id)).map(([, item]) => item).sort((a, b) => b.sortAt - a.sortAt);
  return [...contracts, ...approvals, ...attempts, ...fleetRows, ...hosted, ...sessions, ...tasks, ...ci];
}

export interface WorkGroups {
  readonly needs: WorkItem[];
  readonly running: WorkItem[];
  readonly finished: WorkItem[];
}

/** Split and filter the rows for display. `kind` 'all' keeps every kind. */
export function groupWorkItems(
  items: readonly WorkItem[],
  kind: WorkKind | 'all',
  query = '',
): WorkGroups {
  const needle = query.trim().toLowerCase();
  const keep = (item: WorkItem) =>
    (kind === 'all' || item.kind === kind)
    && (!needle || item.title.toLowerCase().includes(needle) || item.meta.toLowerCase().includes(needle));
  const needs = items.filter((i) => i.group === 'needs' && keep(i));
  const running = items.filter((i) => i.group === 'running' && keep(i));
  const finished = items.filter((i) => i.group === 'finished' && keep(i));
  return { needs, running, finished };
}

/**
 * The page's one-line description: "6 running · 3 need you". Observed external
 * agents are GoodVibes' to watch, not its own work, so they are counted on
 * their own ("· 2 external"), never folded into "running".
 */
export function workSummary(items: readonly WorkItem[]): string {
  const running = items.filter((i) => i.group === 'running' && !i.external).length;
  const external = items.filter((i) => i.group !== 'finished' && i.external).length;
  const needs = items.filter((i) => i.group === 'needs').length;
  const parts = [`${running} running`];
  if (needs > 0) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`);
  else parts.push('nothing needs you');
  if (external > 0) parts.push(`${external} external`);
  return parts.join(' · ');
}
