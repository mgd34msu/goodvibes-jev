/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Live process registry, one queryable + subscribable aggregation
 * surface over the already-composed runtime managers. ZERO new store state:
 * every query is an aggregate-on-read over the managers' in-memory maps, and
 * the only registry-owned mutable state is the agent activity side-table fed
 * by EXISTING runtime-bus 'agents' events (no new event contract).
 *
 * The contract tree comes from the contract runner's views (contract, group
 * and unit nodes, docs/design/contract-runner.md section 8.3); every other
 * family from its own manager.
 */

import type { AgentManager, AgentRecord } from '../../tools/agent/manager.js';
import type { ContractRunner } from '../../contract/runner.js';
import type { ContractView } from '../../contract/types.js';
import type { ProcessManager } from '../../tools/shared/process-manager.js';
import type { WatcherRegistry } from '../../watchers/registry.js';
import type {
  ScheduleEntry,
  ScheduleManager,
  TriggerManager,
  WorkflowManager,
} from '../../tools/workflow/index.js';
import type { AutomationManager } from '../../automation/index.js';
import type { ApprovalBroker } from '../../control-plane/approval-broker.js';
import type { SharedSessionBroker } from '../../control-plane/session-broker.js';
import type { AgentMessageBus } from '../../agents/message-bus.js';
import type { RuntimeEventBus, RuntimeEventEnvelope } from '../events/index.js';
import type { TurnEvent } from '../../../events/turn.js';
import type {
  FleetQueryFilter,
  FleetSnapshot,
  ProcessKillOptions,
  ProcessNode,
  ProcessRegistry,
  ProcessUsage,
  SteerResult,
} from './types.js';
import type { AgentActivityEntry, AgentAdapterContext } from './adapters/agent.js';
import { adaptAgent } from './adapters/agent.js';
import {
  adaptContract,
  adaptContractGroup,
  adaptContractUnit,
  allContractUnits,
  contractUnitNodeId,
  repriceContractOwnerNode,
} from './adapters/contract.js';
import { adaptWorkflow } from './adapters/workflow.js';
import { adaptTrigger } from './adapters/trigger.js';
import { adaptSchedule } from './adapters/schedule.js';
import { adaptWatcher } from './adapters/watcher.js';
import { adaptWatcherTrigger, isWatcherTriggerRaw } from './adapters/watcher-trigger.js';
import type { TriggerManager as WatcherTriggerManager } from '../../triggers/manager.js';
import { adaptBackgroundProcess } from './adapters/background-process.js';
import { adaptAutomationJob, isAutomationJobRaw } from './adapters/automation.js';
import type { CodeIndexProcessSource } from './adapters/code-index.js';
import { adaptCodeIndex } from './adapters/code-index.js';
import { adaptHostedAcpAgent, killHostedAcpNode, steerHostedAcpNode } from './adapters/acp-host.js';
import { adaptObservedAgent, steerObservedNode } from './adapters/observed.js';
import type { ObservedAgentSource } from './observed/source.js';
import type { AcpHostService } from '../../acp/host.js';
import { DEFAULT_STALL_TELL_MS, HeadlineTable, deriveStallTell } from './headlines.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** Default stalled threshold: running agent with no bus activity for this long → 'stalled'. */
export const DEFAULT_STALLED_THRESHOLD_MS = 20_000;
/** Default coalesced tick interval for subscriber notification. */
export const DEFAULT_TICK_INTERVAL_MS = 750;
/**
 * TTL for a steer message, deliberately much larger than
 * AgentMessageBus's own DEFAULT_TTL_MS (5 min, message-bus-core.ts). A
 * steer queued against an agent mid long-running tool call (build, test
 * suite) must survive the wait for that tool to return rather than
 * silently expiring before the agent reaches its next turn boundary.
 */
export const STEER_TTL_MS = 30 * 60 * 1000;

/** Injectable timer seam so tests can drive/observe the coalesced tick. */
export interface RegistryTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

/**
 * Narrow structural deps, a pick of each manager's read/control surface, NOT
 * the whole RuntimeServices, so the registry stays testable with stubs and
 * cannot participate in a construction cycle.
 */
