import type { Tool } from '../../types/tools.js';
import type { ConfigManager } from '../../config/manager.js';
import { AGENT_TOOL_SCHEMA } from './schema.js';
import type { AgentInput, ProposedUnit } from './schema.js';
import { ArchetypeLoader } from '../../agents/archetypes.js';
import { AgentMessageBus } from '../../agents/message-bus.js';
import type { ContractRunner, StartedContract } from '../../contract/runner.js';
import { contractChecks, summarizeCheck, summarizeContract, summarizeContractDecision, summarizeEscalation } from './contract-views.js';
import { AGENT_TEMPLATES, AgentManager, type AgentRecord } from './manager.js';
import { evaluateOrchestrationSpawn, ORCHESTRATION_CAP_KEYS } from '../../runtime/orchestration/spawn-policy.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  buildChildFailureEnvelope,
  isChildFailureTerminal,
  type ChildFailureEnvelope,
} from './child-failure-envelope.js';
export type { AgentExecutor, AgentRecord } from './manager.js';
export { AGENT_TEMPLATES, AgentManager } from './manager.js';
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
async function childFailureFor(manager: AgentManager, record: AgentRecord): Promise<ChildFailureEnvelope | null> {
  if (!isChildFailureTerminal(record)) return null;
  const transcriptTail = manager.getConversationSnapshot(record.id);
  return buildChildFailureEnvelope(record, { transcriptTail });
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
  readonly manager: AgentManager;
  readonly messageBus: Pick<AgentMessageBus, 'getMessages' | 'send'>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly archetypeLoader?: Pick<ArchetypeLoader, 'loadArchetype'> | undefined;
  /** Starts the contract spawn and batch-spawn hand work to, and answers the contracts and contract-history modes. */
  readonly contractRunner: Pick<ContractRunner, 'start' | 'list' | 'get'>;
  /** The project a contract started here works in. */
  readonly projectRoot: string;
  /** The conversation session a contract started here belongs to, read on each call. */
  readonly resolveSessionId: () => string;
}

export function createAgentTool(config: AgentToolConfig): Tool {
  const archetypeLoader = config.archetypeLoader ?? new ArchetypeLoader();

  /**
   * Starts one contract for work handed to the tool (design 10.3). The unit
   * leaf refusal runs first, in AgentManager, so it is decided in one place.
   */
  function startContract(input: AgentInput, ask: string, proposedUnits: readonly ProposedUnit[]): StartedContract {
    config.manager.guardContractLeafSpawn(input.parentAgentId);
    return config.contractRunner.start({
      ask,
      sessionId: config.resolveSessionId(),
      origin: 'agent-tool',
      projectRoot: config.projectRoot,
      proposedUnits,
      ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
    });
  }
  return {
    definition: AGENT_TOOL_SCHEMA,

    async execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    // Validate required fields before casting
    if (!args || typeof args !== 'object') {
      return { success: false, error: 'Invalid args: expected an object' };
    }
    if (!('mode' in args) || typeof (args as Record<string, unknown>).mode !== 'string') {
      return { success: false, error: 'Missing required parameter: mode' };
    }
    const input = args as unknown as AgentInput;

    if (!input.mode) {
      return { success: false, error: 'Missing required parameter: mode' };
    }

    const validModes = ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'contracts', 'contract-history', 'cohort-status', 'cohort-report'];
    if (!validModes.includes(input.mode)) {
      return { success: false, error: `Invalid mode: '${input.mode}'. Must be one of: ${validModes.join(', ')}` };
    }

    const manager = config.manager;

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
            started = startContract(
              input,
              input.authoritativeTask && input.authoritativeTask.trim() !== '' ? input.authoritativeTask : input.task,
              [{ task: input.task, ...(input.template ? { template: input.template } : {}) }],
            );
          } catch (error) {
            return { success: false, error: summarizeError(error) };
          }
          const owner = started.owner;
          return {
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
          };
        }

        let record;
        try {
          record = manager.spawn(input);
        } catch (error) {
          return {
            success: false,
            error: summarizeError(error, {
              ...(typeof input.provider === 'string' ? { provider: input.provider } : {}),
            }),
          };
        }

        return {
          success: true,
          output: JSON.stringify({
            agentId: record.id,
            status: 'spawned',
            template: record.template,
            task: record.task,
            ...agentExecutionContract(record),
            ...agentTopology(record),
          }),
        };
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

        const record = manager.getStatus(input.agentId);
        if (!record) {
          return { success: false, error: `Unknown agent: '${input.agentId}'` };
        }

        // Non-blocking: return current status immediately if already in a terminal state.
        // For short polls (timeoutMs > 0), wait at most that duration, capped at 5000ms
        // to prevent blocking the main conversation loop.
        const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

        if (terminalStatuses.has(record.status)) {
          const waitFailure = await childFailureFor(manager, record);
          return {
            success: true,
            output: JSON.stringify({
              agentId: input.agentId,
              status: record.status,
              timedOut: false,
              ...(waitFailure ? { failure: waitFailure } : {}),
            }),
          };
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
            const current = manager.getStatus(input.agentId);
            if (!current || terminalStatuses.has(current.status)) break;
            if (Date.now() - start >= timeoutMs) break;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, pollIntervalMs);
              timer.unref?.();
            });
          }
        }

        const finalRecord = manager.getStatus(input.agentId);
        if (!finalRecord) {
          return { success: true, output: JSON.stringify({ agentId: input.agentId, status: 'deleted', error: 'Agent was removed during wait' }) };
        }
        const finalStatus = finalRecord.status;
        const finalFailure = await childFailureFor(manager, finalRecord);
        return {
          success: true,
          output: JSON.stringify({
            agentId: input.agentId,
            status: finalStatus,
            timedOut: !terminalStatuses.has(finalStatus),
            hint: terminalStatuses.has(finalStatus) ? undefined : 'Agent still running. Use mode=status to poll again.',
            ...(finalFailure ? { failure: finalFailure } : {}),
          }),
        };
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

        const batchOutput: Record<string, unknown> = { cohort: input.cohort };
        if (contractTasks.length > 0) {
          const units: ProposedUnit[] = contractTasks.map((taskDef) => ({
            task: taskDef.task,
            ...(taskDef.template ?? input.template ? { template: taskDef.template ?? input.template } : {}),
          }));
          let started: StartedContract;
          try {
            started = startContract(input, batchAsk(input, units), units);
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
                record = manager.spawn(spawnInput);
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
        return {
          success: true,
          output: JSON.stringify(batchOutput),
        };
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
