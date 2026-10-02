import { ArchetypeLoader } from '../../agents/archetypes.js';
import { AgentOrchestrator } from '../../agents/orchestrator.js';
import { AgentMessageBus } from '../../agents/message-bus.js';
import type { ContractRunner } from '../../contract/runner.js';
import type { ConfigManager } from '../../config/manager.js';
import type { ConversationMessageSnapshot } from '../../core/conversation.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import {
  emitAgentCancelled,
  emitAgentSpawning,
  emitContractSpawnGuardTriggered,
} from '../../runtime/emitters/index.js';
import type { AgentTaskContract } from '../../runtime/events/index.js';
import { evaluateOrchestrationSpawn } from '../../runtime/orchestration/spawn-policy.js';
import { logger } from '../../utils/logger.js';
import type { AgentInput } from './schema.js';
import { summarizeError } from '../../utils/error-display.js';
import { OwnedWork } from '../../utils/owned-work.js';
import { splitModelRegistryKey } from '../../providers/registry-helpers.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { requireProviderQualifiedModel, normalizeProviderQualifiedModelList } from './model-routing.js';
import type { AgentRecord } from './record.js';
import { splitContractBinding, startContractOwner, type ContractOwnerBinding, type ContractUnitBinding } from './contract-binding.js';

export type { AgentRecord } from './record.js';

export type AgentExecutor = {
  runAgent(record: AgentRecord): Promise<void>;
};

export interface AgentManagerDependencies {
  readonly archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'> | undefined;
  readonly messageBus?: Pick<AgentMessageBus, 'registerAgent'> | undefined;
  /** Starts the contract a spawn that is not outside every contract becomes the owner of (design 10.3). */
  readonly contractRunner?: AgentContractRunner | null | undefined;
  readonly executor?: AgentExecutor | null | undefined;
  readonly configManager?: Pick<ConfigManager, 'get'> | undefined;
  /**
   * Bound on how many finished agents' final conversation snapshot are kept
   * in the retention ring (see getConversationSnapshot). Defaults to
   * DEFAULT_CONVERSATION_SNAPSHOT_RETENTION. Test-only knob in practice.
   */
  readonly conversationSnapshotRetention?: number | undefined;
  /** The live provider registry, when wired up, enables bare model id resolution for spawn() overrides. */
  readonly providerRegistry?: Pick<ProviderRegistry, 'listModels'> | undefined;
}

export type { ContractOwnerBinding, ContractUnitBinding } from './contract-binding.js';
/**
 * Conversation-snapshot tab attach point (Part C6): default bound on how many recently
 * finished agents' final conversation snapshot AgentManager keeps around
 * after their live source is released. Without a bound, a long-lived process
 * that spawns many short-lived agents would retain every finished agent's
 * full message history forever, this is the "leaking unbounded memory" the
 * brief calls out. RUNNING agents are unaffected by this bound: their
 * snapshot is read live from the still-open ConversationManager, whose size
 * is already governed by the existing context-window compaction machinery
 * (core/context-compaction.ts), not by this retention ring.
 */
export const DEFAULT_CONVERSATION_SNAPSHOT_RETENTION = 20;