export interface ProcessRegistryDeps {
  readonly agentManager: Pick<AgentManager, 'list' | 'cancel'> & Partial<Pick<AgentManager, 'wakeWithSteer'>>;
  /**
   * The contract runner: its views become contract, contract-group and
   * contract-unit nodes, and a contract kill cancels through it.
   */
  readonly contractRunner: Pick<ContractRunner, 'list' | 'cancel'>;
  readonly processManager: Pick<ProcessManager, 'list' | 'stop' | 'getStatus'>;
  readonly watcherRegistry: Pick<WatcherRegistry, 'list' | 'stopWatcher'>;
  readonly workflow: {
    readonly workflowManager: Pick<WorkflowManager, 'list' | 'cancel'>;
    /** `enable` backs ProcessRegistry.resume(), the inverse of `disable`'s interrupt/pause. */
    readonly triggerManager: Pick<TriggerManager, 'list' | 'remove' | 'disable' | 'enable'>;
    readonly scheduleManager: Pick<ScheduleManager, 'list' | 'remove' | 'disable' | 'enable'>;
  };
  /**
   * Optional: the trigger family's supervisor (stream watchers, condition
   * checks, on-exit process triggers). When present its records fold in as
   * 'trigger' nodes alongside the workflow tool's event triggers, the two are
   * told apart by `isWatcherTriggerRaw`, never by kind alone, so a control verb
   * can never be routed to the wrong manager. Absent (the default, and the
   * case whenever watchers.triggers.enabled is false) ⇒ exactly today's
   * behavior: zero extra nodes, no new capability.
   */
  readonly triggerSupervisor?: Pick<WatcherTriggerManager, 'list' | 'cancel' | 'reset'> | undefined;
  /** Optional: awaiting-approval derivation. Non-control-plane runtimes still build a fleet. */
  readonly approvalBroker?: Pick<ApprovalBroker, 'listApprovals'> | undefined;
  /** Optional: populates ProcessNode.sessionRef.sessionId (tab attach point). */
  readonly sessionBroker?: Pick<SharedSessionBroker, 'listSessions'> | undefined;
  /**
   * Optional: the repo source-tree code index (Stage A).
   * When present, its build/idle state surfaces as a single 'code-index'
   * ProcessNode. Without this dep the fleet degrades to exactly today's
   * behavior, zero code-index nodes, no new capability.
   */
  readonly codeIndexService?: CodeIndexProcessSource | undefined;
  /** Optional: hosted third-party ACP agents fold in as 'acp-agent' nodes (steer = next prompt, kill = stop, permission ask = awaiting-approval). Absent ⇒ exactly today's behavior. */
  readonly acpHost?: Pick<AcpHostService, 'list' | 'prompt' | 'stop'> | undefined;
  /** Optional: externally-launched agents observed read-only on the host fold in as 'observed-external' rows (steer = the foreign session's own channel, e.g. tmux; stop never offered; NOT counted against fleet.maxSize). Absent ⇒ exactly today's behavior. */
  readonly observedAgents?: Pick<ObservedAgentSource, 'list' | 'steer'> | undefined;
  /**
   * Optional: folds `/schedule` automation jobs
   * (platform/automation, a SEPARATE subsystem from the workflow-tool's
   * ScheduleManager above) into the fleet as 'schedule'-kind nodes, see
   * adapters/automation.ts. Without this dep the fleet degrades to exactly
   * today's behavior, zero automation-job nodes, no new capability.
   */
  readonly automationManager?: Pick<AutomationManager, 'listJobs' | 'setEnabled' | 'removeJob'> | undefined;
  /**
   * Optional: backs `steer()` and the `steerable` capability. The
   * bus already exists in the composed runtime and already feeds every
   * in-process agent's per-turn inbox drain (orchestrator-runner.ts), this
   * just hands the registry a narrow `send`-only pick of it. Without this
   * dep, steer() always refuses and steerable is false everywhere
   * (graceful degrade, matches the approvalBroker/sessionBroker pattern).
   */
  readonly messageBus?: Pick<AgentMessageBus, 'send'> | undefined;
  /** Optional: feeds the fine-grained agent activity side-table. Without it the registry degrades to coarse states. */
  readonly runtimeBus?: RuntimeEventBus | undefined;
  /** Optional: honest cost pricing. Return null when the model is unknown, NEVER fabricate. */
  readonly priceUsage?: ((model: string | undefined, usage: ProcessUsage) => number | null) | undefined;
  /** Optional: provenance for the same resolution priceUsage prices with (costSource + as-of date on priced nodes). */
  readonly priceProvenance?: ((model: string | undefined) => { readonly source: 'user' | 'provider' | 'catalog'; readonly asOf?: string | undefined } | null) | undefined;
  readonly now?: (() => number) | undefined;
  readonly stalledThresholdMs?: number | undefined;
  /** Stall-tell threshold: a live node quiet this long gains the marker (default 5 min). */
  readonly stallTellMs?: number | undefined;
  readonly tickIntervalMs?: number | undefined;
  readonly timers?: RegistryTimers | undefined;
}

