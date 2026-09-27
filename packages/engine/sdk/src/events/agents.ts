/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

/**
 * AgentEvent, discriminated union covering all subagent/agent lifecycle events.
 *
 * Covers agent lifecycle events for the runtime event bus.
 */

/**
 * What a spawned agent was allowed and asked to do, carried on AGENT_SPAWNING
 * (it was the task contract of the removed orchestration node events).
 */
export interface AgentTaskContract {
  allowedTools?: string[] | undefined;
  capabilityCeiling?: string[] | undefined;
  successCriteria?: string[] | undefined;
  requiredEvidence?: string[] | undefined;
  writeScope?: string[] | undefined;
  executionProtocol?: 'direct' | 'gather-plan-apply' | undefined;
  reviewMode?: 'none' | 'contract' | undefined;
  inheritsParentConstraints?: boolean | undefined;
  communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct' | undefined;
}

export type AgentEvent =
  /** Agent is being initialised and configured. */
  | {
      type: 'AGENT_SPAWNING';
      agentId: string;
      taskId?: string | undefined;
      task: string;
      parentAgentId?: string | undefined;
      contractId?: string | undefined;
      contractRole?: 'owner' | 'unit' | 'planner' | undefined;
      contractUnitId?: string | undefined;
      orchestrationGraphId?: string | undefined;
      parentNodeId?: string | undefined;
      taskContract?: AgentTaskContract | undefined;
    }
  /** Agent is actively running and processing. */
  | {
      type: 'AGENT_RUNNING';
      agentId: string;
      taskId?: string;
      parentAgentId?: string | undefined;
      contractId?: string | undefined;
      contractRole?: 'owner' | 'unit' | 'planner' | undefined;
      contractUnitId?: string | undefined;
    }
  /** Agent emitted a textual progress update. */
  | {
      type: 'AGENT_PROGRESS';
      agentId: string;
      taskId?: string;
      progress: string;
      /**
       * Who `progress` was written for. Absent means `operator`, and an
       * `operator` line is never rendered into a reply on a channel, see
       * platform/agents/progress-audience.ts. The channel renderer reads this
       * field and nothing else to decide, so a progress line that forgets to
       * declare an audience stays on the machine rather than reaching a phone.
       */
      audience?: 'owner' | 'operator' | undefined;
      parentAgentId?: string | undefined;
      contractId?: string | undefined;
      contractRole?: 'owner' | 'unit' | 'planner' | undefined;
      contractUnitId?: string | undefined;
    }
  /** Agent streamed a chunk of output. */
  | { type: 'AGENT_STREAM_DELTA'; agentId: string; taskId?: string; content: string; accumulated: string }
  /** Agent is waiting to send a message to the LLM. */
  | { type: 'AGENT_AWAITING_MESSAGE'; agentId: string; taskId?: string }
  /** Agent is waiting for a tool call to complete. */
  | { type: 'AGENT_AWAITING_TOOL'; agentId: string; taskId?: string; callId: string; tool: string }
  /** Agent is performing final output assembly. */
  | { type: 'AGENT_FINALIZING'; agentId: string; taskId?: string }
  /** Agent completed successfully. */
  | {
      type: 'AGENT_COMPLETED';
      agentId: string;
      taskId?: string;
      durationMs: number;
      output?: string;
      toolCallsMade?: number;
      /** Accumulated token usage for the agent's run, when the execution path tracked it. */
      usage?: AgentUsage | undefined;
    }
  /** Agent failed with an error. */
  | { type: 'AGENT_FAILED'; agentId: string; taskId?: string; error: string; durationMs: number }
  /** Agent was cancelled before completion. */
  | { type: 'AGENT_CANCELLED'; agentId: string; taskId?: string; reason?: string };

/** All agent event type literals as a union. */
export type AgentEventType = AgentEvent['type'];

/**
 * Token usage for a single agent's run. Mirrors the shape of
 * `TokenUsage` in `platform/core/conversation.ts`, kept as a structural
 * duplicate here (rather than an import) so this leaf event module stays
 * free of dependencies on `platform/`.
 */
export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
};
