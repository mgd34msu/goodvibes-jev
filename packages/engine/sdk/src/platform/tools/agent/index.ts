import { assertAgentBriefFidelity } from '../../agents/brief-fidelity.js';
import { readCompletionRepairContext } from '../../core/completion-repair-context.js';
import { types as nodeTypes } from 'node:util';
import type { Tool, ToolExecuteOptions } from '../../types/tools.js';
import { assertCurrentToolInvocation } from '../registry.js';
import type { ConfigManager } from '../../config/manager.js';
import { AGENT_TOOL_SCHEMA } from './schema.js';
import type { AgentInput, ProposedUnit } from './schema.js';
import { ArchetypeLoader } from '../../agents/archetypes.js';
import { AgentMessageBus } from '../../agents/message-bus.js';
import type { ContractRunner, StartedContract } from '../../contract/runner.js';
import { contractChecks, summarizeCheck, summarizeContract, summarizeContractDecision, summarizeEscalation } from './contract-views.js';
import { AGENT_TEMPLATES, AgentManager, type AgentRecord, type OwnedAgentExecution } from './manager.js';
import { evaluateOrchestrationSpawn, ORCHESTRATION_CAP_KEYS } from '../../runtime/orchestration/spawn-policy.js';
import { isNativeConversationTurn, NATIVE_TURN_EXECUTION_REFUSAL } from '../../core/native-turn-scope.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  buildChildFailureEnvelope,
  isChildFailureTerminal,
  type ChildFailureEnvelope,
} from './child-failure-envelope.js';
export type { AgentContractRunner, AgentExecutor, AgentRecord, AgentFleetOwnership, OwnedAgentExecution } from './manager.js';
export { AGENT_TEMPLATES, AgentManager, OwnedAgentExecutionUnavailableError } from './manager.js';
export { isActiveAgent } from './predicates.js';
export { cancelAllAgentRuns, type CancellableAgentRuns } from './cancel-all.js';

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

function agentTopology(record: AgentRecord) {
  return {
    parentAgentId: record.parentAgentId ?? null,
    contractId: record.contractId ?? null,
    contractRole: record.contractRole ?? null,
    contractUnitId: record.contractUnitId ?? null,
    routeReason: record.routeReason ?? null,
    orchestrationGraphId: record.orchestrationGraphId ?? null,
    orchestrationNodeId: record.orchestrationNodeId ?? null,
    parentNodeId: record.parentNodeId ?? null,
  };
}

function agentExecutionContract(record: AgentRecord) {
  return {
    executionIntent: record.executionIntent ?? null,
    tools: record.tools,
    capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
    successCriteria: record.successCriteria ?? [],
    requiredEvidence: record.requiredEvidence ?? [],
    writeScope: record.writeScope ?? [],
    executionProtocol: record.executionProtocol,
    reviewMode: record.reviewMode,
    communicationLane: record.communicationLane,
    knowledgeInjections: record.knowledgeInjections ?? [],
  };
}

/**
 * Build the child-failure envelope for a terminally-failed/cancelled record so
 * the supervising model receives {agentId, phase, reason, partialOutputs} as the
 * RESULT of its poll, never a bare status. Returns null for non-terminal or
 * cleanly-completed agents. The transcript tail is pulled from the manager's
 * live-or-frozen snapshot (honest partial output, never fabricated).
 */
async function childFailureFor(manager: AgentManager, record: AgentRecord,
  options?: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined },
): Promise<ChildFailureEnvelope | null> {
  if (!isChildFailureTerminal(record)) return null;
  const transcriptTail = manager.getConversationSnapshot(record.id);
  return buildChildFailureEnvelope(record, { transcriptTail, ...options });
}

function agentSummary(record: AgentRecord) {
  return {
    id: record.id,
    task: record.task,
    template: record.template,
    status: record.status,
    startedAt: record.startedAt,
    toolCallCount: record.toolCallCount,
    cohort: record.cohort,
    progress: record.progress,
    ...agentTopology(record),
  };
}

/** The fields a result carries for a contract the call started: read as code by core (contract/intake-route.ts toolResultStartedContract). */
function startedContractFields(started: StartedContract) {
  return {
    contractStarted: true as const,
    contractId: started.contract.id,
    ownerAgentId: started.owner.id,
  };
}