const defaultTimers: RegistryTimers = {
  setInterval: (callback, intervalMs) => {
    const handle = setInterval(callback, intervalMs);
    // Unref at the creation site so a dangling tick never keeps the process
    // alive if a consumer forgets to dispose. The registry also unrefs the
    // returned handle via unrefHandle() for injected timer impls; this inline
    // unref keeps the raw setInterval site self-contained (invariant guard).
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function unrefHandle(handle: unknown): void {
  if (handle !== null && typeof handle === 'object' && 'unref' in handle) {
    const unref = (handle as { unref: unknown }).unref;
    if (typeof unref === 'function') (unref as () => void).call(handle);
  }
}

/**
 * Change signature over the fields that constitute a MATERIAL change.
 * Deliberately excludes elapsedMs/capturedAt/activity.at, continuously
 * varying derived values must not wake subscribers every tick.
 * Joined with an escaped NUL so no printable field value can collide.
 */
function snapshotSignature(nodes: readonly ProcessNode[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    parts.push(
      node.id,
      node.kind,
      node.parentId ?? '',
      node.state,
      node.label,
      String(node.completedAt ?? ''),
      node.usage
        ? `${node.usage.inputTokens}:${node.usage.outputTokens}:${node.usage.toolCallCount}:${node.usage.turnCount}`
        : '',
      node.currentActivity ? `${node.currentActivity.kind}=${node.currentActivity.text}` : '', node.needsAttention ? `!${node.needsAttention.reason}` : '',
      String(node.costUsd ?? ''),
      node.costState,
      node.sessionRef?.sessionId ?? '',
    );
  }
  return parts.join('\u0000');
}

/** Create the live process registry over the already-composed managers. */
export function createProcessRegistry(deps: ProcessRegistryDeps): ProcessRegistry {
  const now = deps.now ?? ((): number => Date.now());
  const stalledThresholdMs = deps.stalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS;
  const stallTellMs = deps.stallTellMs ?? DEFAULT_STALL_TELL_MS;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const timers = deps.timers ?? defaultTimers;

  // ── Activity side-table (the only liveness mechanism, registry-owned) ─────
  const activity = new Map<string, AgentActivityEntry>();
  // Headline side-table: task/phase-identity-keyed, replaced in place on
  // transitions only (see headlines.ts, the anti-feed contract lives there).
  const headlines = new HeadlineTable();
  const busUnsubscribers: Array<() => void> = [];
  let disposed = false;

  function recordActivity(agentId: string, entry: Omit<AgentActivityEntry, 'at'>): void {
    activity.set(agentId, { ...entry, at: now() });
  }

  if (deps.runtimeBus) {
    busUnsubscribers.push(
      deps.runtimeBus.onDomain('agents', (envelope) => {
        const event = envelope.payload;
        const prior = activity.get(event.agentId);
        switch (event.type) {
          case 'AGENT_SPAWNING':
            recordActivity(event.agentId, { state: 'queued' });
            break;
          case 'AGENT_RUNNING':
          case 'AGENT_AWAITING_MESSAGE':
          case 'AGENT_FINALIZING':
            recordActivity(event.agentId, { state: 'thinking', activity: prior?.activity });
            break;
          case 'AGENT_AWAITING_TOOL':
            recordActivity(event.agentId, {
              state: 'executing-tool',
              activity: { kind: 'tool', text: event.tool, toolName: event.tool, at: now() },
            });
            break;
          case 'AGENT_STREAM_DELTA':
            recordActivity(event.agentId, { state: 'streaming', activity: prior?.activity });
            break;
          case 'AGENT_PROGRESS':
            // progress is already `Turn N · ToolName` (orchestrator-runner).
            recordActivity(event.agentId, {
              state: 'executing-tool',
              activity: { kind: 'phase', text: event.progress, at: now() },
            });
            break;
          case 'AGENT_COMPLETED':
            recordActivity(event.agentId, { state: 'done', activity: prior?.activity });
            break;
          case 'AGENT_FAILED':
            recordActivity(event.agentId, { state: 'failed', activity: prior?.activity });
            break;
          default:
            break;
        }
      }),
    );
    busUnsubscribers.push(
      deps.runtimeBus.on(
        'STREAM_RETRY',
        (envelope: RuntimeEventEnvelope<'STREAM_RETRY', Extract<TurnEvent, { type: 'STREAM_RETRY' }>>) => {
          const agentId = envelope.agentId;
          if (!agentId) return;
          const prior = activity.get(agentId);
          recordActivity(agentId, { state: 'retrying', activity: prior?.activity });
        },
      ),
    );
  }

  // ── Query assembly (aggregate-on-read, all O(n) in-memory scans) ──────────

  function collectPendingApprovals(): { agentIds: Set<string>; sessionIds: Set<string> } {
    const agentIds = new Set<string>();
    const sessionIds = new Set<string>();
    if (!deps.approvalBroker) return { agentIds, sessionIds };
    try {
      for (const approval of deps.approvalBroker.listApprovals(200)) {
        if (approval.status !== 'pending') continue;
        const metaAgentId = approval.metadata['agentId'];
        if (typeof metaAgentId === 'string' && metaAgentId.length > 0) agentIds.add(metaAgentId);
        if (approval.sessionId) sessionIds.add(approval.sessionId);
      }
    } catch (error) {
      logger.warn('[fleet] approval cross-reference failed', { error: summarizeError(error) });
    }
    return { agentIds, sessionIds };
  }

  function collectSessionBindings(): Map<string, string> {
    const byAgentId = new Map<string, string>();
    if (!deps.sessionBroker) return byAgentId;
    try {
      for (const session of deps.sessionBroker.listSessions(500)) {
        if (session.activeAgentId) byAgentId.set(session.activeAgentId, session.id);
        if (session.lastAgentId && !byAgentId.has(session.lastAgentId)) {
          byAgentId.set(session.lastAgentId, session.id);
        }
      }
    } catch (error) {
      logger.warn('[fleet] session binding scan failed', { error: summarizeError(error) });
    }
    return byAgentId;
  }

  function assemble(): { capturedAt: number; nodes: ProcessNode[] } {
    const capturedAt = now();
    const agents: AgentRecord[] = deps.agentManager.list();
    const contracts: readonly ContractView[] = deps.contractRunner.list({ includeTerminal: true });
    const contractIds = new Set<string>(contracts.map((contract) => contract.id));
    const unitNodeIds = new Set<string>();
    for (const contract of contracts) {
      for (const unit of allContractUnits(contract)) unitNodeIds.add(contractUnitNodeId(contract.id, unit.id));
    }
    const agentIds = new Set<string>(agents.map((record) => record.id));
    const agentIdByOrchestrationNodeId = new Map<string, string>();
    for (const record of agents) {
      if (record.orchestrationNodeId) agentIdByOrchestrationNodeId.set(record.orchestrationNodeId, record.id);
    }
    const { agentIds: pendingApprovalAgentIds, sessionIds: pendingApprovalSessionIds } = collectPendingApprovals();
    const sessionIdByAgentId = collectSessionBindings();

    const agentCtx: AgentAdapterContext = {
      now: capturedAt,
      stalledThresholdMs,
      activity,
      liveness: deps.runtimeBus !== undefined,
      pendingApprovalAgentIds,
      pendingApprovalSessionIds,
      sessionIdByAgentId,
      contractIds,
      unitNodeIds,
      agentIdByOrchestrationNodeId,
      agentIds,
      priceUsage: deps.priceUsage,
      priceProvenance: deps.priceProvenance,
      messageBusPresent: deps.messageBus !== undefined,
    };

    const nodes: ProcessNode[] = [];
    const agentNodeById = new Map<string, ProcessNode>();
    for (const record of agents) {
      const node = adaptAgent(record, agentCtx);
      agentNodeById.set(node.id, node);
      nodes.push(node);
    }

    // Owner agent nodes to replace with a repriced copy after the contract loop
    // (ProcessNode is readonly, collect overrides, apply in one pass at the end).
    const ownerNodeOverrides = new Map<string, ProcessNode>();
    const agentNodesOf = (agentIds: readonly string[]): ProcessNode[] => [...new Set(agentIds)]
      .map((agentId) => agentNodeById.get(agentId))
      .filter((node): node is ProcessNode => node !== undefined);
    for (const contract of contracts) {
      const units = allContractUnits(contract);
      // Members exclude the owner: it runs no model, and its usage is filled
      // FROM these agents when the contract ends, so counting it would double.
      const memberNodes = agentNodesOf([...contract.plannerAgentIds, ...contract.units.flatMap((unit) => unit.agentIds)])
        .filter((node) => node.id !== contract.ownerAgentId);
      const contractNode = adaptContract(contract, memberNodes, capturedAt);
      nodes.push(contractNode);
      const ownerNode = agentNodeById.get(contract.ownerAgentId);
      if (ownerNode) {
        const repriced = repriceContractOwnerNode(ownerNode, contractNode);
        if (repriced !== ownerNode) ownerNodeOverrides.set(ownerNode.id, repriced);
      }
      for (const group of contract.groups) {
        const groupAgents = contract.units.filter((unit) => unit.groupId === group.id).flatMap((unit) => unit.agentIds);
        nodes.push(adaptContractGroup(group, contract, agentNodesOf(groupAgents), capturedAt));
      }
      for (const unit of units) {
        nodes.push(adaptContractUnit(unit, contract, {
          activeAgent: unit.activeAgentId !== undefined ? agentNodeById.get(unit.activeAgentId) : undefined,
          memberNodes: agentNodesOf(unit.agentIds),
          messageBusPresent: deps.messageBus !== undefined,
          now: capturedAt,
        }));
      }
    }

    for (const instance of deps.workflow.workflowManager.list()) {
      nodes.push(adaptWorkflow(instance, capturedAt));
    }
    for (const trigger of deps.workflow.triggerManager.list()) {
      nodes.push(adaptTrigger(trigger));
    }
    if (deps.triggerSupervisor) {
      for (const record of deps.triggerSupervisor.list()) {
        nodes.push(adaptWatcherTrigger(record, capturedAt));
      }
    }
    for (const schedule of deps.workflow.scheduleManager.list()) {
      nodes.push(adaptSchedule(schedule));
    }
    if (deps.automationManager) {
      for (const job of deps.automationManager.listJobs()) {
        nodes.push(adaptAutomationJob(job));
      }
    }
    for (const watcher of deps.watcherRegistry.list()) {
      nodes.push(adaptWatcher(watcher, capturedAt));
    }
    for (const summary of deps.processManager.list()) {
      const record = deps.processManager.getStatus(summary.id);
      if (record) nodes.push(adaptBackgroundProcess(record, capturedAt));
    }
    if (deps.acpHost) {
      for (const hosted of deps.acpHost.list()) nodes.push(adaptHostedAcpAgent(hosted, capturedAt));
    }
    if (deps.observedAgents) {
      for (const row of deps.observedAgents.list()) nodes.push(adaptObservedAgent(row, capturedAt));
    }
    if (deps.codeIndexService) {
      nodes.push(adaptCodeIndex(deps.codeIndexService, capturedAt));
    }

    const withOverrides = ownerNodeOverrides.size > 0
      ? nodes.map((node) => ownerNodeOverrides.get(node.id) ?? node)
      : nodes;
    // Read-model projections every surface inherits: the per-node headline
    // (task/phase identity only, replaced in place, never a feed) and the
    // stall tell (pure timestamp comparison, no generated text).
    const liveIds = new Set<string>();
    const finalNodes = withOverrides.map((node) => {
      liveIds.add(node.id);
      const headline = headlines.derive(node, capturedAt);
      const stall = deriveStallTell(node, capturedAt, stallTellMs);
      if (!headline && !stall) return node;
      return { ...node, ...(headline ? { headline } : {}), ...(stall ? { stall } : {}) };
    });
    headlines.prune(liveIds);
    return { capturedAt, nodes: finalNodes };
  }

  function query(filter?: FleetQueryFilter): FleetSnapshot {
    const { capturedAt, nodes } = assemble();
    let selected: readonly ProcessNode[] = nodes;
    if (filter?.kinds && filter.kinds.length > 0) {
      const kinds = new Set(filter.kinds);
      selected = selected.filter((node) => kinds.has(node.kind));
    }
    if (filter?.states && filter.states.length > 0) {
      const states = new Set(filter.states);
      selected = selected.filter((node) => states.has(node.state));
    }
    return { capturedAt, nodes: selected };
  }

  function getNode(id: string): ProcessNode | null {
    const { nodes } = assemble();
    return nodes.find((node) => node.id === id) ?? null;
  }

  // ── Coalesced tick + subscription ──────────────────────────────────────────

  const listeners = new Set<(snapshot: FleetSnapshot) => void>();
  let tickHandle: unknown = null;
  let lastSignature: string | null = null;

  function tick(): void {
    if (listeners.size === 0) return;
    const snapshot = query();
    const signature = snapshotSignature(snapshot.nodes);
    if (signature === lastSignature) return;
    lastSignature = signature;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        logger.warn('[fleet] subscriber threw', { error: summarizeError(error) });
      }
    }
  }

  function startTicking(): void {
    if (tickHandle !== null) return;
    tickHandle = timers.setInterval(tick, tickIntervalMs);
    // Never pin the event loop: an idle runtime must be able to exit even if
    // a consumer forgot to dispose (mirrors ScheduleManager.destroy hygiene).
    unrefHandle(tickHandle);
  }

  function stopTicking(): void {
    if (tickHandle === null) return;
    timers.clearInterval(tickHandle);
    tickHandle = null;
    lastSignature = null;
  }

  function subscribe(listener: (snapshot: FleetSnapshot) => void): () => void {
    if (disposed) return () => undefined;
    listeners.add(listener);
    startTicking();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) stopTicking();
    };
  }

  // ── Control dispatch (existing manager paths only) ─────────────────────────

  /** A contract unit node's working agent: the one its capabilities were derived from. */
  function activeUnitAgentId(node: ProcessNode): string | undefined {
    if (!node.capabilities.killable) return undefined;
    const { unit } = node.raw as { unit: { activeAgentId?: string | undefined } };
    return unit.activeAgentId;
  }

  /** Cascade kill over member agents, always a hard kill, never an interrupt. */
  function cancelAgents(agentIds: readonly (string | undefined)[]): string[] {
    const affected: string[] = [];
    for (const agentId of agentIds) {
      if (agentId && deps.agentManager.cancel(agentId, 'kill')) affected.push(agentId);
    }
    return affected;
  }

  /**
   * Fire-and-forget an AutomationManager async control call: the
   * registry's own kill/interrupt/resume verbs are
   * synchronous, but AutomationManager.removeJob/setEnabled are Promises,
   * dispatch without awaiting rather than making every registry verb async,
   * but never let a rejection vanish silently. The next tick's assemble()
   * reflects the real outcome once the promise settles (mirrors the
   * existing TUI automation-control-panel's swallow-and-tick behavior).
   */
  function dispatchAutomationOp(op: 'kill' | 'pause' | 'resume', jobId: string, promise: Promise<unknown>): void {
    promise.catch((error) => {
      logger.warn(`[fleet] automation job ${op} failed`, { jobId, error: summarizeError(error) });
    });
  }

  /** Primitive per-kind kill. Returns the node ids actually acted on. */
  function killNode(node: ProcessNode): string[] {
    switch (node.kind) {
      case 'agent':
        return deps.agentManager.cancel(node.id, 'kill') ? [node.id] : [];
      case 'background-process':
        return deps.processManager.stop(node.id) ? [node.id] : [];
      case 'watcher':
        return deps.watcherRegistry.stopWatcher(node.id) !== null ? [node.id] : [];
      case 'workflow':
        return deps.workflow.workflowManager.cancel(node.id) ? [node.id] : [];
      case 'trigger':
        // Two managers share this kind. Ask the raw payload which one owns the
        // node rather than assuming, routing to the wrong manager would
        // silently no-op and leave a supervised child process running.
        if (isWatcherTriggerRaw(node.raw)) {
          if (!deps.triggerSupervisor) return [];
          return deps.triggerSupervisor.cancel(node.id) !== null ? [node.id] : [];
        }
        return deps.workflow.triggerManager.remove(node.id) ? [node.id] : [];
      case 'schedule': {
        if (isAutomationJobRaw(node.raw)) {
          if (!deps.automationManager) return [];
          const jobId = node.raw.job.id;
          dispatchAutomationOp('kill', jobId, deps.automationManager.removeJob(jobId));
          return [node.id];
        }
        const entry = node.raw as ScheduleEntry;
        return deps.workflow.scheduleManager.remove(entry.name) ? [node.id] : [];
      }
      case 'contract': {
        const contract = node.raw as ContractView;
        return deps.contractRunner.cancel(contract.id, 'stopped by the operator') ? [node.id] : [];
      }
      case 'contract-group': {
        // The group's working unit agents. The runner reads an operator
        // cancel of a unit agent as a stop of its contract (design 6.5).
        const { contract, group } = node.raw as { contract: ContractView; group: { id: string } };
        const agentIds = allContractUnits(contract)
          .filter((unit) => unit.groupId === group.id && unit.activeAgentId !== undefined)
          .map((unit) => unit.activeAgentId);
        const affected = cancelAgents(agentIds);
        return affected.length > 0 ? [node.id, ...affected] : [];
      }
      case 'contract-unit': {
        const agentId = activeUnitAgentId(node);
        return agentId !== undefined && deps.agentManager.cancel(agentId, 'kill') ? [node.id, agentId] : [];
      }
      case 'acp-agent':
        return killHostedAcpNode(deps.acpHost, node, (hostedId, error) => logger.warn('[fleet] hosted ACP agent stop failed', { id: hostedId, error: summarizeError(error) }));
      default:
        return [];
    }
  }

  function kill(id: string, opts?: ProcessKillOptions): readonly string[] {
    const { nodes } = assemble();
    const target = nodes.find((node) => node.id === id);
    if (!target) return [];
    const affected = new Set<string>();
    const targets: ProcessNode[] = [target];
    if (opts?.cascade) {
      // Children first, depth-first, so leaves stop before their parents.
      const byParent = new Map<string, ProcessNode[]>();
      for (const node of nodes) {
        if (!node.parentId) continue;
        const siblings = byParent.get(node.parentId) ?? [];
        siblings.push(node);
        byParent.set(node.parentId, siblings);
      }
      const stack = [target];
      const descendants: ProcessNode[] = [];
      const seen = new Set<string>([target.id]);
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const child of byParent.get(current.id) ?? []) {
          if (seen.has(child.id)) continue;
          seen.add(child.id);
          descendants.push(child);
          stack.push(child);
        }
      }
      targets.unshift(...descendants.reverse());
    }
    for (const node of targets) {
      for (const affectedId of killNode(node)) affected.add(affectedId);
    }
    // Contract-kill consistency: under cascade, unit agents are terminated by
    // the descendant pass BEFORE the contract's own killNode runs, and the
    // runner reads that as a stop of the contract, so the contract's own
    // cancel then finds it already ended and omits 'contract:<id>', even
    // though the contract was the kill target and a termination did occur.
    // Include the contract id whenever it was targeted and either a
    // termination occurred or it was still live.
    if (target.kind === 'contract' && (affected.size > 0 || target.capabilities.killable)) {
      affected.add(target.id);
    }
    return [...affected];
  }

  function interrupt(id: string): boolean {
    const { nodes } = assemble();
    const target = nodes.find((node) => node.id === id);
    if (!target) return false;
    switch (target.kind) {
      case 'agent':
        return deps.agentManager.cancel(target.id, 'interrupt');
      case 'trigger':
        // The trigger family has no disable/enable pause cycle, its records
        // are either armed, walking the backoff ladder, or parked by the
        // breaker. Refuse honestly instead of pretending to pause one.
        if (isWatcherTriggerRaw(target.raw)) return false;
        return deps.workflow.triggerManager.disable(target.id);
      case 'schedule': {
        if (isAutomationJobRaw(target.raw)) {
          if (!deps.automationManager) return false;
          const jobId = target.raw.job.id;
          dispatchAutomationOp('pause', jobId, deps.automationManager.setEnabled(jobId, false));
          return true;
        }
        const entry = target.raw as ScheduleEntry;
        return deps.workflow.scheduleManager.disable(entry.name);
      }
      case 'contract-unit': {
        const agentId = activeUnitAgentId(target);
        return agentId !== undefined ? deps.agentManager.cancel(agentId, 'interrupt') : false;
      }
      default:
        return false;
    }
  }

  /**
   * Re-arm a `paused` trigger/schedule via the owning
   * manager's `enable()`, the inverse of interrupt()'s disable. Re-assemble
   * + dispatch-by-kind mirrors interrupt()/kill()'s own shape exactly (same
   * synchronous, no-owned-state pattern as every other control verb here).
   * Honest refusal (false, never throws) for anything not currently
   * resumable: not found, already armed, terminal, or a kind with no
   * enable-based pause/resume cycle at all (e.g. an agent).
   */
  function resume(id: string): boolean {
    const { nodes } = assemble();
    const target = nodes.find((node) => node.id === id);
    if (!target || !target.capabilities.resumable) return false;
    switch (target.kind) {
      case 'trigger':
        // For a trigger-family node, resumable means "the breaker is open".
        // Resuming it IS the explicit operator reset the breaker waits for.
        if (isWatcherTriggerRaw(target.raw)) {
          if (!deps.triggerSupervisor) return false;
          return deps.triggerSupervisor.reset(target.id) !== null;
        }
        return deps.workflow.triggerManager.enable(target.id);
      case 'schedule': {
        if (isAutomationJobRaw(target.raw)) {
          if (!deps.automationManager) return false;
          const jobId = target.raw.job.id;
          dispatchAutomationOp('resume', jobId, deps.automationManager.setEnabled(jobId, true));
          return true;
        }
        const entry = target.raw as ScheduleEntry;
        return deps.workflow.scheduleManager.enable(entry.name);
      }
      default:
        return false;
    }
  }

  /**
   * Queue a human message onto a live in-process agent's inbox (or the
   * live agent of a contract unit). Mirrors interrupt()/kill()
   * dispatch shape: re-assemble, find the target, switch on kind.
   *
   * Honest refusal for anything that cannot take mid-run input: no
   * messageBus dep, a terminal/non-conversational kind, or a contract or
   * contract group (no conversation loop of their own, steer a unit
   * instead).
   */
  function steer(id: string, text: string): SteerResult {
    const { nodes } = assemble();
    const target = nodes.find((node) => node.id === id);
    if (!target) return { queued: false, reason: 'no such process' };
    // A hosted ACP agent's steer travels over its own stdio connection (no message bus needed).
    if (target.kind === 'acp-agent') return steerHostedAcpNode(deps.acpHost, target, text);
    // An observed foreign agent's steer travels over its own control channel (tmux send-keys); stop is never offered.
    if (target.kind === 'observed-external') return steerObservedNode(deps.observedAgents, target, text);
    if (!deps.messageBus) {
      return { queued: false, reason: 'steering is unavailable: no message bus configured' };
    }
    switch (target.kind) {
      case 'agent': {
        if (!target.capabilities.steerable) {
          // A wedged agent whose loop has definitively exited ('failed':
          // exhausted turn/circuit-breaker loop, idle-after-error, watchdog kill)
          // is re-triggered from its retained context with the steer as input,
          // rather than silently refused. A 'stalled' (still-running, no
          // heartbeat) agent is NOT re-run, that would race a live promise; its
          // steer stays refused honestly rather than falsely claimed delivered.
          if (target.state === 'failed' && deps.agentManager.wakeWithSteer) {
            const woke = deps.agentManager.wakeWithSteer(target.id, text);
            return woke.woke
              ? { queued: true, messageId: crypto.randomUUID(), woke: true }
              : { queued: false, reason: woke.reason };
          }
          return { queued: false, reason: 'agent is not active and cannot be steered' };
        }
        const messageId = crypto.randomUUID();
        const sent = deps.messageBus.send('operator', target.id, text, {
          kind: 'steer',
          ttlMs: STEER_TTL_MS,
          id: messageId,
        });
        return sent ? { queued: true, messageId } : { queued: false, reason: 'steering message was blocked' };
      }
      case 'contract-unit': {
        const agentId = activeUnitAgentId(target);
        if (agentId === undefined || !target.capabilities.steerable) {
          return { queued: false, reason: 'no live agent to steer for this unit' };
        }
        const messageId = crypto.randomUUID();
        const sent = deps.messageBus.send('operator', agentId, text, { kind: 'steer', ttlMs: STEER_TTL_MS, id: messageId });
        return sent ? { queued: true, messageId } : { queued: false, reason: 'steering message was blocked' };
      }
      case 'contract':
        return { queued: false, reason: 'steer a unit, not the contract' };
      case 'contract-group':
        return { queued: false, reason: 'steer a unit, not the group' };
      default:
        return { queued: false, reason: `${target.kind} cannot take steering input` };
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    stopTicking();
    for (const unsubscribe of busUnsubscribers) {
      try {
        unsubscribe();
      } catch (error) {
        logger.warn('[fleet] bus unsubscribe failed on dispose', { error: summarizeError(error) });
      }
    }
    busUnsubscribers.length = 0;
    listeners.clear();
    activity.clear();
  }

  return { query, getNode, subscribe, interrupt, kill, resume, steer, dispose };
}
