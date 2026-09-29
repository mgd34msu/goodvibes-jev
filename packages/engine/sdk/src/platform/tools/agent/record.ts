// The agent record AgentManager keeps for every spawned agent. Split out of
// manager.ts, which re-exports it unchanged.
import type { ExecutionIntent } from '../../runtime/execution-intents.js';
import type { TurnInjectionRecord } from '../../agents/turn-knowledge-injection.js';
import type { ProgressBearingRecord } from '../../agents/progress-audience.js';
import type { ContractAgentRole } from '../../../events/contract.js';
import type { AgentInput } from './schema.js';

export interface AgentRecord extends ProgressBearingRecord {
  id: string;
  task: string;
  template: string;
  model?: string | undefined;
  provider?: string | undefined;
  fallbackModels?: string[] | undefined;
  routing?: AgentInput['routing'] | undefined;
  executionIntent?: ExecutionIntent | undefined;
  reasoningEffort?: string | undefined;
  context?: string | undefined;
  tools: string[]; /** Bound write authority for this run's `profile` tool; see AgentInput.captureAuthority. */ captureAuthority?: import('../../personal-capture/index.js').CaptureAuthorityDecision | undefined;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  /**
   * Set by cancel(id, kind) when status transitions to 'cancelled'. Distinguishes
   * a graceful interrupt request from a hard kill for display purposes
   * (verb formalization) without overloading `status`, which is
   * consumed widely (ledger parse, orchestrator finalize, exportState/
   * importState). Absent on records cancelled before this field existed, and
   * on any record cancelled via the single-arg cancel(id) call, both default
   * to 'kill' at the read site (fleet/adapters/agent.ts deriveAgentState).
   */
  terminationKind?: 'interrupt' | 'kill' | undefined;
  startedAt: number;
  completedAt?: number | undefined;
  // `progress` and `progressAudience` come from ProgressBearingRecord: set them
  // together with `setAgentProgress`, never `progress` alone.
  toolCallCount: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens?: number | undefined;
    llmCallCount: number;
    turnCount: number;
    reasoningSummaryCount?: number | undefined;
  };
  error?: string | undefined;
  /** Per-spawn turn-budget override; replaces the agents.maxTurns default for this run, capped by agents.maxTurnsCap. */
  maxTurns?: number | undefined;
  /** The applied turn budget + its source, stamped on a turn-budget-exhaustion failure so the outcome can report it. */
  turnBudget?: { limit: number; source: 'default' | 'spawn-override' | 'policy-bound' } | undefined;
  /** Machine-readable failure reason set at the source (e.g. 'max_turns'), not derived from prose. */
  failureReason?: string | undefined;
  fullOutput?: string | undefined;
  streamingContent?: string | undefined;
  /** The contract this agent belongs to (its owner record, a unit's sub-agent, or the planner). */
  contractId?: string | undefined;
  /** The part this agent plays in its contract. */
  contractRole?: ContractAgentRole | undefined;
  /**
   * The contract unit this agent works on. Set only on a unit's sub-agent, and
   * the one field the turn loop reads to call the contract hooks (the turn-end
   * observer and the completion hold).
   */
  contractUnitId?: string | undefined;
  /** Why the route selector chose this agent's model, recorded with the spawn. */
  routeReason?: string | undefined;
  /** Units a spawn proposed for its contract (a batch-spawn's tasks), carried to the planner. */
  proposedUnits?: AgentInput['proposedUnits'] | undefined;
  outsideContract?: boolean | undefined;
  /** Completion report, or reply to a person; see AgentInput.replyStyle. Absent ⇒ 'report'. */
  replyStyle?: 'report' | 'conversational' | undefined;
  /**
   * Orchestration engine tag: set by phase-runner.ts when it
   * spawns an agent to run one WorkItem through one Phase. The fleet's agent
   * adapter uses it to parent this agent node under its work-item ProcessNode
   * (adapters/agent.ts resolveParentId).
   */
  workItemId?: string | undefined;
  /**
   * Overrides this agent's tool working directory (absolute path), see
   * AgentInput.workingDirectory. Copied from the spawn input at construction
   * (NOT settable post-hoc like workItemId: AgentOrchestrator.runAgent reads
   * it synchronously to select/build the per-cwd ToolRegistry before the
   * caller of spawn() gets its return value back). Absent ⇒ the
   * orchestrator's default working directory, unchanged from before this
   * field existed.
   */
  workingDirectory?: string | undefined;
  cohort?: string | undefined;
  orchestrationGraphId?: string | undefined;
  orchestrationNodeId?: string | undefined;
  orchestrationDepth: number;
  parentAgentId?: string | undefined;
  parentNodeId?: string | undefined;
  capabilityCeilingTools?: string[] | undefined;
  successCriteria?: string[] | undefined;
  requiredEvidence?: string[] | undefined;
  writeScope?: string[] | undefined;
  executionProtocol: 'direct' | 'gather-plan-apply';
  reviewMode: 'none' | 'contract';
  communicationLane: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct';
  /** Appended verbatim to the system prompt when the agent runs (AgentInput.systemPromptAddendum). */
  systemPromptAddendum?: string | undefined;
  knowledgeInjections?: Array<{
    id: string;
    cls: string;
    summary: string;
    reason: string;
    confidence: number;
    reviewState: 'fresh' | 'reviewed' | 'stale' | 'contradicted';
  }>;
  /**
   * Bounded ring of per-turn passive-injection honesty
   * records, one entry per turn that actually ran retrieval (turns that
   * reused the prior turn's cached block, or that ran with the feature
   * flag/budget off, append nothing). See turn-knowledge-injection.ts for
   * the record shape and recordTurnInjection for the ring-eviction policy.
   * Deliberately a plain field (no new KnowledgeEvent contract member),
   * the same entries are also appended to the agent's session transcript
   * via `session.appendMessage({type:'knowledge_injection', ...})`.
   */
  turnInjections?: TurnInjectionRecord[] | undefined;
  /**
   * Transient wake seed set by {@link AgentManager.wakeWithSteer} when a steer
   * re-triggers a wedged (terminally-failed) agent. runAgentTask consumes it on
   * the next run: it seeds the fresh conversation with a summary of the prior
   * run's transcript tail (honest context, not a risky tool-call replay) and the
   * steer as a user turn, then clears the field. Never persisted across a clean
   * completion.
   */
  resumeSteer?: { readonly steer: string; readonly priorSummary?: string | undefined } | undefined;
}