function validateTemplate(
  template: string | undefined,
  archetypeLoader: Pick<ArchetypeLoader, 'loadArchetype'>,
): string | null {
  if (!template || AGENT_TEMPLATES[template]) return null;
  // Also allow custom archetypes loaded from .goodvibes/agents/*.md
  const customArchetype = archetypeLoader.loadArchetype(template);
  if (!customArchetype || customArchetype.isCustom === false) {
    return `Unknown template: '${template}'. Available: ${Object.keys(AGENT_TEMPLATES).join(', ')}`;
  }
  return null;
}

function batchTaskToSpawnInput(input: AgentInput, taskDef: NonNullable<AgentInput['tasks']>[number]): AgentInput {
  return {
    mode: 'spawn',
    task: taskDef.task,
    authoritativeTask: input.authoritativeTask ?? input.task,
    template: taskDef.template ?? input.template ?? 'general',
    model: taskDef.model ?? input.model,
    provider: taskDef.provider ?? input.provider,
    fallbackModels: taskDef.fallbackModels ?? input.fallbackModels,
    routing: taskDef.routing ?? input.routing,
    reasoningEffort: taskDef.reasoningEffort ?? input.reasoningEffort,
    tools: taskDef.tools ?? input.tools,
    restrictTools: taskDef.restrictTools ?? input.restrictTools,
    context: taskDef.context ?? input.context,
    successCriteria: taskDef.successCriteria ?? input.successCriteria,
    requiredEvidence: taskDef.requiredEvidence ?? input.requiredEvidence,
    writeScope: taskDef.writeScope ?? input.writeScope,
    executionProtocol: taskDef.executionProtocol ?? input.executionProtocol,
    reviewMode: taskDef.reviewMode ?? input.reviewMode,
    communicationLane: taskDef.communicationLane ?? input.communicationLane,
    parentAgentId: taskDef.parentAgentId ?? input.parentAgentId,
    orchestrationGraphId: taskDef.orchestrationGraphId ?? input.orchestrationGraphId,
    orchestrationNodeId: taskDef.orchestrationNodeId,
    parentNodeId: taskDef.parentNodeId ?? input.parentNodeId,
    outsideContract: taskDef.outsideContract ?? input.outsideContract,
    cohort: input.cohort,
  };
}

/** The ask for a batch's contract: the user's own words when the host attached them, otherwise the tasks listed. */
function batchAsk(input: AgentInput, units: readonly ProposedUnit[]): string {
  if (input.authoritativeTask && input.authoritativeTask.trim() !== '') return input.authoritativeTask;
  return units.map((unit) => `- ${unit.task}`).join('\n');
}

export interface AgentToolConfig {
  /** Session-local user selection, rather than the shared workspace registry's selection. */
  readonly getSelectedModel?: (() => import('../../providers/registry-types.js').ModelDefinition) | undefined;
  readonly manager: AgentManager;
  readonly messageBus: Pick<AgentMessageBus, 'getMessages' | 'send'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'> | undefined;
  /** Starts the contract spawn and batch-spawn hand work to, and answers the contracts and contract-history modes. */
  readonly contractRunner: Pick<ContractRunner, 'start' | 'list' | 'get'> & Partial<Pick<ContractRunner, 'cancel' | 'join'>>;
  /** The project a contract started here works in. */
  readonly projectRoot: string;
  /** The conversation session a contract started here belongs to, read on each call. */
  readonly resolveSessionId: () => string;
}

/** Pins the owner slot without invoking a replacement property getter at dispatch. */
function retainContractProperty(object: object, key: 'contractRunner' | 'start' | 'cancel' | 'join'): () => void {
  const path: { object: object; prototype: object | null; descriptor: PropertyDescriptor | undefined }[] = [];
  const visited = new Set<object>();
  let current: object | null = object;
  while (current !== null) {
    if (nodeTypes.isProxy(current) || visited.has(current)) throw new Error('Unsupported Agent contract owner');
    visited.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor !== undefined && !('value' in descriptor)) throw new Error('Unsupported accessor-backed Agent contract owner');
    const prototype: object | null = Object.getPrototypeOf(current);
    path.push({ object: current, prototype, descriptor });
    if (descriptor !== undefined) break;
    current = prototype;
  }
  return () => {
    for (const entry of path) {
      if (nodeTypes.isProxy(entry.object) || Object.getPrototypeOf(entry.object) !== entry.prototype) {
        throw new Error('Agent contract owner changed before dispatch');
      }
      const actual = Object.getOwnPropertyDescriptor(entry.object, key);
      const original = entry.descriptor;
      if (original === undefined ? actual !== undefined : actual === undefined
        || actual.configurable !== original.configurable || actual.enumerable !== original.enumerable
        || actual.writable !== original.writable || actual.get !== original.get || actual.set !== original.set
        || !Object.is(actual.value, original.value)) {
        throw new Error('Agent contract owner changed before dispatch');
      }
    }
  };
}

