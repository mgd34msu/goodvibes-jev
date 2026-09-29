import type { ToolDefinition } from '../../types/tools.js';
import type { ExecutionIntent } from '../../runtime/execution-intents.js';
import { REASONING_EFFORT_SEVERITY } from '../../providers/reasoning-effort.js';

/**
 * JSON Schema for the agent tool's input.
 * Manages in-process subagents: spawn, status, cancel, list, templates.
 */
export const AGENT_TOOL_SCHEMA: ToolDefinition = {
  name: 'agent',
  description:
    'Manages in-process subagents. Modes: spawn (create a new agent task), ' +
    'batch-spawn (hand several tasks over at once: the tasks without outsideContract become the proposed units of one contract, and tasks with outsideContract run as separate agents), ' +
    'status (check agent progress by ID), cancel (stop a running agent), ' +
    'list (show all agents and their status), ' +
    'templates (list available agent templates with default tool sets), ' +
    'get (detailed agent info including messages), ' +
    'budget (token usage for an agent), ' +
    'plan (execution plan: task + template + tools), ' +
    'wait (returns current status immediately if terminal, or polls up to timeoutMs capped at 5000ms; always non-blocking for the main conversation), ' +
    'message (send a message to an agent), ' +
    'contracts (list the contracts of the current session with their status, goal, units and criteria met), ' +
    'contract-history (the decisions, checks and escalations of one contract, by contractId), ' +
    'cohort-status (JSON summary of all agents in a named cohort), ' +
    'cohort-report (markdown table report for all agents in a named cohort).' +
    ' Discovery: use mode=list to see all agents and their status, mode=templates to see available agent templates. ' +
    'Work handed to this tool with mode=spawn or batch-spawn runs as a contract: a planner splits it into units, and each unit is checked against its acceptance criteria while it works and told what to fix until it passes. ' +
    'The result carries contractStarted, contractId and the owner agent id; the owner agent reports the contract\'s answer when it ends. ' +
    'Set outsideContract only for an agent whose work needs no checks.',
  sideEffects: ['agent', 'workflow', 'state'],
  concurrency: 'serial',
  supportsProgress: true,
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'contracts', 'contract-history', 'cohort-status', 'cohort-report'],
        description: 'Operation mode.',
      },
      // mode: spawn
      task: {
        type: 'string',
        description: 'Task description (mode: spawn). Without outsideContract it becomes the proposed unit of a new contract; with outsideContract it is the agent\'s own task. Describe the deliverable itself.',
      },
      authoritativeTask: {
        type: 'string',
        description: 'The user\'s own request, verbatim, supplied by the host. A contract started by this call takes it as its ask; do not invent or narrow it.',
      },
      template: {
        type: 'string',
        enum: ['orchestrator', 'planner', 'engineer', 'reviewer', 'tester', 'researcher', 'integrator', 'general'],
        description:
          'Agent template to use (mode: spawn). Default: general. ' +
          'Each template includes a pre-selected tool set.',
      },
      model: {
        type: 'string',
        description: 'Model for the spawned agent (mode: spawn). A bare model id (e.g. "claude-fable-5") resolves automatically; use the provider:model form only when the id exists on more than one provider.',
      },
      provider: {
        type: 'string',
        description: 'Provider override for the spawned agent (mode: spawn).',
      },
      fallbackModels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered models to try if the primary model fails (mode: spawn). Bare ids resolve automatically, same as model.',
      },
      executionIntent: {
        type: 'object',
        properties: {
          riskClass: {
            type: 'string',
            enum: ['safe', 'elevated', 'dangerous'],
            description: 'Execution risk classification hint for downstream policy/evaluation surfaces.',
          },
          requiresApproval: {
            type: 'boolean',
            description: 'Whether the spawned agent should be treated as requiring approval-sensitive execution.',
          },
          networkPolicy: {
            type: 'string',
            enum: ['inherit', 'allow', 'deny', 'scoped'],
            description: 'Requested network posture for downstream execution surfaces.',
          },
          filesystemPolicy: {
            type: 'string',
            enum: ['inherit', 'workspace-write', 'read-only', 'isolated'],
            description: 'Requested filesystem posture for downstream execution surfaces.',
          },
        },
        additionalProperties: false,
        description: 'Explicit execution-intent hints for policy-aware runtimes (mode: spawn).',
      },
      reasoningEffort: {
        type: 'string',
        enum: [...REASONING_EFFORT_SEVERITY],
        description: 'Reasoning effort override for providers/models that support it (mode: spawn). Which levels the spawned agent\'s model actually accepts is per-model.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Explicit tool subset for the agent (mode: spawn). ' +
          'Defaults to template defaults. The "agent" tool is never included.',
      },
      context: {
        type: 'string',
        description: 'Additional context to provide to the spawned agent (mode: spawn).',
      },
      successCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete success criteria the spawned agent must satisfy (mode: spawn).',
      },
      requiredEvidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence the spawned agent must return before completion (mode: spawn).',
      },
      writeScope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Expected file or path scope for writes owned by the spawned agent (mode: spawn).',
      },
      executionProtocol: {
        type: 'string',
        enum: ['direct', 'gather-plan-apply'],
        description: 'Execution discipline the spawned agent should follow (mode: spawn). Default: gather-plan-apply.',
      },
      reviewMode: {
        type: 'string',
        enum: ['none', 'contract'],
        description: 'Whether the agent\'s work is checked (mode: spawn). Default: contract, or none when outsideContract is set. Work without outsideContract always runs as a contract.',
      },
      communicationLane: {
        type: 'string',
        enum: ['parent-only', 'parent-and-children', 'cohort', 'direct'],
        description: 'Permitted communication lane for the spawned agent (mode: spawn). Default: parent-only for children, direct for root workers.',
      },
      parentAgentId: {
        type: 'string',
        description: 'Parent agent whose capability ceiling and communication lane this worker inherits (mode: spawn).',
      },
      orchestrationGraphId: {
        type: 'string',
        description: 'Explicit orchestration graph id to attach the spawned worker to (mode: spawn).',
      },
      orchestrationNodeId: {
        type: 'string',
        description: 'Explicit orchestration node id for the spawned worker (mode: spawn).',
      },
      parentNodeId: {
        type: 'string',
        description: 'Parent orchestration node id for the spawned worker (mode: spawn).',
      },
      restrictTools: {
        type: 'boolean',
        description:
          'If true, use ONLY the specified tools (override mode). ' +
          'If false or omitted, specified tools are merged with template defaults (additive mode). ' +
          'Only applies when tools is also provided (mode: spawn).',
        default: false,
      },
      outsideContract: {
        type: 'boolean',
        description: 'If true, run the agent directly, outside any contract, with no checks on its work (mode: spawn, batch-spawn). Default: false, which starts a contract.',
        default: false,
      },
      // mode: batch-spawn
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'Task description for the agent.' },
            template: { type: 'string', enum: ['orchestrator', 'planner', 'engineer', 'reviewer', 'tester', 'researcher', 'integrator', 'general'], description: 'Agent template.' },
            model: { type: 'string', description: 'Model for this task. A bare model id resolves automatically; use provider:model only when the id exists on more than one provider.' },
            provider: { type: 'string', description: 'Provider override.' },
            fallbackModels: { type: 'array', items: { type: 'string' }, description: 'Ordered models to try if the primary model fails. Bare ids resolve automatically.' },
            executionIntent: {
              type: 'object',
              properties: {
                riskClass: { type: 'string', enum: ['safe', 'elevated', 'dangerous'], description: 'Execution risk classification hint.' },
                requiresApproval: { type: 'boolean', description: 'Whether approval-sensitive execution is required.' },
                networkPolicy: { type: 'string', enum: ['inherit', 'allow', 'deny', 'scoped'], description: 'Requested network posture.' },
                filesystemPolicy: { type: 'string', enum: ['inherit', 'workspace-write', 'read-only', 'isolated'], description: 'Requested filesystem posture.' },
              },
              additionalProperties: false,
              description: 'Explicit execution-intent hints for downstream runtimes.',
            },
            reasoningEffort: { type: 'string', enum: [...REASONING_EFFORT_SEVERITY], description: 'Reasoning effort override.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Tool subset.' },
            restrictTools: { type: 'boolean', description: 'If true, use ONLY the specified tools (override mode). Default: false.' },
            context: { type: 'string', description: 'Additional context.' },
            successCriteria: { type: 'array', items: { type: 'string' }, description: 'Concrete success criteria.' },
            requiredEvidence: { type: 'array', items: { type: 'string' }, description: 'Evidence the spawned agent must return.' },
            writeScope: { type: 'array', items: { type: 'string' }, description: 'Expected write ownership scope.' },
            executionProtocol: { type: 'string', enum: ['direct', 'gather-plan-apply'], description: 'Execution discipline.' },
            reviewMode: { type: 'string', enum: ['none', 'contract'], description: 'Whether the work is checked as a contract.' },
            communicationLane: { type: 'string', enum: ['parent-only', 'parent-and-children', 'cohort', 'direct'], description: 'Permitted communication lane.' },
            parentAgentId: { type: 'string', description: 'Parent agent to inherit capability ceiling from.' },
            orchestrationGraphId: { type: 'string', description: 'Graph id to attach the worker to.' },
            orchestrationNodeId: { type: 'string', description: 'Explicit node id for the worker.' },
            parentNodeId: { type: 'string', description: 'Parent node id for the worker.' },
            outsideContract: { type: 'boolean', description: 'Run this task as its own agent outside any contract, with no checks. Default: the batch\'s outsideContract.' },
          },
        },
        description: 'Tasks to hand over at once (mode: batch-spawn). Max 20. The tasks without outsideContract become the proposed units of one contract, whose planner decides the units that run; tasks with outsideContract run as separate agents, up to the active-agent cap.',
      },
      // mode: spawn, batch-spawn, list, cohort-status, cohort-report
      cohort: {
        type: 'string',
        description: 'Cohort name to group agents together (mode: spawn, batch-spawn). Filter by cohort (mode: list, cohort-status, cohort-report).',
      },
      // mode: status / cancel / get / budget / plan / wait / message
      agentId: {
        type: 'string',
        description: 'Agent ID to query, cancel, get, budget, plan, wait, or message (mode: status, cancel, get, budget, plan, wait, message).',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'contract', 'messages', 'full'],
        description: 'Detail level for inspection/reporting modes. Summary keeps the core execution state; contract adds capability/ownership data; messages adds recent bus traffic; full returns everything.',
      },
      // mode: wait
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds for the wait action (mode: wait). Default: 0 (non-blocking, returns immediately). Max: 5000ms. If agent is still running, returns current status with a hint to poll again via mode=status.',
      },
      // mode: message
      message: {
        type: 'string',
        description: 'Message content to send to an agent (mode: message).',
      },
      kind: {
        type: 'string',
        enum: ['directive', 'status', 'question', 'finding', 'review', 'handoff', 'escalation', 'completion'],
        description: 'Structured communication kind for the message (mode: message). Default: directive.',
      },
      // mode: contracts
      includeTerminal: {
        type: 'boolean',
        description: 'Include contracts that already ended (mode: contracts). Default: true.',
      },
      // mode: contract-history
      contractId: {
        type: 'string',
        description: 'The contract to read (mode: contract-history).',
      },
    },
  },
};

