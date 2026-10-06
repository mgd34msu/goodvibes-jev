import type { RuntimeEventProvenance } from '../../events/occurrence.js';
export type { RuntimeEventProvenance } from '../../events/occurrence.js';
import type { ConversationFollowUpItem } from '../core/conversation-follow-ups.js';
import type { AgentEvent, ProviderEvent, RuntimeEventBus } from './events/index.js';
import type { ContractEvent } from '../../events/contract.js';
import type { createDomainDispatch } from './store/index.js';
import type { ContractRunner } from '../contract/runner.js';
import type { AgentManager } from '../tools/agent/index.js';
import { finishWorkstreamLabel, rememberWorkstreamLabel, workstreamLabel } from '../channels/workstream-labels.js';

const AGENT_STATUS_INTERVAL_MS = 30_000;

export interface HostRuntimeMessageRouter {
  low(message: string, runtimeEvent?: RuntimeEventProvenance): void;
  high(message: string): void;
  /** Contract lifecycle lines for the operator feed (`ui.contractMessages` decides where they show). */
  contract(message: string, priority?: 'high' | 'low', runtimeEvent?: RuntimeEventProvenance): void;
}

export interface HostRuntimeEventBridgeOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly domainDispatch: ReturnType<typeof createDomainDispatch>;
  readonly getSystemMessageRouter: () => HostRuntimeMessageRouter | null;
  readonly queueConversationFollowUp?: ((item: ConversationFollowUpItem) => void) | undefined;
  readonly requestRender: () => void;
  readonly agentManager: AgentManager;
  readonly contractRunner: Pick<ContractRunner, 'get' | 'list'>;
}

/** The runtime event restated by one of this module's operator-feed lines. */
export interface RuntimeEventNotice {
  readonly type: string;
  /** Present only when the producer supplied shared occurrence provenance beside the line. */
  readonly key?: string | undefined;
  readonly title: string;
  readonly level: 'info' | 'warning';
  /** The line's detail, without its bracket tag or status mark. */
  readonly detail: string;
}

/**
 * Match only the declared formats emitted below, never classify arbitrary
 * prose. Contract ids are kept whole, exactly as the producer prints them.
 * Entity ids are not event identities: an agent can wake, and an older
 * contract snapshot can be imported and resumed under the same id. Current
 * lines without declared provenance stay keyless rather than coalescing distinct outcomes.
 */