export function createAgentTool(config: AgentToolConfig): Tool {
  const archetypeLoader = config.archetypeLoader ?? new ArchetypeLoader();
  // A refused batch remains a pending proposal, including when the model changes spawn modes.
  // Keyed by host-stamped source request and session, never a model-supplied parent ID.
  const heldBatches = new Map<string, { readonly request: string; readonly assignments: readonly { readonly task: string }[]; readonly reason: string }>();

  /**
   * Starts one contract for work handed to the tool. The unit
   * leaf refusal runs first, in AgentManager, so it is decided in one place.
   */
  function startContract(input: AgentInput, ask: string, proposedUnits: readonly ProposedUnit[], assertCurrent: () => void, dispatch: ContractRunner['start']): StartedContract {
    config.manager.guardContractLeafSpawn(input.parentAgentId);
    const completionRepair = readCompletionRepairContext();
    const contractInput = {
      ask,
      ...(config.getSelectedModel === undefined ? {} : { selectedModel: config.getSelectedModel() }),
      sessionId: config.resolveSessionId(),
      origin: 'agent-tool' as const,
      projectRoot: config.projectRoot,
      proposedUnits,
      ...(completionRepair ? { taskEvidence: completionRepair } : {}),
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
    };
    assertCurrent();
    return dispatch(contractInput);
  }
  return {
    definition: AGENT_TOOL_SCHEMA,

    async execute(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string }> {
    const signal = options?.signal;
    const ownedSpawns: OwnedAgentExecution[] = [];
    const ownedContracts: (() => void)[] = [];
    let retired = false;
    const cancelOwned = () => {
      const failures: unknown[] = [];
      for (const owned of ownedSpawns) { try { owned.cancel(); } catch (error) { failures.push(error); } }
      for (const cancel of ownedContracts) { try { cancel(); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'Owned Agent cancellation failed');
    };
    const assertCurrent = () => {
      try {
        if (retired) throw new Error('Agent invocation is no longer current');
        signal?.throwIfAborted();
        assertCurrentToolInvocation(args, options);
        signal?.throwIfAborted();
      } catch (error) {
        retired = true;
        cancelOwned();
        throw error;
      }
    };
    const publish = <T>(result: T): T => { assertCurrent(); return result; };
    const spawnOwned = (input: AgentInput): AgentRecord => {
      assertCurrent();
      if (options === undefined) return manager.spawn(input);
      const owned = manager.spawnOwned(input, { signal });
      ownedSpawns.push(owned);
      assertCurrent();
      return owned.record;
    };
    const startOwnedContract = (input: AgentInput, ask: string, units: readonly ProposedUnit[]): StartedContract => {
      assertCurrent();
      if (options === undefined) {
        return startContract(input, ask, units, assertCurrent, (contractInput) => config.contractRunner.start(contractInput));
      }
      const assertRunnerHolder = retainContractProperty(config, 'contractRunner');
      const runner = config.contractRunner;
      const assertStart = retainContractProperty(runner, 'start');
      const assertCancel = retainContractProperty(runner, 'cancel');
      const assertJoin = retainContractProperty(runner, 'join');
      const start = runner.start, cancel = runner.cancel, join = runner.join;
      const assertRunner = () => { assertRunnerHolder(); assertStart(); assertCancel(); assertJoin(); };
      if ((signal !== undefined || options?.assertCurrent !== undefined)
        && (typeof cancel !== 'function' || typeof join !== 'function')) {
        throw new Error('Agent caller cancellation requires contract cancellation and settlement');
      }
      let started: StartedContract | undefined;
      let contractId: string | undefined;
      let cancelRequested = false, cancelIssued = false, settlementTracked = false;
      const cancelStarted = () => {
        cancelRequested = true;
        if (contractId !== undefined && !cancelIssued && cancel) {
          cancelIssued = true;
          cancel.call(runner, contractId, 'The owning Agent tool invocation was cancelled');
        }
      };
      const cleanup = () => signal?.removeEventListener('abort', cancelStarted);
      signal?.addEventListener('abort', cancelStarted, { once: true });
      try {
        assertCurrent();
        started = startContract(input, ask, units, assertCurrent, (contractInput) => {
          assertRunner();
          signal?.throwIfAborted();
          return start.call(runner, contractInput);
        });
        contractId = started.contract.id;
        ownedContracts.push(cancelStarted);
        if (cancelRequested || signal?.aborted) cancelStarted();
        const settled = started.settled ?? join?.call(runner, contractId);
        if (settled) { void settled.then(cleanup, cleanup); settlementTracked = true; }
        else cleanup();
        assertCurrent();
        return started;
      } catch (error) {
        try { if (started) cancelStarted(); } finally { if (!settlementTracked) cleanup(); }
        throw error;
      }
    };
    const waitForPoll = (milliseconds: number): Promise<void> => {
      signal?.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
          cleanup();
          try { signal?.throwIfAborted(); } catch (error) { reject(error); }
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
        if (signal?.aborted) abort();
      });
    };
    assertCurrent();
    // Validate required fields before casting
    if (!args || typeof args !== 'object') {
      return { success: false, error: 'Invalid args: expected an object' };
    }
    if (!('mode' in args) || typeof (args as Record<string, unknown>).mode !== 'string') {
      return { success: false, error: 'Missing required parameter: mode' };
    }
    const input = args as unknown as AgentInput;
    const completionRepair = readCompletionRepairContext();
    if (isNativeConversationTurn() && (input.mode === 'spawn' || input.mode === 'batch-spawn')) {
      return { success: false, error: NATIVE_TURN_EXECUTION_REFUSAL };
    }

    if (!input.mode) {
      return { success: false, error: 'Missing required parameter: mode' };
    }

    const validModes = ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'contracts', 'contract-history', 'cohort-status', 'cohort-report'];
    if (!validModes.includes(input.mode)) {
      return { success: false, error: `Invalid mode: '${input.mode}'. Must be one of: ${validModes.join(', ')}` };
    }

    const manager = config.manager;
    const delegationKey = JSON.stringify([config.resolveSessionId(), input.authoritativeTask ?? '']);
    const heldBatch = heldBatches.get(delegationKey);
    const holdBatch = (assignments: readonly { readonly task: string }[], error: unknown) => {
      const reason = summarizeError(error);
      const proposal = { request: input.authoritativeTask!, assignments, reason };
      heldBatches.set(delegationKey, proposal);
      return publish({ success: false, error: reason,
        output: JSON.stringify({ recovery: { kind: 'revise-delegation', ...proposal,
          instruction: 'Revise these assignments and resubmit mode=batch-spawn for Jev revalidation. Do not abandon the held plan by starting another agent or contract. Continue the original request after validation.' } }) });
    };
    if (input.mode === 'spawn' && heldBatch) return publish({ success: false,
      error: 'Delegation remains held. Repair and revalidate the pending batch before switching execution modes.',
      output: JSON.stringify({ recovery: { kind: 'revise-delegation', ...heldBatch, requiredMode: 'batch-spawn' } }) });

    switch (input.mode) {
      case 'spawn': {
        if (!input.task || typeof input.task !== 'string' || input.task.trim() === '') {
          return { success: false, error: 'Missing required parameter for spawn: task' };
        }

        const templateError = validateTemplate(input.template, archetypeLoader);
        if (templateError) return { success: false, error: templateError };

        if (!input.outsideContract) {
          let started: StartedContract;
          try {
            started = startOwnedContract(
              input,
              input.authoritativeTask && input.authoritativeTask.trim() !== '' ? input.authoritativeTask : input.task,
              [{ task: input.task, ...(input.template ? { template: input.template } : {}) }],
            );
          } catch (error) {
            return { success: false, error: summarizeError(error) };
          }
          const owner = started.owner;
          return publish({
            success: true,
            output: JSON.stringify({
              ...startedContractFields(started),
              agentId: owner.id,
              status: 'spawned',
              template: owner.template,
              task: owner.task,
              ...agentExecutionContract(owner),
              ...agentTopology(owner),
            }),
          });
        }

        let record;
        try {
          if (input.authoritativeTask) await assertAgentBriefFidelity({ request: input.authoritativeTask, assignments: [{ task: input.task }], ...(completionRepair ? { repairContext: completionRepair } : {}) }, { signal, assertCurrent });
          assertCurrent();
          record = spawnOwned(input);
        } catch (error) {
          return {
            success: false,
            error: summarizeError(error, {
              ...(typeof input.provider === 'string' ? { provider: input.provider } : {}),
            }),
          };
        }

        return publish({
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            status: 'spawned',
            template: record.template,
            task: record.task,
            ...agentExecutionContract(record),
            ...agentTopology(record),
          }),
        });
      }

      case 'status': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for status: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const duration =
          record.completedAt !== undefined
            ? record.completedAt - record.startedAt
            : Date.now() - record.startedAt;

        const statusFailure = await childFailureFor(manager, record);
        return {
          success: true,
          output: JSON.stringify({
            id: record.id,
            task: record.task,
            template: record.template,
            status: record.status,
            durationMs: duration,
            toolCallCount: record.toolCallCount,
            progress: record.progress,
            error: record.error,
            ...(statusFailure ? { failure: statusFailure } : {}),
            ...agentTopology(record),
          }),
        };
      }

      case 'cancel': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for cancel: agentId' };
        }

        const cancelled = manager.cancel(input.agentId);
        if (!cancelled) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: true, output: JSON.stringify({ agentId: input.agentId, status: 'deleted', error: 'Agent was removed after cancel' }) };
        }
        return {
          success: true,
          output: JSON.stringify({ agentId: input.agentId, status: record.status }),
        };
      }

      case 'list': {
        const allRecords = manager.list();
        const records = input.cohort
          ? allRecords.filter(r => r.cohort === input.cohort)
          : allRecords;
        return {
          success: true,
          output: JSON.stringify({
            agents: records.map(agentSummary),
            count: records.length,
            ...(input.cohort ? { cohort: input.cohort } : {}),
          }),
        };
      }

      case 'templates': {
        return {
          success: true,
          output: JSON.stringify({
            templates: Object.entries(AGENT_TEMPLATES).map(([name, def]) => ({
              name,
              description: def.description,
              defaultTools: def.defaultTools,
            })),
          }),
        };
      }

      case 'get': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for get: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const recentMessages = config.messageBus.getMessages(input.agentId).slice(-10);
        const duration =
          record.completedAt !== undefined
            ? record.completedAt - record.startedAt
            : Date.now() - record.startedAt;
        const detail = input.detail ?? 'full';

        const base = {
          id: record.id,
          task: record.task,
          template: record.template,
          model: record.model,
          provider: record.provider,
          executionIntent: record.executionIntent ?? null,
          status: record.status,
          durationMs: duration,
          toolCallCount: record.toolCallCount,
          progress: record.progress,
          error: record.error,
          executionProtocol: record.executionProtocol,
          reviewMode: record.reviewMode,
          communicationLane: record.communicationLane,
          ...agentTopology(record),
        };

        const contract = {
          tools: record.tools,
          capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
          successCriteria: record.successCriteria ?? [],
          requiredEvidence: record.requiredEvidence ?? [],
          writeScope: record.writeScope ?? [],
          knowledgeInjections: record.knowledgeInjections ?? [],
        };

        const messages = {
          recentMessages: recentMessages.map((m) => ({
            from: m.from,
            content: m.content,
            timestamp: m.timestamp,
          })),
        };

        const getFailure = await childFailureFor(manager, record);
        const failureField = getFailure ? { failure: getFailure } : {};
        return {
          success: true,
          output: JSON.stringify(detail === 'full'
            ? { ...base, ...failureField, ...contract, ...messages }
            : detail === 'contract'
              ? { ...base, ...failureField, ...contract }
              : detail === 'messages'
                ? { ...base, ...failureField, ...messages }
                : { ...base, ...failureField }),
        };
      }

      case 'budget': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for budget: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        // The agent's own recorded usage (orchestrator-runner.ts), never an estimate.
        const usage = record.usage;
        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: usage?.cacheReadTokens ?? 0,
            cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
            totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
            llmCallCount: usage?.llmCallCount ?? 0,
            turnCount: usage?.turnCount ?? 0,
            toolCallCount: record.toolCallCount,
            ...(usage === undefined ? { note: 'No model call has been recorded for this agent yet.' } : {}),
          }),
        };
      }

      case 'plan': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for plan: agentId' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const templateDef = AGENT_TEMPLATES[record.template];

        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            task: record.task,
            template: record.template,
            templateDescription: templateDef?.description ?? null,
            tools: record.tools,
            capabilityCeilingTools: record.capabilityCeilingTools ?? record.tools,
            model: record.model ?? null,
            provider: record.provider ?? null,
            successCriteria: record.successCriteria ?? [],
            requiredEvidence: record.requiredEvidence ?? [],
            writeScope: record.writeScope ?? [],
            parentAgentId: record.parentAgentId ?? null,
          }),
        };
      }

      case 'wait': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for wait: agentId' };
        }

        assertCurrent();
        const record = manager.getStatus(input.agentId);
        assertCurrent();
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        // Non-blocking: return current status immediately if already in a terminal state.
        // For short polls (timeoutMs > 0), wait at most that duration, capped at 5000ms
        // to prevent blocking the main conversation loop.
        const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

        if (terminalStatuses.has(record.status)) {
          const waitFailure = await childFailureFor(manager, record, { signal, assertCurrent });
          assertCurrent();
          return publish({
            success: true,
            output: JSON.stringify({
              agentId: input.agentId,
              status: record.status,
              timedOut: false,
              ...(waitFailure ? { failure: waitFailure } : {}),
            }),
          });
        }

        // If a timeoutMs is requested, poll briefly, capped at 5000ms to avoid
        // blocking the main turn loop (sub-agents use small timeouts anyway).
        const requestedTimeout = typeof input.timeoutMs === 'number' ? input.timeoutMs : 0;
        const MAX_BLOCKING_MS = 5_000;
        const timeoutMs = Math.min(requestedTimeout, MAX_BLOCKING_MS);

        if (timeoutMs > 0) {
          const start = Date.now();
          const pollIntervalMs = 50;
          while (true) {
            assertCurrent();
            const current = manager.getStatus(input.agentId);
            assertCurrent();
            if (!current || terminalStatuses.has(current.status)) break;
            if (Date.now() - start >= timeoutMs) break;
            await waitForPoll(pollIntervalMs);
            assertCurrent();
          }
        }

        assertCurrent();
        const finalRecord = manager.getStatus(input.agentId);
        assertCurrent();
        if (!finalRecord) {
          return publish({ success: true, output: JSON.stringify({ agentId: input.agentId, status: 'deleted', error: 'Agent was removed during wait' }) });
        }
        const finalStatus = finalRecord.status;
        const finalFailure = await childFailureFor(manager, finalRecord, { signal, assertCurrent });
        assertCurrent();
        return publish({
          success: true,
          output: JSON.stringify({
            agentId: input.agentId,
            status: finalStatus,
            timedOut: !terminalStatuses.has(finalStatus),
            hint: terminalStatuses.has(finalStatus) ? undefined : 'Agent still running. Use mode=status to poll again.',
            ...(finalFailure ? { failure: finalFailure } : {}),
          }),
        });
      }

      case 'message': {
        if (!input.agentId || typeof input.agentId !== 'string' || input.agentId.trim() === '') {
          return { success: false, error: 'Missing required parameter for message: agentId' };
        }
        if (!input.message || typeof input.message !== 'string' || input.message.trim() === '') {
          return { success: false, error: 'message cannot be empty or whitespace only' };
        }

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        const sent = config.messageBus.send('orchestrator', input.agentId, input.message, {
          kind: input.kind ?? 'directive',
        });
        if (!sent) {
          return {
            success: false,
            error: `Communication to agent '${input.agentId}' was blocked by policy.`,
          };
        }

        return {
          success: true,
          output: JSON.stringify({
            agentId: input.agentId,
            sent: true,
            content: input.message,
            kind: input.kind ?? 'directive',
          }),
        };
      }

      case 'batch-spawn': {
        if (!input.tasks || !Array.isArray(input.tasks) || input.tasks.length === 0) {
          return { success: false, error: 'batch-spawn requires a non-empty tasks array.' };
        }
        if (input.tasks.length > 20) {
          return { success: false, error: 'batch-spawn limited to 20 tasks per batch.' };
        }
        for (const taskDef of input.tasks) {
          if (!taskDef.task || typeof taskDef.task !== 'string' || taskDef.task.trim() === '') {
            return { success: false, error: 'Each task in batch-spawn must have a non-empty task string.' };
          }
          const templateError = validateTemplate(taskDef.template, archetypeLoader);
          if (templateError) return { success: false, error: templateError };
        }
        const spawnInputs = input.tasks.map((taskDef) => batchTaskToSpawnInput(input, taskDef));
        // Every requester is checked before anything starts, so a refused task never leaves half a batch running.
        try {
          for (const requester of new Set([input.parentAgentId, ...spawnInputs.map((spawnInput) => spawnInput.parentAgentId)])) {
            manager.guardContractLeafSpawn(requester);
          }
        } catch (error) {
          return { success: false, error: summarizeError(error) };
        }
        const outsideInputs = spawnInputs.filter((spawnInput) => spawnInput.outsideContract === true);
        const contractTasks = input.tasks.filter((_, index) => spawnInputs[index]!.outsideContract !== true);
        if ((outsideInputs.length > 0 || heldBatch) && input.authoritativeTask) {
          try {
            await assertAgentBriefFidelity({ request: input.authoritativeTask, assignments: input.tasks.map(task => ({ task: task.task })), ...(completionRepair ? { repairContext: completionRepair } : {}) }, { signal, assertCurrent });
            assertCurrent();
          } catch (error) { return holdBatch(input.tasks.map(task => ({ task: task.task })), error); }
          heldBatches.delete(delegationKey);
        }

        const batchOutput: Record<string, unknown> = { cohort: input.cohort };
        if (contractTasks.length > 0) {
          const units: ProposedUnit[] = contractTasks.map((taskDef) => ({
            task: taskDef.task,
            ...(taskDef.template ?? input.template ? { template: taskDef.template ?? input.template } : {}),
          }));
          let started: StartedContract;
          try {
            started = startOwnedContract(input, batchAsk(input, units), units);
          } catch (error) {
            return { success: false, error: summarizeError(error) };
          }
          Object.assign(batchOutput, startedContractFields(started), {
            owner: agentSummary(started.owner),
            contractTaskCount: contractTasks.length,
          });
        }

        const results: ReturnType<typeof agentSummary>[] = [];
        let skipped = 0;
        if (outsideInputs.length > 0) {
          const currentCount = manager.list().filter(a => a.status === 'pending' || a.status === 'running').length;
          const spawnDecision = evaluateOrchestrationSpawn({
            configManager: config.configManager,
            mode: 'manual-batch',
            activeAgents: currentCount,
            requestedDepth: 0,
          });
          if (!spawnDecision.allowed || spawnDecision.availableSlots === 0) {
            const boundCap = spawnDecision.boundCap
              ?? { key: ORCHESTRATION_CAP_KEYS.maxActiveAgents, value: spawnDecision.maxAgents };
            const capError = spawnDecision.reason
              ?? `agent capacity reached (${currentCount}/${spawnDecision.maxAgents}), cap: ${boundCap.key}=${boundCap.value}. No capacity for batch-spawn.`;
            if (batchOutput.contractStarted !== true) {
              return { success: false, error: capError, output: JSON.stringify({ cap: boundCap }) };
            }
            // The contract already started; the outside-contract tasks found no capacity.
            skipped = outsideInputs.length;
            batchOutput.cap = boundCap;
            batchOutput.capMessage = capError;
          } else {
            const toSpawn = outsideInputs.slice(0, spawnDecision.availableSlots);
            skipped = outsideInputs.length - toSpawn.length;
            for (const spawnInput of toSpawn) {
              let record;
              try {
                record = spawnOwned(spawnInput);
              } catch (error) {
                return { success: false, error: summarizeError(error) };
              }
              results.push({ ...agentSummary(record), task: record.task.slice(0, 80) });
            }
            batchOutput.maxAgents = spawnDecision.maxAgents;
            if (skipped > 0) {
              // The active-agents cap bound: excess tasks were queued/refused. Name
              // the cap and its value both here and in a human-readable note.
              batchOutput.cap = { key: ORCHESTRATION_CAP_KEYS.maxActiveAgents, value: spawnDecision.maxAgents };
              batchOutput.capMessage =
                `queued ${skipped} task${skipped === 1 ? '' : 's'}: ${spawnDecision.maxAgents}/${spawnDecision.maxAgents} active, cap: ${ORCHESTRATION_CAP_KEYS.maxActiveAgents}=${spawnDecision.maxAgents}`;
            }
          }
        }
        batchOutput.agents = results;
        batchOutput.count = results.length;
        batchOutput.skipped = skipped;
        return publish({
          success: true,
          output: JSON.stringify(batchOutput),
        });
      }

      case 'cohort-status': {
        if (!input.cohort) {
          return { success: false, error: 'cohort-status requires a cohort name.' };
        }
        const cohortAgents = manager.listByCohort(input.cohort);
        if (cohortAgents.length === 0) {
          return { success: true, output: `No agents found in cohort '${input.cohort}'.` };
        }
        const summary = cohortAgents.map(a => ({
          id: a.id,
          task: a.task?.slice(0, 80),
          status: a.status,
          template: a.template,
          contractId: a.contractId,
          toolCallCount: a.toolCallCount,
        }));
        return { success: true, output: JSON.stringify({ cohort: input.cohort, count: cohortAgents.length, agents: summary }) };
      }

      case 'cohort-report': {
        if (!input.cohort) {
          return { success: false, error: 'cohort-report requires a cohort name.' };
        }
        const reportAgents = manager.listByCohort(input.cohort);
        if (reportAgents.length === 0) {
          return { success: true, output: `No agents found in cohort '${input.cohort}'.` };
        }
        const lines: string[] = [
          `## Cohort: ${input.cohort} (${reportAgents.length} agents)`,
          '',
          '| Agent | Task | Status | Template | Contract | Tool Calls |',
          '|-------|------|--------|----------|----------|------------|',
        ];
        for (const a of reportAgents) {
          const taskShort = (a.task ?? '').slice(0, 40).replace(/\|/g, '\\|');
          const contractCell = a.contractId ? `${a.contractId}${a.contractUnitId ? `/${a.contractUnitId}` : ''}` : 'n/a';
          lines.push(`| ${a.id.slice(-8)} | ${taskShort} | ${a.status} | ${a.template ?? 'general'} | ${contractCell} | ${a.toolCallCount ?? 0} |`);
        }
        return { success: true, output: lines.join('\n') };
      }

      case 'contracts': {
        try {
          const contracts = config.contractRunner.list({
            sessionId: config.resolveSessionId(),
            includeTerminal: input.includeTerminal ?? true,
          });
          const detail = input.detail ?? 'summary';
          return {
            success: true,
            output: JSON.stringify({
              mode: 'contracts',
              detail,
              count: contracts.length,
              contracts: detail === 'full' ? contracts : contracts.map(summarizeContract),
            }),
          };
        } catch (err) {
          return { success: false, error: `Failed to list contracts: ${summarizeError(err)}` };
        }
      }

      case 'contract-history': {
        if (!input.contractId) {
          return { success: false, error: 'contract-history requires contractId' };
        }
        try {
          const contract = config.contractRunner.get(input.contractId);
          if (!contract) {
            return { success: false, error: `Unknown contract: '${input.contractId}'` };
          }
          const detail = input.detail ?? 'summary';
          const checks = contractChecks(contract);
          return {
            success: true,
            output: JSON.stringify({
              mode: 'contract-history',
              detail,
              contractId: contract.id,
              status: contract.status,
              decisions: detail === 'full' ? contract.decisions : contract.decisions.map(summarizeContractDecision),
              checks: detail === 'full' ? checks : checks.map(summarizeCheck),
              escalations: detail === 'full'
                ? contract.escalations
                : contract.escalations.map(summarizeEscalation),
            }),
          };
        } catch (err) {
          return { success: false, error: `Failed to read the contract's history: ${summarizeError(err)}` };
        }
      }

      default: {
        return { success: false, error: `Unhandled mode: '${input.mode}'` };
      }
    }
    },
  };
}
