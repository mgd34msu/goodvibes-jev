/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * Agents domain state, tracks all spawned agent sessions including
 * subagents, WRFC chain agents, and orchestrator agents.
 */

import type { AgentUsage } from '../../../../events/agents.js';

/** States for the agent lifecycle machine. */
export type AgentLifecycleState =
  | 'spawning'
  | 'running'
  | 'awaiting_message'
  | 'awaiting_tool'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Classification of the agent's role. */
export type AgentRole =
  | 'orchestrator'
  | 'engineer'
  | 'reviewer'
  | 'fixer'
  | 'integrator'
  | 'gatekeeper'
  | 'subagent'
  | 'background';

/** The contract an agent belongs to, for agent grouping. */
export interface AgentContractRef {
  /** ID of the contract this agent belongs to. */
  contractId: string;
  /** The agent's part in that contract. */
  contractRole: 'owner' | 'unit' | 'planner';
  /** The contract unit a unit's sub-agent works on. */
  contractUnitId?: string | undefined;
}

/**
 * Full runtime agent record. Every spawned agent has one of these.
 */
export interface RuntimeAgent {
  /** Unique agent ID. */
  id: string;
  /** Human-readable label for display. */
  label: string;
  /** Agent role classification. */
  role: AgentRole;
  /** Current lifecycle state. */
  status: AgentLifecycleState;

  // ── Model ────────────────────────────────────────────────────────────────
  /** Provider the agent is running on. */
  providerId: string;
  /** Model ID the agent is using. */
  modelId: string;

  // ── Hierarchy ────────────────────────────────────────────────────────────
  /** ID of the parent agent that spawned this one (undefined = root). */
  parentAgentId?: string | undefined;
  /** IDs of agents spawned by this agent. */
  childAgentIds: string[];

  // ── Contract membership ──────────────────────────────────────────────────
  /** Contract reference if this agent belongs to a contract. */
  contractRef?: AgentContractRef | undefined;

  // ── Task linkage ─────────────────────────────────────────────────────────
  /** Task ID this agent is executing (from tasks domain). */
  taskId?: string | undefined;

  // ── Session ──────────────────────────────────────────────────────────────
  /** Path to the agent's session file. */
  sessionFile?: string | undefined;
  /** Number of turns completed by this agent. */
  turnCount: number;
  /** Number of tool calls made by this agent. */
  toolCallCount: number;
  /**
   * Accumulated token usage for this agent's run. Undefined means no usage
   * data has landed yet, never fabricated as zeros (honest-UX: an agent
   * that hasn't reported usage is distinct from one that used zero tokens).
   */
  usage?: AgentUsage | undefined;

  // ── Streaming ────────────────────────────────────────────────────────────
  /** Latest accumulated output from the agent (for live display). */
  latestOutput: string;
  /** Latest progress string emitted by the agent. */
  latestProgress?: string | undefined;

  // ── Timing ───────────────────────────────────────────────────────────────
  /** Epoch ms when the agent was spawned. */
  spawnedAt: number;
  /** Epoch ms when the agent completed/failed/cancelled. */
  endedAt?: number | undefined;

  // ── Result ───────────────────────────────────────────────────────────────
  /** Final result payload from the agent (populated on completion). */
  result?: unknown | undefined;
  /** Error message if status === 'failed'. */
  error?: string | undefined;

  // ── Correlation ──────────────────────────────────────────────────────────
  /** Correlation ID for tracing across agent boundaries. */
  correlationId?: string | undefined;
}

/**
 * AgentDomainState, all spawned agents across all subsystems.
 */
export interface AgentDomainState {
  // ── Domain metadata ────────────────────────────────────────────────────────
  /** Monotonic revision counter; increments on every mutation. */
  revision: number;
  /** Timestamp of last mutation (Date.now()). */
  lastUpdatedAt: number;
  /** Subsystem that triggered the last mutation. */
  source: string;

  // ── Agent registry ─────────────────────────────────────────────────────────
  /** All known agents keyed by agent ID. */
  agents: Map<string, RuntimeAgent>;
  /** IDs of currently active (non-terminal) agents. */
  activeAgentIds: string[];

  // ── Statistics ─────────────────────────────────────────────────────────────
  /** Total agents spawned this session. */
  totalSpawned: number;
  /** Total agents that completed successfully. */
  totalCompleted: number;
  /** Total agents that failed. */
  totalFailed: number;
  /** Maximum concurrent agents this session. */
  peakConcurrency: number;
}

/**
 * Returns the default initial state for the agents domain.
 */
export function createInitialAgentsState(): AgentDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    agents: new Map(),
    activeAgentIds: [],
    totalSpawned: 0,
    totalCompleted: 0,
    totalFailed: 0,
    peakConcurrency: 0,
  };
}
