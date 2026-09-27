import type {
  AgentEvent,
  AnyRuntimeEvent,
  OpsEvent,
  PlannerEvent,
  ProviderEvent,
  RuntimeEventBus,
  RuntimeEventEnvelope,
  SessionEvent,
  ToolEvent,
  TurnEvent,
} from './events/index.js';
import type { ContractEvent } from '../../events/contract.js';
import { createRuntimeEventFeed, type RuntimeEventFeed } from './event-feeds.js';

export type UiEventFeed<TEvent extends AnyRuntimeEvent> = RuntimeEventFeed<TEvent>;

export interface UiRuntimeEvents {
  readonly sessions: UiEventFeed<SessionEvent>;
  readonly turns: UiEventFeed<TurnEvent>;
  readonly tools: UiEventFeed<ToolEvent>;
  readonly providers: UiEventFeed<ProviderEvent>;
  readonly agents: UiEventFeed<AgentEvent>;
  readonly contracts: UiEventFeed<ContractEvent>;
  readonly planner: UiEventFeed<PlannerEvent>;
  readonly ops: UiEventFeed<OpsEvent>;
}

function createUiEventFeed<TEvent extends AnyRuntimeEvent>(runtimeBus: RuntimeEventBus): UiEventFeed<TEvent> {
  return createRuntimeEventFeed<TEvent>((type, listener) => (
    runtimeBus.on(type as TEvent['type'], listener as (envelope: RuntimeEventEnvelope<TEvent['type'], TEvent>) => void)
  ));
}

export function createUiRuntimeEvents(runtimeBus: RuntimeEventBus): UiRuntimeEvents {
  return {
    sessions: createUiEventFeed<SessionEvent>(runtimeBus),
    turns: createUiEventFeed<TurnEvent>(runtimeBus),
    tools: createUiEventFeed<ToolEvent>(runtimeBus),
    providers: createUiEventFeed<ProviderEvent>(runtimeBus),
    agents: createUiEventFeed<AgentEvent>(runtimeBus),
    contracts: createUiEventFeed<ContractEvent>(runtimeBus),
    planner: createUiEventFeed<PlannerEvent>(runtimeBus),
    ops: createUiEventFeed<OpsEvent>(runtimeBus),
  };
}
