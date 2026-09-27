// Barrel: re-exports event types needed by store reducers.
// Reduces the 5-level deep import path (../../../../../events/*) to a single hop.
export type { CompactionEvent } from '../../../../events/compaction.js';
export type { GateEvent } from '../../../../events/gate.js';
export type { TaskEvent } from '../../../../events/tasks.js';
export type { AgentEvent } from '../../../../events/agents.js';
export type { ContractEvent } from '../../../../events/contract.js';
export type { CommunicationEvent } from '../../../../events/communication.js';
export type { PluginEvent } from '../../../../events/plugins.js';
export type { McpEvent } from '../../../../events/mcp.js';
export type { TransportEvent } from '../../../../events/transport.js';
export type { TurnEvent } from '../../../../events/turn.js';
export type { ToolEvent } from '../../../../events/tools.js';