export interface AgentProviderRoutingPolicy {
  providerSelection?: 'inherit-current' | 'concrete' | 'synthetic' | undefined;
  providerFailurePolicy?: 'ordered-fallbacks' | 'fail' | undefined;
  fallbackModels?: readonly string[] | undefined;
}

/** A unit proposed for a contract: a task and the template it asked for. The contract's planner weighs it. */
export interface ProposedUnit {
  readonly task: string;
  readonly template?: string | undefined;
}

/** Input shape for the agent tool. */
export interface AgentInput {
  mode: 'spawn' | 'batch-spawn' | 'status' | 'cancel' | 'list' | 'templates' | 'get' | 'budget' | 'plan' | 'wait' | 'message' | 'contracts' | 'contract-history' | 'cohort-status' | 'cohort-report';
  // spawn
  task?: string | undefined;
  authoritativeTask?: string | undefined;
  template?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  fallbackModels?: string[] | undefined;
  routing?: AgentProviderRoutingPolicy | undefined;
  executionIntent?: ExecutionIntent | undefined;
  reasoningEffort?: string | undefined;
  tools?: string[] | undefined;
  restrictTools?: boolean | undefined;
  context?: string | undefined;
  /**
   * Internal: the write authority to bind this run's `profile` capture tool to.
   * Set by the composition root from the turn's channel, never by model output,
   * see personal-capture/authority.ts. Deliberately absent from the tool's own
   * JSON schema so a model cannot ask for it.
   */
  captureAuthority?: import('../../personal-capture/index.js').CaptureAuthorityDecision | undefined;
  /** Internal: text appended verbatim to the spawned agent's system prompt. */
  systemPromptAddendum?: string | undefined;
  /** Internal: units proposed for the contract this spawn starts, carried to its owner and weighed by the planner. */
  proposedUnits?: readonly ProposedUnit[] | undefined;
  successCriteria?: string[] | undefined;
  requiredEvidence?: string[] | undefined;
  writeScope?: string[] | undefined;
  executionProtocol?: 'direct' | 'gather-plan-apply' | undefined;
  reviewMode?: 'none' | 'contract' | undefined;
  communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct' | undefined;
  parentAgentId?: string | undefined;
  orchestrationGraphId?: string | undefined;
  orchestrationNodeId?: string | undefined;
  parentNodeId?: string | undefined;
  outsideContract?: boolean | undefined;
  /**
   * What the caller wants the agent's final message to LOOK like.
   *
   * - 'report'         (default) The structured completion report, plus its
   *                    prose Summary/Changes/Decisions/Issues/Uncertainties
   *                    sections.
   * - 'conversational' A reply to a person. No completion report, no section
   *                    headings, no template, just the answer.
   *
   * Set by the conversation-first gate, which already knows an inbound channel
   * message is conversation rather than work. Deliberately NOT in the agent
   * tool's JSON schema: it is a decision the platform makes about a spawn, not
   * a knob a model may turn to opt out of reporting on real work.
   */
  replyStyle?: 'report' | 'conversational' | undefined;
  /**
   * Overrides this spawn's tool working directory (absolute path), e.g. an
   * orchestration-engine item's dedicated git worktree in `worktree`
   * isolation mode (see platform/orchestration/worktree-isolation.ts).
   * Omitted ⇒ the orchestrator's default working directory, exactly as
   * before this field existed. Internal, not part of any user-facing agent
   * template surface.
   */
  workingDirectory?: string | undefined;
  // cohort grouping
  cohort?: string | undefined;
  // batch-spawn
  tasks?: Array<{
    task: string;
    template?: string | undefined;
    model?: string | undefined;
    provider?: string | undefined;
    fallbackModels?: string[] | undefined;
    routing?: AgentProviderRoutingPolicy | undefined;
    executionIntent?: ExecutionIntent | undefined;
    reasoningEffort?: string | undefined;
    tools?: string[] | undefined;
    restrictTools?: boolean | undefined;
    context?: string | undefined;
    successCriteria?: string[] | undefined;
    requiredEvidence?: string[] | undefined;
    writeScope?: string[] | undefined;
    executionProtocol?: 'direct' | 'gather-plan-apply' | undefined;
    reviewMode?: 'none' | 'contract' | undefined;
    communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct' | undefined;
    parentAgentId?: string | undefined;
    orchestrationGraphId?: string | undefined;
    orchestrationNodeId?: string | undefined;
    parentNodeId?: string | undefined;
    outsideContract?: boolean | undefined;
  }>;
  // status / cancel / get / budget / plan / wait / message
  agentId?: string | undefined;
  detail?: 'summary' | 'contract' | 'messages' | 'full' | undefined;
  // wait
  timeoutMs?: number | undefined;
  // message
  message?: string | undefined;
  kind?: 'directive' | 'status' | 'question' | 'finding' | 'review' | 'handoff' | 'escalation' | 'completion' | undefined;
  // contracts: whether ended contracts are listed
  includeTerminal?: boolean | undefined;
  // contract-history: the contract to read
  contractId?: string | undefined;
}