export const AGENT_TEMPLATES: Record<string, { description: string; defaultTools: string[] }> = {
  orchestrator: {
    description: 'Contract owner: represents a contract and carries its answer',
    defaultTools: ['read', 'find', 'analyze', 'inspect', 'registry'],
  },
  planner: {
    description: 'Read-only goal-decomposition agent (no write/edit/exec/delegate)',
    defaultTools: ['read', 'find', 'analyze', 'inspect'],
  },
  engineer: {
    description: 'Full-stack implementation agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  reviewer: {
    description: 'Code review and quality assessment',
    defaultTools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  tester: {
    description: 'Test writing and execution',
    defaultTools: ['read', 'write', 'find', 'exec', 'analyze', 'inspect'],
  },
  researcher: {
    description: 'Codebase exploration and analysis',
    defaultTools: ['read', 'find', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  integrator: {
    description: 'Cross-deliverable integration agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
  },
  general: {
    description: 'General purpose agent',
    defaultTools: ['read', 'write', 'edit', 'find', 'exec', 'analyze', 'inspect', 'fetch', 'registry'],
  },
};


/** Legacy starts remain valid; owned starts require an explicit real receipt. */
export type AgentContractRunner = Pick<ContractRunner, 'startForOwner'> & Partial<Pick<ContractRunner, 'assertOwnedExecution' | 'startOwnedForOwner'>>;

/** An owned spawn was refused before admission because its driver cannot join. */
export class OwnedAgentExecutionUnavailableError extends Error {
  override readonly name = 'OwnedAgentExecutionUnavailableError';
  readonly code = 'OWNED_AGENT_EXECUTION_UNSUPPORTED' as const;
}

/** One captured invocation, not a later wake of the same mutable agent record. */
export interface OwnedAgentExecution {
  readonly record: AgentRecord;
  /** Immutable-at-settlement snapshot, taken before any queued wake starts. */
  readonly settled: Promise<AgentRecord>;
  cancel(): void;
}

interface OwnedSpawnContext {
  reserved(record: AgentRecord, slot: AgentExecutionSlot): void;
  startContract(record: AgentRecord): { readonly settled: Promise<void>; cancel(reason: string): boolean };
}

interface AgentExecutionSlot {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  active: boolean;
}

interface AgentExecutionState {
  readonly work: OwnedWork;
  readonly slots: Set<AgentExecutionSlot>;
  tail?: Promise<void> | undefined;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  /** Actual per-agent invocations; terminal records alone do not prove cleanup. */
  private readonly executions = new Map<string, AgentExecutionState>();
  private runtimeBus: RuntimeEventBus | null = null;
  private readonly archetypeLoader: Pick<ArchetypeLoader, 'loadArchetype'>;
  private readonly messageBus: Pick<AgentMessageBus, 'registerAgent'>;
  private contractRunner: AgentContractRunner | null;
  private executor: AgentExecutor | null;
  private readonly configManager: Pick<ConfigManager, 'get'> | null;
  /**
   * Live snapshot accessors for RUNNING agents (conversation-snapshot bridge, Part C6).
   * Registered by the executor (orchestrator-runner.ts) right after it
   * creates the agent's ConversationManager; the manager never stores
   * messages itself while an agent is running, it just holds a callback.
   */
  private readonly conversationSources = new Map<string, () => ConversationMessageSnapshot[]>();
  /**
   * Cooperative cancellation bridge: per-agent AbortSignal
   * registered by an orchestration-engine work item for the duration of one
   * phase run. AgentOrchestrator reads this via
   * setCancellationSource/getCancellationSignal and threads it into
   * toolRegistry.execute opts so opted-in tools (exec, fetch) can abort an
   * in-flight child process/request immediately, instead of only at the next
   * turn boundary's status poll. Purely additive, no caller is required to
   * register anything, and an agent with no registered signal behaves
   * exactly as before this change.
   */
  private readonly cancellationSignals = new Map<string, AbortSignal>();
  /**
   * Manager-owned abort controllers, one per agent, the seam that lets
   * cancel()/kill genuinely abort an in-flight provider call (not only
   * cooperatively at the next turn/tool boundary). An orchestration engine may
   * ALSO register its own signal via registerCancellationSignal (that one wins
   * in getCancellationSignal so the engine's own kill path is unchanged); a
   * plain broker/ACP-spawned agent has no external signal and falls back to this
   * owned controller, which cancel() aborts.
   */
  private readonly cancellationControllers = new Map<string, AbortController>();
  /**
   * Frozen final snapshots for agents whose live source was released (their
   * run ended). Map insertion order doubles as the bounded ring's age order:
   * oldest entry (first key) is evicted once conversationSnapshotRetention is
   * exceeded. See getConversationSnapshot for the read-side contract.
   */
  private readonly frozenConversationSnapshots = new Map<string, ConversationMessageSnapshot[]>();
  private readonly conversationSnapshotRetention: number;
  private readonly providerRegistry: Pick<ProviderRegistry, 'listModels'> | null;

  constructor(deps: AgentManagerDependencies = {}) {
    this.archetypeLoader = deps.archetypeLoader ?? new ArchetypeLoader();
    this.messageBus = deps.messageBus ?? new AgentMessageBus();
    this.providerRegistry = deps.providerRegistry ?? null;
    this.contractRunner = deps.contractRunner ?? null;
    this.executor = deps.executor ?? null;
    this.configManager = deps.configManager ?? null;
    this.conversationSnapshotRetention = deps.conversationSnapshotRetention ?? DEFAULT_CONVERSATION_SNAPSHOT_RETENTION;
  }

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  private deriveEffectiveTools(
    input: AgentInput,
    defaultTools: string[],
  ): {
    tools: string[];
    capabilityCeilingTools?: string[] | undefined;
  } {
    const requestedTools = input.restrictTools
      ? [...(input.tools ?? [])]
      : input.tools
        ? [...new Set([...defaultTools, ...input.tools])]
        : [...defaultTools];

    if (!input.parentAgentId) {
      return { tools: requestedTools };
    }

    const parentRecord = this.agents.get(input.parentAgentId);
    if (!parentRecord) {
      throw new Error(`Unknown parent agent: '${input.parentAgentId}'`);
    }

    if (parentRecord.contractRole === 'owner' && input.outsideContract) {
      return {
        tools: requestedTools,
        capabilityCeilingTools: requestedTools,
      };
    }

    const parentCeiling = parentRecord.capabilityCeilingTools ?? parentRecord.tools;
    const tools = requestedTools.filter((tool) => parentCeiling.includes(tool));
    if (tools.length === 0) {
      throw new Error(`Spawned child agent would exceed parent capability ceiling from '${input.parentAgentId}'`);
    }

    return {
      tools,
      capabilityCeilingTools: [...parentCeiling],
    };
  }

  /**
   * Refuses a spawn requested by a contract leaf (design 10.3): a unit's
   * sub-agent or the contract planner never spawns agents of its own; the
   * contract plans sub-work. Emits CONTRACT_SPAWN_GUARD_TRIGGERED and throws.
   * AgentManager.spawn and the agent tool both call it before anything starts,
   * so the refusal is decided in this one place.
   */
  guardContractLeafSpawn(requesterAgentId: string | undefined): void {
    if (requesterAgentId === undefined) return;
    const requester = this.agents.get(requesterAgentId);
    if (!requester?.contractId || requester.contractRole === 'owner' || requester.contractRole === undefined) return;
    const reason = requester.contractRole === 'unit'
      ? 'units are leaves; the contract plans sub-work'
      : 'the contract planner is read-only; the contract plans sub-work';
    if (this.runtimeBus) {
      emitContractSpawnGuardTriggered(this.runtimeBus, {
        sessionId: 'agent-manager',
        traceId: `agent-manager:spawn-guard:${requester.id}`,
        source: 'agent-manager',
        agentId: requester.id,
      }, {
        contractId: requester.contractId,
        agentId: requester.id,
        depth: requester.orchestrationDepth + 1,
        activeAgents: this.list().filter((agent) => agent.status === 'pending' || agent.status === 'running').length,
        reason,
      });
    }
    throw new Error(reason);
  }

  /**
   * Spawn an agent. `binding` marks it as a contract unit's sub-agent (the
   * phase runner passes it for a contract work item) or as a contract's owner
   * record (the contract runner passes it). A spawn with neither binding and
   * without `outsideContract` becomes the owner of a new contract through the
   * composed contract runner's startForOwner, and runs no executor.
   */
  spawn(input: AgentInput, spawnBinding?: ContractUnitBinding | ContractOwnerBinding): AgentRecord {
    return this.spawnInternal(input, spawnBinding);
  }

  /**
   * Captures one spawn's cancellation and genuine settlement before publishing
   * it. A legacy contract driver is refused before any record/event/work exists.
   */
  spawnOwned(input: AgentInput, options: { readonly signal?: AbortSignal | undefined } = {}): OwnedAgentExecution {
    options.signal?.throwIfAborted();
    const startOwned = this.contractRunner?.startOwnedForOwner;
    if (!input.outsideContract) {
      if (typeof startOwned !== 'function' || typeof this.contractRunner?.assertOwnedExecution !== 'function') {
        throw new OwnedAgentExecutionUnavailableError('Owned agent spawn requires a contract runner with owned execution settlement');
      }
      try {
        this.contractRunner.assertOwnedExecution();
      } catch (error) {
        throw new OwnedAgentExecutionUnavailableError(summarizeError(error));
      }
    }
    let handle: OwnedAgentExecution | undefined;
    let abortRequested = false;
    let cancelContract: ((reason: string) => boolean) | undefined;
    const onAbort = (): void => { abortRequested = true; handle?.cancel(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    try {
      if (abortRequested) options.signal!.throwIfAborted();
      this.spawnInternal(input, undefined, {
        reserved: (record, slot) => {
          // Attach this snapshot before a re-entrant observer can queue a wake.
          const settled = slot.settled.then(() => structuredClone(record));
          handle = {
            record,
            settled,
            cancel: () => {
              if (!slot.active) return;
              const cancelRecord = record.status === 'pending' || record.status === 'running';
              if (cancelRecord) {
                record.status = 'cancelled';
                record.terminationKind = 'kill';
                record.completedAt = Date.now();
              }
              slot.controller.abort();
              cancelContract?.('the owning hook was cancelled');
              if (cancelRecord && this.runtimeBus) {
                emitAgentCancelled(this.runtimeBus, {
                  sessionId: 'agent-manager', traceId: `agent-manager:${record.id}:cancel`, source: 'agent-manager', agentId: record.id,
                }, { agentId: record.id, reason: 'owning hook cancellation' });
              }
            },
          };
          void settled.then(
            () => options.signal?.removeEventListener('abort', onAbort),
            () => options.signal?.removeEventListener('abort', onAbort),
          );
          if (abortRequested) handle.cancel();
        },
        startContract: (record) => {
          const started = startOwned!.call(this.contractRunner, record);
          cancelContract = (reason) => started.cancel(reason);
          if (abortRequested) cancelContract('the owning hook was cancelled');
          return started;
        },
      });
      return handle!;
    } catch (error) {
      options.signal?.removeEventListener('abort', onAbort);
      throw error;
    }
  }

  private spawnInternal(input: AgentInput, spawnBinding?: ContractUnitBinding | ContractOwnerBinding, owned?: OwnedSpawnContext): AgentRecord {
    const { unit: binding, owner: ownerBinding } = splitContractBinding(spawnBinding);
    const task = input.task;
    if (!task || typeof task !== 'string' || task.trim() === '') {
      throw new Error('spawn() requires a non-empty task string');
    }
    if (!this.configManager) {
      throw new Error('AgentManager requires configManager');
    }
    this.guardContractLeafSpawn(input.parentAgentId);
    const template = input.template ?? 'general';

    const archetype = this.archetypeLoader.loadArchetype(template);
    const templateDef = AGENT_TEMPLATES[template]! ?? AGENT_TEMPLATES.general;
    const defaultTools = archetype ? archetype.tools : templateDef.defaultTools;
    const toolResolution = this.deriveEffectiveTools(input, defaultTools);
    const tools = toolResolution.tools;

    if (!input.model && archetype?.model) {
      input = { ...input, model: archetype.model };
    }
    if (!input.provider && archetype?.provider) {
      input = { ...input, provider: archetype.provider };
    }

    const parentRecord = input.parentAgentId ? this.agents.get(input.parentAgentId) : undefined;
    if (input.parentAgentId && !parentRecord) {
      throw new Error(`Unknown parent agent: '${input.parentAgentId}'`);
    }
    const orchestrationDepth = parentRecord ? parentRecord.orchestrationDepth + 1 : 0;
    const activeAgents = this.list().filter((agent) => agent.status === 'pending' || agent.status === 'running').length;
    const isContractOwnerChild = Boolean(parentRecord?.contractRole === 'owner' && input.outsideContract);
    const spawnDecision = evaluateOrchestrationSpawn({
      configManager: this.configManager,
      mode: input.parentAgentId && !isContractOwnerChild ? 'recursive-child' : 'manual-batch',
      activeAgents,
      requestedDepth: orchestrationDepth,
      ...(isContractOwnerChild ? { overrides: { recursionEnabled: true, maxDepth: 1 } } : {}),
    });
    if (!spawnDecision.allowed) {
      if (this.runtimeBus) {
        const guardContractId = parentRecord?.contractId;
        emitContractSpawnGuardTriggered(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:spawn-guard:${input.parentAgentId ?? 'root'}`,
          source: 'agent-manager',
          ...(input.parentAgentId ? { agentId: input.parentAgentId } : {}),
        }, {
          ...(guardContractId ? { contractId: guardContractId } : {}),
          agentId: input.parentAgentId ?? 'root',
          depth: orchestrationDepth,
          activeAgents,
          reason: spawnDecision.reason ?? 'spawn policy rejected the child worker',
        });
      }
      throw new Error(spawnDecision.reason ?? 'Spawn policy rejected the child worker');
    }

    const executionProtocol = input.executionProtocol ?? 'gather-plan-apply';
    const reviewMode = input.reviewMode ?? (input.outsideContract && !binding ? 'none' : 'contract');
    const communicationLane = input.communicationLane
      ?? (input.parentAgentId ? 'parent-only' : input.cohort ? 'cohort' : 'direct');
    const modelCandidates = this.providerRegistry?.listModels();
    const provider = input.provider?.trim() || undefined;
    const model = requireProviderQualifiedModel(input.model, 'Agent model overrides', modelCandidates, provider);
    if (!model && provider) {
      throw new Error('Agent provider routing requires a provider-qualified model when provider is supplied.');
    }
    if (model && provider && splitModelRegistryKey(model).providerId !== provider) {
      throw new Error(`Agent model override '${model}' conflicts with provider '${provider}'.`);
    }
    const fallbackModels = normalizeProviderQualifiedModelList(input.fallbackModels, 'Agent fallback models', modelCandidates);
    const routingFallbackModels = normalizeProviderQualifiedModelList(input.routing?.fallbackModels, 'Agent routing fallback models', modelCandidates);
    const effectiveFallbackModels = input.routing?.providerFailurePolicy === 'fail'
      ? undefined
      : routingFallbackModels ?? fallbackModels;
    if (
      input.routing?.providerFailurePolicy === 'ordered-fallbacks'
      && !effectiveFallbackModels?.length
    ) {
      throw new Error('Agent ordered fallback routing requires at least one provider-qualified fallback model.');
    }
    if (input.routing?.providerFailurePolicy === 'fail' && (routingFallbackModels?.length || fallbackModels?.length)) {
      throw new Error('Agent fail routing cannot include fallback models; use ordered-fallbacks to enable model failover.');
    }

    const startsContract = !input.outsideContract && !binding && !ownerBinding;
    if (startsContract && !this.contractRunner) {
      throw new Error('No contract runner is composed: a spawn that is not outside every contract starts a contract, and this AgentManager has no contract runner to start it.');
    }

    const id = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const orchestrationGraphId = input.orchestrationGraphId
      ?? parentRecord?.orchestrationGraphId
      ?? (input.cohort ? `cohort:${input.cohort}` : undefined);
    const orchestrationNodeId = orchestrationGraphId ? (input.orchestrationNodeId ?? id) : undefined;
    const parentNodeId = input.parentNodeId ?? parentRecord?.orchestrationNodeId;
    const record: AgentRecord = {
      id,
      task,
      template,
      model,
      provider,
      fallbackModels: effectiveFallbackModels,
      routing: input.routing
        ? {
            ...input.routing,
            ...(effectiveFallbackModels ? { fallbackModels: effectiveFallbackModels } : {}),
          }
        : undefined,
      executionIntent: input.executionIntent,
      reasoningEffort: input.reasoningEffort,
      context: input.context,
      tools, ...(input.captureAuthority ? { captureAuthority: input.captureAuthority } : {}),
      orchestrationDepth,
      executionProtocol,
      reviewMode,
      communicationLane,
      systemPromptAddendum: input.systemPromptAddendum,
      proposedUnits: input.proposedUnits,
      status: 'pending',
      startedAt: Date.now(),
      toolCallCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmCallCount: 0,
        turnCount: 0,
        reasoningSummaryCount: 0,
      },
      outsideContract: input.outsideContract,
      ...(input.replyStyle ? { replyStyle: input.replyStyle } : {}),
      workingDirectory: input.workingDirectory,
      cohort: input.cohort,

      ...(orchestrationGraphId ? {
        orchestrationGraphId,
        orchestrationNodeId,
      } : {}),
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
      ...(parentNodeId ? { parentNodeId } : {}),
      ...(binding ? { contractId: binding.contractId, contractRole: 'unit' as const, contractUnitId: binding.contractUnitId } : {}),
      ...(ownerBinding ? { contractId: ownerBinding.contractId, contractRole: 'owner' as const } : {}),
      ...(binding?.routeReason ? { routeReason: binding.routeReason } : {}),
      ...(toolResolution.capabilityCeilingTools ? { capabilityCeilingTools: toolResolution.capabilityCeilingTools } : {}),
      ...(input.successCriteria ? { successCriteria: [...input.successCriteria] } : {}),
      ...(input.requiredEvidence ? { requiredEvidence: [...input.requiredEvidence] } : {}),
      ...(input.writeScope ? { writeScope: [...input.writeScope] } : {}),
    };

    this.agents.set(id, record);
    // Reserve before publishing the record or invoking any re-entrant callback.
    const { begin, controller, slot } = this.reserveExecution(id);
    this.cancellationControllers.set(id, controller);
    owned?.reserved(record, slot);
    try {
      this.messageBus.registerAgent({
        agentId: id,
        template,
        parentAgentId: input.parentAgentId,
        cohort: input.cohort,
      });
      if (this.runtimeBus) {
        const taskContract: AgentTaskContract = {
          allowedTools: [...record.tools],
          capabilityCeiling: [...(record.capabilityCeilingTools ?? record.tools)],
          ...(record.successCriteria ? { successCriteria: [...record.successCriteria] } : {}),
          ...(record.requiredEvidence ? { requiredEvidence: [...record.requiredEvidence] } : {}),
          ...(record.writeScope ? { writeScope: [...record.writeScope] } : {}),
          executionProtocol: record.executionProtocol,
          reviewMode: record.reviewMode,
          inheritsParentConstraints: Boolean(record.parentAgentId),
          communicationLane: record.communicationLane,
        };
        emitAgentSpawning(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${id}`,
          source: 'agent-manager',
        }, {
          agentId: id,
          task,
          ...(record.parentAgentId ? { parentAgentId: record.parentAgentId } : {}),
          ...(record.contractUnitId ? { contractId: record.contractId, contractRole: record.contractRole, contractUnitId: record.contractUnitId } : {}),
          ...(ownerBinding ? { contractId: ownerBinding.contractId, contractRole: 'owner' as const } : {}),
          ...(record.orchestrationGraphId ? { orchestrationGraphId: record.orchestrationGraphId } : {}),
          ...(record.parentNodeId ? { parentNodeId: record.parentNodeId } : {}),
          taskContract,
        });
      }
      if (ownerBinding) {
        begin(ownerBinding.settled);
        return startContractOwner(record, ownerBinding, this.runtimeBus);
      }

      if (startsContract) {
        try {
          const started = owned ? owned.startContract(record) : this.contractRunner!.startForOwner(record);
          begin(started.settled);
        } catch (error) {
          record.status = 'failed';
          record.error = `The contract could not start: ${summarizeError(error)}`;
          record.completedAt = Date.now();
          throw error;
        }
        return record;
      }

      if (this.executor && record.status !== 'cancelled') {
        begin(this.executor.runAgent(record).catch((error) => {
          record.status = 'failed';
          record.error = summarizeError(error, {
            ...(record.provider ? { provider: record.provider } : {}),
          });
          record.completedAt = Date.now();
        }));
      } else if (record.status !== 'cancelled') {
        record.status = 'failed';
        record.error = 'Agent executor is not configured';
        record.completedAt = Date.now();
        begin();
      } else {
        begin();
      }

      return record;
    } catch (error) {
      begin();
      throw error;
    }
  }

  private reserveExecution(agentId: string): {
    readonly begin: (operation: PromiseLike<void> | void) => void;
    readonly controller: AbortController;
    readonly previous: Promise<void> | undefined;
    readonly slot: AgentExecutionSlot;
  } {
    let state = this.executions.get(agentId);
    if (!state) {
      state = { work: new OwnedWork(), slots: new Set() };
      this.executions.set(agentId, state);
    }
    const owner = state;
    const previous = owner.tail;
    let begin!: (operation: PromiseLike<void> | void) => void;
    const settled = new Promise<void>((resolve) => { begin = resolve; });
    const slot: AgentExecutionSlot = { settled, controller: new AbortController(), active: true };
    void settled.then(() => { slot.active = false; }, () => { slot.active = false; });
    owner.slots.add(slot);
    owner.tail = settled;
    const reclaim = (): void => {
      owner.slots.delete(slot);
      // Identity plus actual idleness prevents an old cleanup from removing a
      // newer admission. clear() does not drop still-live execution ownership.
      if (owner.work.idle && this.executions.get(agentId) === owner) {
        this.executions.delete(agentId);
        this.cancellationControllers.delete(agentId);
      }
    };
    void owner.work.run(() => settled).then(reclaim, reclaim);
    return { begin, controller: slot.controller, previous, slot };
  }

  /**
   * Joins admitted executor/contract work, including async finally cleanup.
   * Cancellation and outward terminal statuses are deliberately not evidence.
   * A later independent wake after this barrier is a new execution.
   */
  join(agentId: string): Promise<void> {
    return this.executions.get(agentId)?.work.join() ?? Promise.resolve();
  }

  /**
   * Re-trigger a wedged agent's processing loop with a steer message as input.
   *
   * Only a terminally-FAILED agent is woken by default. Its outward status
   * may precede async cleanup, so the admitted wake waits for that actual
   * invocation before re-entering the executor. A
   * genuinely-running agent is left alone (its steer is delivered through the
   * message bus and drained at its next turn boundary); a cancelled agent is
   * never woken. A completed agent is woken only with `allowCompleted` and only
   * when it is a contract unit's sub-agent (`contractUnitId` set): the contract
   * runner reopens a unit whose work a later check found failing. The fleet
   * steer path passes no options, so operator behaviour is unchanged. The re-run
   * restores context from the frozen transcript tail (a summary, not a risky
   * tool-call replay) and appends the steer as a fresh user turn.
   */
  wakeWithSteer(agentId: string, steer: string, options: { readonly allowCompleted?: boolean } = {}): { woke: boolean; reason: string } {
    const record = this.agents.get(agentId);
    if (!record) return { woke: false, reason: 'unknown-agent' };
    const wakeCompleted = record.status === 'completed' && options.allowCompleted === true && Boolean(record.contractUnitId);
    if (record.status !== 'failed' && !wakeCompleted) {
      return { woke: false, reason: `agent status is '${record.status}', not a wedged/failed loop` };
    }
    if (!this.executor) return { woke: false, reason: 'no executor configured' };
    if (typeof steer !== 'string' || steer.trim().length === 0) {
      return { woke: false, reason: 'empty steer message' };
    }
    const executor = this.executor;
    const { begin, controller, previous } = this.reserveExecution(agentId);
    const start = (): Promise<void> | void => {
      // Cancellation covers the queued admission too, without aborting an
      // unrelated future wake admitted after this one actually settles.
      if (controller.signal.aborted) return;
      // An aborted engine signal belongs to the ended phase. A fresh wake
      // cannot inherit that old cancellation; a still-live phase keeps its
      // exact external signal identity and authority.
      if (this.cancellationSignals.get(agentId)?.aborted) this.cancellationSignals.delete(agentId);
      this.cancellationControllers.set(agentId, controller);
      const priorSummary = this.summarizeTranscriptTailForWake(agentId);
      record.resumeSteer = { steer, ...(priorSummary ? { priorSummary } : {}) };
      record.error = undefined;
      record.failureReason = undefined;
      record.turnBudget = undefined;
      record.completedAt = undefined;
      return executor.runAgent(record);
    };
    let running: Promise<void>;
    try {
      running = previous ? previous.then(start, start) : Promise.resolve(start());
    } catch (error) {
      running = Promise.reject(error);
    }
    begin(running.catch((error) => {
      record.status = 'failed';
      record.error = summarizeError(error, {
        ...(record.provider ? { provider: record.provider } : {}),
      });
      record.completedAt = Date.now();
    }));
    return { woke: true, reason: previous ? 'wake admitted; waiting for prior execution cleanup' : `re-triggered from ${wakeCompleted ? 'completed' : 'failed'} state with steer` };
  }

  /** Build an honest prior-context summary from the frozen transcript tail for a wake. */
  private summarizeTranscriptTailForWake(agentId: string): string | undefined {
    const snapshot = this.getConversationSnapshot(agentId);
    if (!snapshot || snapshot.length === 0) return undefined;
    const tail = snapshot.slice(-6).map((message) => {
      const raw = (message as { content?: unknown }).content;
      const text = typeof raw === 'string' ? raw : '[structured content]';
      const preview = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      return `${message.role}: ${preview}`;
    });
    return `Prior run before this steer, last ${tail.length} transcript message(s):\n${tail.join('\n')}`;
  }

  getStatus(id: string): AgentRecord | null {
    return this.agents.get(id) ?? null;
  }

  cancel(id: string, kind: 'interrupt' | 'kill' = 'kill'): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    const cancelRecord = record.status === 'pending' || record.status === 'running';
    if (cancelRecord) {
      record.status = 'cancelled';
      record.terminationKind = kind;
      record.completedAt = Date.now();
    }
    // Snapshot admission before abort listeners run: they may admit a later
    // independent wake, which this cancellation must not accidentally inherit.
    const slots = [...(this.executions.get(id)?.slots ?? [])];
    for (const slot of slots) slot.controller.abort();
    // Outward failure/completion can precede finally cleanup. The abort above
    // still reaches it without rewriting the terminal record or emitting twice.
    if (cancelRecord) {
      // Abort the manager-owned controller so an in-flight provider call for this
      // agent is interrupted mid-stream, not only cooperatively at the next
      // boundary. (An engine-registered external signal is aborted by the engine's
      // own kill path; this covers the plain broker/ACP-spawned agent.) Create the
      // controller if the runner has not read the signal yet, so a later
      // getCancellationSignal() returns THIS already-aborted controller, no race
      // where a cancel is dropped because the signal was requested afterwards.
      let controller = this.cancellationControllers.get(id);
      if (!controller) {
        controller = new AbortController();
        this.cancellationControllers.set(id, controller);
      }
      controller.abort();
      if (this.runtimeBus) {
        emitAgentCancelled(this.runtimeBus, {
          sessionId: 'agent-manager',
          traceId: `agent-manager:${record.id}:cancel`,
          source: 'agent-manager',
          agentId: record.id,
        }, {
          agentId: record.id,
          reason: 'operator cancellation',
        });
      }
    }
    this.agents.set(id, record);
    return true;
  }

  /**
   * Register the live conversation-snapshot source for a running agent
   * (conversation-snapshot bridge, Part C6). Called by the executor (orchestrator-runner.ts)
   * once its ConversationManager exists, `source` is invoked on demand by
   * getConversationSnapshot(); the manager never copies or stores the
   * messages itself while the agent is running.
   */
  registerConversationSource(agentId: string, source: () => ConversationMessageSnapshot[]): void {
    this.conversationSources.set(agentId, source);
  }

  /**
   * Cooperative cancellation bridge: register the AbortSignal
   * an orchestration engine's cancellation registry created for a work
   * item's current agent. Called by the engine right after
   * AgentManager.spawn() so the signal is in place before the agent's first
   * turn/tool call.
   */
  registerCancellationSignal(agentId: string, signal: AbortSignal): void {
    this.cancellationSignals.set(agentId, signal);
  }

  /** Drop the registered signal + owned controller once the run ends (success, failure, or cancel). Safe to call unconditionally. */
  releaseCancellationSignal(agentId: string, expectedSignal?: AbortSignal): void {
    if (expectedSignal !== undefined && this.cancellationSignals.get(agentId) !== expectedSignal) return;
    this.cancellationSignals.delete(agentId);
    // A delayed prior phase release must not delete a newly admitted wake's
    // owned controller. Its actual execution settlement reclaims that itself.
    if (!this.executions.has(agentId)) this.cancellationControllers.delete(agentId);
  }

  /**
   * The cancellation signal for an agent's in-flight work. An
   * engine-registered external signal wins (keeps the orchestration engine's own
   * kill path authoritative); otherwise a manager-owned controller's signal is
   * returned (created on first read), so a plain broker/ACP-spawned agent still
   * has an abortable signal that cancel() will trip.
   */
  getCancellationSignal(agentId: string): AbortSignal | undefined {
    const external = this.cancellationSignals.get(agentId);
    if (external) return external;
    let controller = this.cancellationControllers.get(agentId);
    if (!controller) {
      controller = new AbortController();
      this.cancellationControllers.set(agentId, controller);
    }
    return controller.signal;
  }

  /**
   * Release the live source for an agent whose run has ended, freezing one
   * final snapshot into the bounded retention ring (see
   * DEFAULT_CONVERSATION_SNAPSHOT_RETENTION) so a transcript tab that was
   * open at the moment of completion keeps showing content instead of going
   * blank. Once evicted (oldest-first, beyond the retention bound),
   * getConversationSnapshot falls back to an empty array, callers past that
   * point are expected to degrade to the on-disk event ledger (TUI
   * Part C6's documented fallback for completed/detached agents).
   *
   * Safe to call even when no source was ever registered for this agentId
   * (e.g. a contract owner record, which never runs its own turn loop).
   */
  releaseConversationSource(agentId: string): void {
    const source = this.conversationSources.get(agentId);
    if (!source) return;
    this.conversationSources.delete(agentId);
    let finalSnapshot: ConversationMessageSnapshot[];
    try {
      finalSnapshot = source();
    } catch (error) {
      logger.warn('AgentManager: conversation source threw on release', { agentId, error: summarizeError(error) });
      return;
    }
    // Re-insert at the end (freshest) even if already present, so the ring's
    // insertion order tracks recency of completion, not first appearance.
    this.frozenConversationSnapshots.delete(agentId);
    this.frozenConversationSnapshots.set(agentId, finalSnapshot);
    while (this.frozenConversationSnapshots.size > this.conversationSnapshotRetention) {
      const oldestKey = this.frozenConversationSnapshots.keys().next().value;
      if (oldestKey === undefined) break;
      this.frozenConversationSnapshots.delete(oldestKey);
    }
  }

  /**
   * The conversation-snapshot tab attach point: a full-fidelity conversation history for a
   * fleet agent (ConversationMessageSnapshot[], the same shape the main
   * session surface renders via MessageLineCache/conversation.ts).
   *
   * - RUNNING agent with a registered source → the current live snapshot.
   * - Agent whose run just ended → the frozen final snapshot, until evicted
   *   from the bounded retention ring (oldest-first beyond
   *   conversationSnapshotRetention completed agents).
   * - Unknown agent, or one long since evicted → empty array. The disk
   *   ledger (<agentId>.jsonl, written by AgentSession) is NOT a substitute
   *   for this array, it is a truncated event log (tool args/results
   *   sliced to 500 chars, no assistant message text), so callers past
   *   eviction get a degraded activity view, never a fabricated replay.
   */
  getConversationSnapshot(agentId: string): ConversationMessageSnapshot[] {
    const liveSource = this.conversationSources.get(agentId);
    if (liveSource) {
      try {
        return liveSource();
      } catch (error) {
        logger.warn('AgentManager: conversation source threw', { agentId, error: summarizeError(error) });
        return [];
      }
    }
    return this.frozenConversationSnapshots.get(agentId) ?? [];
  }

  listByGraph(graphId: string): AgentRecord[] {
    return this.list().filter((agent) => agent.orchestrationGraphId === graphId);
  }

  cancelSubtree(rootAgentId: string): string[] {
    const cancelled: string[] = [];
    const queue = [rootAgentId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (seen.has(currentId)) continue;
      seen.add(currentId);
      const record = this.agents.get(currentId);
      if (!record) continue;
      if (this.cancel(currentId)) cancelled.push(currentId);
      for (const child of this.agents.values()) {
        if (child.parentAgentId === currentId) queue.push(child.id);
      }
    }
    return cancelled;
  }

  cancelGraph(graphId: string): string[] {
    const cancelled: string[] = [];
    for (const agent of this.listByGraph(graphId)) {
      if (this.cancel(agent.id)) cancelled.push(agent.id);
    }
    return cancelled;
  }

  list(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  listByCohort(cohort: string): AgentRecord[] {
    return [...this.agents.values()].filter((agent) => agent.cohort === cohort);
  }

  clear(): void {
    this.agents.clear();
    this.conversationSources.clear();
    this.frozenConversationSnapshots.clear();
  }

  exportState(): AgentRecord[] {
    return [...this.agents.values()].map((agent) => {
      const { streamingContent, fullOutput, ...rest } = agent;
      return {
        ...rest,
        status: (agent.status === 'running' || agent.status === 'pending') ? 'failed' : agent.status,
      };
    });
  }

  importState(records: AgentRecord[]): void {
    for (const record of records) {
      if (record.status === 'running' || record.status === 'pending') continue;
      this.agents.set(record.id, record);
    }
  }

  setExecutor(executor: AgentExecutor | null): void {
    this.executor = executor;
  }

  /** Composes the contract runner that spawns not outside every contract start through (design 10.3). */
  setContractRunner(runner: AgentContractRunner | null): void {
    this.contractRunner = runner;
  }
}