const RUNTIME_EVENT_NOTICE_LINES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly type: string;
  readonly title: string;
  readonly level: 'info' | 'warning';
}> = [
  { pattern: /^\[Agents\] \u2713 \S+ (\S+): ".*" \u2014 completed in \d+s \(\d+ tool calls\)$/s, type: 'AGENT_COMPLETED', title: 'Agent finished', level: 'info' },
  { pattern: /^\[Agents\] \u2717 \S+ (\S+): ".*" \u2014 failed in \d+s: .*/s, type: 'AGENT_FAILED', title: 'Agent failed', level: 'warning' },
  { pattern: /^\[Contract\] \u2713 (\S+) PASSED: \d+ of \d+ criteria met, \d+ corrections$/, type: 'CONTRACT_PASSED', title: 'Workstream passed', level: 'info' },
  { pattern: /^\[Contract\] \u2717 (\S+) FAILED: /s, type: 'CONTRACT_FAILED', title: 'Workstream failed', level: 'warning' },
  { pattern: /^\[Contract\] (\S+) cancelled: .* \(\d+ files modified\)$/s, type: 'CONTRACT_CANCELLED', title: 'Workstream cancelled', level: 'warning' },
  { pattern: /^\[Contract\] Commit committed for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', title: 'Changes committed', level: 'info' },
  { pattern: /^\[Contract\] Commit applied for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', title: 'Changes applied', level: 'info' },
  { pattern: /^\[Contract\] Commit skipped for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', title: 'Commit skipped', level: 'info' },
  { pattern: /^\[Contract\] Commit failed for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', title: 'Commit failed', level: 'warning' },
  { pattern: /^\[Contract\] \S+ started: /s, type: 'CONTRACT_CREATED', title: 'Workstream started', level: 'info' },
  { pattern: /^\[Contract\] \S+ (?:queued|shaping|planning|checking-plan|running|judging|fixing|committing|awaiting-owner|passed|failed|cancelled) -> (?:queued|shaping|planning|checking-plan|running|judging|fixing|committing|awaiting-owner|passed|failed|cancelled)$/, type: 'CONTRACT_STATUS_CHANGED', title: 'Workstream status changed', level: 'info' },
  { pattern: /^\[Contract\] \u2713 Check \S+ of (?:unit|group|deliverable) \S+: \d+\/\d+ criteria met, pass$/, type: 'CONTRACT_CHECKED', title: 'Check passed', level: 'info' },
  { pattern: /^\[Contract\] \u2717 Check \S+ of (?:unit|group|deliverable) \S+: \d+\/\d+ criteria met, (?:nudge|await-owner|stall)$/, type: 'CONTRACT_CHECKED', title: 'Check needs attention', level: 'warning' },
  { pattern: /^\[Contract\] Nudged unit \S+ \([^\n)]*\)(?: on [^\n]+)?$/, type: 'CONTRACT_NUDGED', title: 'Corrections requested', level: 'info' },
  { pattern: /^\[Contract\] Criterion \S+ of unit \S+ regressed \(met at \S+\)$/, type: 'CONTRACT_CRITERION_REGRESSED', title: 'Requirement regressed', level: 'warning' },
  { pattern: /^\[Contract\] (?:unit|group|deliverable) \S+ stalled, routed to (?:split|fresh|owner): /s, type: 'CONTRACT_STALLED', title: 'Workstream stalled', level: 'warning' },
  { pattern: /^\[Contract\] \S+ needs the owner: /s, type: 'CONTRACT_ESCALATED', title: 'Owner decision needed', level: 'warning' },
  { pattern: /^\[Contract\]\s+\u2713 Gate: .+ passed$/, type: 'CONTRACT_GATE_RESULT', title: 'Quality check passed', level: 'info' },
  { pattern: /^\[Contract\]\s+[\u2713\u2717] Gate: .+ skipped$/, type: 'CONTRACT_GATE_RESULT', title: 'Quality check skipped', level: 'info' },
  { pattern: /^\[Contract\]\s+\u2717 Gate: .+ FAILED$/, type: 'CONTRACT_GATE_RESULT', title: 'Quality check failed', level: 'warning' },
];

/** Read a declared operator-feed line, or return undefined for an unrelated line. */
export function runtimeEventOfNotice(text: string, runtimeEvent?: RuntimeEventProvenance): RuntimeEventNotice | undefined {
  const line = text.trim();
  for (const entry of RUNTIME_EVENT_NOTICE_LINES) {
    if (!entry.pattern.test(line)) continue;
    const detail = line.replace(/^\[[^\]\n]+\]\s*/, '').replace(/^[\u2713\u2717]\s*/, '');
    return { type: entry.type, title: entry.title, level: entry.level, detail, key: runtimeEventKey(entry.type, runtimeEvent) };
  }
  return undefined;
}

/**
 * Only producer-declared occurrence provenance can identify duplicate delivery.
 * Older payloads and text-only notices stay keyless. A new wake or imported
 * contract resume mints a new id even when its entity, text and usage repeat.
 */
export function runtimeEventKey(type: string, payload: unknown): string | undefined {
  if (!RUNTIME_EVENT_NOTICE_LINES.some((entry) => entry.type === type)) return undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('type' in payload) || payload.type !== type
    || !('occurrenceId' in payload) || typeof payload.occurrenceId !== 'string'
    || payload.occurrenceId.trim().length === 0) return undefined;
  return JSON.stringify([type, payload.occurrenceId]);
}

function withRouter(
  getSystemMessageRouter: () => HostRuntimeMessageRouter | null,
  action: (router: HostRuntimeMessageRouter) => void,
): void {
  const router = getSystemMessageRouter();
  if (router) action(router);
}

function buildCohortReport(agentManager: AgentManager, cohort: string): string {
  const agents = agentManager.listByCohort(cohort);
  if (agents.length === 0) return `[Agents] Cohort '${cohort}' complete (no agents found).`;
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const cancelled = agents.filter((agent) => agent.status === 'cancelled').length;
  const lines: string[] = [
    `[Agents] Cohort '${cohort}' complete: ${completed} completed, ${failed} failed, ${cancelled} cancelled (${agents.length} total)`,
  ];
  for (const agent of agents) {
    const durationSeconds = agent.completedAt !== undefined ? Math.round((agent.completedAt - agent.startedAt) / 1000) : 0;
    const icon = agent.status === 'completed' ? '\u2713' : agent.status === 'failed' ? '\u2717' : '~';
    const errorSuffix = agent.error ? ` \u2014 ${agent.error.slice(0, 60)}` : '';
    lines.push(`  ${icon} ${agent.id.slice(-8)}: ${agent.status} in ${durationSeconds}s (${agent.toolCallCount} tool calls)${errorSuffix}`);
  }
  return lines.join('\n');
}

function buildCohortFollowUp(agentManager: AgentManager, cohort: string): ConversationFollowUpItem {
  const agents = agentManager.listByCohort(cohort);
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const cancelled = agents.filter((agent) => agent.status === 'cancelled').length;
  return {
    key: `cohort:${cohort}:complete`,
    summary: `Agent cohort "${cohort}" finished with ${completed} completed, ${failed} failed, and ${cancelled} cancelled out of ${agents.length} total agents.`,
  };
}

function checkCohortCompletion(
  agentManager: AgentManager,
  contractRunner: Pick<ContractRunner, 'list'>,
  record: { cohort?: string | undefined } | null,
  getSystemMessageRouter: () => HostRuntimeMessageRouter | null,
  queueConversationFollowUp?: (item: ConversationFollowUpItem) => void,
): void {
  if (!record?.cohort) return;
  const cohortAgents = agentManager.listByCohort(record.cohort);
  const allAgentsDone = cohortAgents.every((agent) => agent.status !== 'running' && agent.status !== 'pending');
  if (!allAgentsDone) return;

  // A cohort is done only when every contract one of its agents worked a unit of has ended too.
  const cohortAgentIds = new Set(cohortAgents.map((agent) => agent.id));
  const cohortContracts = contractRunner.list({ includeTerminal: true }).filter((contract) =>
    contract.units.some((unit) => unit.agentIds.some((agentId) => cohortAgentIds.has(agentId))),
  );
  const terminalStatuses = new Set(['passed', 'failed', 'cancelled']);
  if (!cohortContracts.every((contract) => terminalStatuses.has(contract.status))) return;

  withRouter(getSystemMessageRouter, (router) => {
    router.low(buildCohortReport(agentManager, record.cohort!));
  });
  queueConversationFollowUp?.(buildCohortFollowUp(agentManager, record.cohort));
}

/** Contract lifecycle presentation without general state dispatch or agent timers. */
export type ContractRuntimeEventBridgeOptions = Pick<HostRuntimeEventBridgeOptions,
  'runtimeBus' | 'getSystemMessageRouter' | 'queueConversationFollowUp' |
  'requestRender' | 'agentManager' | 'contractRunner'>;

/** Share canonical contract labels, operator lines, follow-ups and cohort handling. */
export function registerContractRuntimeEvents(options: ContractRuntimeEventBridgeOptions): Array<() => void> {
  const { runtimeBus, getSystemMessageRouter, queueConversationFollowUp, requestRender, agentManager, contractRunner } = options;
  const unsubs: Array<() => void> = [];

  const onContract = <T extends ContractEvent['type']>(type: T, handler: (payload: Extract<ContractEvent, { type: T }>) => void): void => {
    // The bus delivers only events of `type`, so the payload is that member of the union.
    unsubs.push(runtimeBus.on<ContractEvent>(type, ({ payload }) => {
      handler(payload as Extract<ContractEvent, { type: T }>);
      requestRender();
    }));
  };
  const contractLine = (message: string, runtimeEvent: RuntimeEventProvenance): void => {
    withRouter(getSystemMessageRouter, (router) => router.contract(`[Contract] ${message}`, 'high', runtimeEvent));
  };
  /** The cohort check for a contract that ended: any cohort one of its unit agents belongs to. */
  const checkContractCohorts = (contractId: string): void => {
    const contract = contractRunner.get(contractId);
    if (!contract) return;
    const agentId = contract.units.flatMap((unit) => unit.agentIds).find((id) => agentManager.getStatus(id)?.cohort !== undefined);
    if (agentId === undefined) return;
    checkCohortCompletion(agentManager, contractRunner, agentManager.getStatus(agentId), getSystemMessageRouter, queueConversationFollowUp);
  };

  onContract('CONTRACT_CREATED', (payload) => {
    // Registered here as well as in the channel renderer, because the
    // conversation follow-ups below need a name for this contract and a
    // TUI-only run never goes through a channel. Remembering twice is a no-op.
    rememberWorkstreamLabel(payload.contractId, payload.ask);
    // Operator feed: the id belongs here, where it is used for correlation.
    contractLine(`${payload.contractId} started: ${payload.ask}`, payload);
  });

  onContract('CONTRACT_STATUS_CHANGED', (payload) => {
    contractLine(`${payload.contractId} ${payload.from} -> ${payload.to}`, payload);
  });

  onContract('CONTRACT_CHECKED', (payload) => {
    // A turn-end check that only records history is not worth a line.
    if (payload.result === 'recorded') return;
    const met = payload.criteria.filter((criterion) => criterion.verdict === 'met').length;
    const icon = payload.result === 'pass' ? '\u2713' : '\u2717';
    contractLine(`${icon} Check ${payload.checkId} of ${payload.scope} ${payload.targetId}: ${met}/${payload.criteria.length} criteria met, ${payload.result}`, payload);
  });

  onContract('CONTRACT_NUDGED', (payload) => {
    const criteria = payload.criterionIds.length > 0 ? ` on ${payload.criterionIds.join(', ')}` : '';
    contractLine(`Nudged unit ${payload.unitId} (${payload.kinds.join(', ')})${criteria}`, payload);
  });

  onContract('CONTRACT_CRITERION_REGRESSED', (payload) => {
    contractLine(`Criterion ${payload.criterionId} of unit ${payload.unitId} regressed (met at ${payload.metAtCheckId})`, payload);
  });

  onContract('CONTRACT_STALLED', (payload) => {
    contractLine(`${payload.scope} ${payload.targetId} stalled, routed to ${payload.route}: ${payload.reason}`, payload);
  });

  onContract('CONTRACT_ESCALATED', (payload) => {
    contractLine(`${payload.contractId} needs the owner: ${payload.question}`, payload);
  });

  onContract('CONTRACT_GATE_RESULT', (payload) => {
    const icon = payload.passed ? '\u2713' : '\u2717';
    contractLine(`  ${icon} Gate: ${payload.gate} ${payload.skipped ? 'skipped' : payload.passed ? 'passed' : 'FAILED'}`, payload);
  });

  onContract('CONTRACT_COMMITTED', (payload) => {
    const hash = payload.hash ? ` (${payload.hash.slice(0, 7)})` : '';
    contractLine(`Commit ${payload.status} for ${payload.contractId}${hash}: ${payload.note}`, payload);
  });

  onContract('CONTRACT_PASSED', (payload) => {
    contractLine(`\u2713 ${payload.contractId} PASSED: ${payload.criteriaMet} of ${payload.criteriaJudged} criteria met, ${payload.nudges} corrections`, payload);
    // A conversation follow-up is read by the person, not the operator, so it
    // is named in plain words. The `key` keeps the id: it is a dedupe key
    // nobody reads. See channels/workstream-labels.ts.
    queueConversationFollowUp?.({
      key: `contract:${payload.contractId}:passed`,
      summary: `${workstreamLabel(payload.contractId)} passed all its checks.`,
    });
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(payload.contractId);
  });

  onContract('CONTRACT_FAILED', (payload) => {
    contractLine(`\u2717 ${payload.contractId} FAILED: ${payload.reason}`, payload);
    queueConversationFollowUp?.({
      key: `contract:${payload.contractId}:failed`,
      summary: `${workstreamLabel(payload.contractId)} could not be finished: ${payload.reason.slice(0, 120)}`,
    });
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(payload.contractId);
  });

  onContract('CONTRACT_CANCELLED', (payload) => {
    contractLine(`${payload.contractId} cancelled: ${payload.reason} (${payload.filesModified} files modified)`, payload);
    queueConversationFollowUp?.({
      key: `contract:${payload.contractId}:cancelled`,
      summary: `${workstreamLabel(payload.contractId)} was cancelled: ${payload.reason.slice(0, 120)}`,
    });
    finishWorkstreamLabel(payload.contractId);
    checkContractCohorts(payload.contractId);
  });

  return unsubs;
}

export function registerHostRuntimeEvents(
  options: HostRuntimeEventBridgeOptions,
): { unsubs: Array<() => void>; agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } } {
  const {
    runtimeBus,
    domainDispatch,
    getSystemMessageRouter,
    queueConversationFollowUp,
    requestRender,
    agentManager,
    contractRunner,
  } = options;
  const unsubs: Array<() => void> = [];

  unsubs.push(runtimeBus.onDomain('turn', (env) => {
    domainDispatch.dispatchTurnEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('agents', (env) => {
    domainDispatch.dispatchAgentEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('contracts', (env) => {
    domainDispatch.dispatchContractEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('communication', (env) => {
    domainDispatch.dispatchCommunicationEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('compaction', (env) => {
    domainDispatch.dispatchCompactionEvent(env.payload);
  }));
  unsubs.push(runtimeBus.onDomain('transport', (env) => {
    domainDispatch.dispatchTransportEvent(env.payload);
  }));

  unsubs.push(runtimeBus.on<Extract<ProviderEvent, { type: 'MODEL_FALLBACK' }>>('MODEL_FALLBACK', ({ payload }) => {
    withRouter(getSystemMessageRouter, (router) => {
      router.high(`[Model] ${payload.from} exhausted across all providers. Automatically falling back to ${payload.to} via ${payload.provider}.`);
    });
    requestRender();
  }));

  unsubs.push(...registerContractRuntimeEvents({
    runtimeBus, getSystemMessageRouter, queueConversationFollowUp,
    requestRender, agentManager, contractRunner,
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_STREAM_DELTA' }>>('AGENT_STREAM_DELTA', () => {
    requestRender();
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_PROGRESS' }>>('AGENT_PROGRESS', () => {
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record) {
      const durationSeconds = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? `${record.task.slice(0, 50)}\u2026` : record.task;
      withRouter(getSystemMessageRouter, (router) => {
        router.low(`[Agents] \u2713 ${record.template} ${payload.agentId.slice(-8)}: "${taskSnippet}" \u2014 completed in ${durationSeconds}s (${record.toolCallCount} tool calls)`, payload);
      });
      queueConversationFollowUp?.({
        key: `agent:${payload.agentId}:completed`,
        summary: `${record.template} agent ${payload.agentId.slice(-8)} completed "${taskSnippet}" in ${durationSeconds}s after ${record.toolCallCount} tool calls.`,
      });
    }
    checkCohortCompletion(agentManager, contractRunner, record ?? null, getSystemMessageRouter, queueConversationFollowUp);
    requestRender();
  }));

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    const record = agentManager.getStatus(payload.agentId);
    if (record && record.status !== 'cancelled') {
      const durationSeconds = record.completedAt !== undefined ? Math.round((record.completedAt - record.startedAt) / 1000) : 0;
      const taskSnippet = record.task.length > 50 ? `${record.task.slice(0, 50)}\u2026` : record.task;
      withRouter(getSystemMessageRouter, (router) => {
        router.low(`[Agents] \u2717 ${record.template} ${payload.agentId.slice(-8)}: "${taskSnippet}" \u2014 failed in ${durationSeconds}s: ${payload.error}`, payload);
      });
      queueConversationFollowUp?.({
        key: `agent:${payload.agentId}:failed`,
        summary: `${record.template} agent ${payload.agentId.slice(-8)} failed after ${durationSeconds}s while working on "${taskSnippet}": ${payload.error.slice(0, 120)}`,
      });
    }
    checkCohortCompletion(agentManager, contractRunner, record ?? null, getSystemMessageRouter, queueConversationFollowUp);
    requestRender();
  }));

  const agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null } = { value: null };
  agentStatusIntervalRef.value = setInterval(() => {
    const running = agentManager.list().filter((agent) => agent.status === 'running');
    if (running.length === 0) return;
    const lines = running.map((agent) => `  ${agent.id.slice(-8)}: ${agent.progress ?? agent.status}`);
    withRouter(getSystemMessageRouter, (router) => {
      router.low(`[Agents] ${running.length} running:\n${lines.join('\n')}`);
    });
    requestRender();
  }, AGENT_STATUS_INTERVAL_MS);
  // Don't block clean process exit.
  (agentStatusIntervalRef.value as unknown as { unref?: () => void }).unref?.();

  return { unsubs, agentStatusIntervalRef };
}

export type BootstrapRuntimeEventBridgeOptions = HostRuntimeEventBridgeOptions;
export const registerBootstrapRuntimeEvents = registerHostRuntimeEvents;
