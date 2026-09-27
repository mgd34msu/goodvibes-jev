import type { HookDispatcher } from '../hooks/index.js';
import type { HookCategory, HookEventPath, HookPhase } from '../hooks/types.js';
import type { MutableRuntimeState } from './mutable-runtime-state.js';
import type { AgentEvent, OpsEvent, RuntimeEventBus } from './events/index.js';
import type { ContractEvent } from '../../events/contract.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

interface FireHookOptions {
  readonly hookDispatcher: HookDispatcher;
  readonly runtime: MutableRuntimeState;
}

function fireHook(
  options: FireHookOptions,
  path: HookEventPath,
  phase: HookPhase,
  category: HookCategory,
  specific: string,
  payload: Record<string, unknown>,
): void {
  options.hookDispatcher.fire({
    path,
    phase,
    category,
    specific,
    sessionId: options.runtime.sessionId,
    timestamp: Date.now(),
    payload,
  }).catch((err: unknown) => logger.warn('Hook bridge fire error', { path, error: summarizeError(err) }));
}

export interface HookBridgeRegistrationOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly hookDispatcher: HookDispatcher;
  readonly runtime: MutableRuntimeState;
}

export function registerBootstrapHookBridge(
  options: HookBridgeRegistrationOptions,
): Array<() => void> {
  const fireOptions: FireHookOptions = {
    hookDispatcher: options.hookDispatcher,
    runtime: options.runtime,
  };
  const unsubs: Array<() => void> = [];
  const { runtimeBus } = options;

  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_SPAWNING' }>>('AGENT_SPAWNING', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:agent:spawned', 'Lifecycle', 'agent', 'spawned', { agentId: payload.agentId, task: payload.task });
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:agent:completed', 'Lifecycle', 'agent', 'completed', {
      agentId: payload.agentId,
      result: {
        durationMs: payload.durationMs,
        ...(payload.output !== undefined ? { output: payload.output } : {}),
        ...(payload.toolCallsMade !== undefined ? { toolCallsMade: payload.toolCallsMade } : {}),
      },
    });
  }));
  // A cancelled run emits AGENT_CANCELLED (every cancel path in the agent runner,
  // including a cancel seen during a retry wait), so the hook follows the event
  // type, never the wording of an error.
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:agent:failed', 'Lifecycle', 'agent', 'failed', { agentId: payload.agentId, error: payload.error });
  }));
  unsubs.push(runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>('AGENT_CANCELLED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:agent:cancelled', 'Lifecycle', 'agent', 'cancelled', { agentId: payload.agentId, error: payload.reason ?? 'Agent cancelled' });
  }));

  const onContract = <T extends ContractEvent['type']>(type: T, handler: (payload: Extract<ContractEvent, { type: T }>) => void): void => {
    // The bus delivers only events of `type`, so the payload is that member of the union.
    unsubs.push(runtimeBus.on<ContractEvent>(type, ({ payload }) => handler(payload as Extract<ContractEvent, { type: T }>)));
  };
  onContract('CONTRACT_CREATED', (payload) => {
    fireHook(fireOptions, 'Lifecycle:contract:created', 'Lifecycle', 'contract', 'created', {
      contractId: payload.contractId,
      origin: payload.origin,
      ask: payload.ask,
      ownerAgentId: payload.ownerAgentId,
    });
  });
  onContract('CONTRACT_PLANNED', (payload) => {
    fireHook(fireOptions, 'Lifecycle:contract:planned', 'Lifecycle', 'contract', 'planned', {
      contractId: payload.contractId,
      goal: payload.goal,
      criteria: payload.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text, disposition: criterion.disposition })),
      groupIds: payload.groups.map((group) => group.id),
      unitIds: payload.units.map((unit) => unit.id),
      repair: payload.repair,
    });
  });
  onContract('CONTRACT_CHECKED', (payload) => {
    fireHook(fireOptions, 'Lifecycle:contract:checked', 'Lifecycle', 'contract', 'checked', {
      contractId: payload.contractId,
      scope: payload.scope,
      targetId: payload.targetId,
      checkId: payload.checkId,
      trigger: payload.trigger,
      result: payload.result,
      criteria: payload.criteria.map((criterion) => ({ criterionId: criterion.criterionId, verdict: criterion.verdict })),
    });
  });
  onContract('CONTRACT_NUDGED', (payload) => {
    fireHook(fireOptions, 'Lifecycle:contract:nudged', 'Lifecycle', 'contract', 'nudged', {
      contractId: payload.contractId,
      unitId: payload.unitId,
      nudgeId: payload.nudgeId,
      kinds: [...payload.kinds],
      criterionIds: [...payload.criterionIds],
      agentId: payload.agentId,
    });
  });
  onContract('CONTRACT_ESCALATED', (payload) => {
    fireHook(fireOptions, 'Lifecycle:contract:escalated', 'Lifecycle', 'contract', 'escalated', {
      contractId: payload.contractId,
      escalationId: payload.escalationId,
      scope: payload.scope,
      targetId: payload.targetId,
      reason: payload.reason,
      question: payload.question,
    });
  });
  onContract('CONTRACT_PASSED', (payload) => {
    fireHook(fireOptions, 'Lifecycle:contract:passed', 'Lifecycle', 'contract', 'passed', {
      contractId: payload.contractId,
      criteriaMet: payload.criteriaMet,
      criteriaJudged: payload.criteriaJudged,
      nudges: payload.nudges,
    });
  });
  onContract('CONTRACT_FAILED', (payload) => {
    fireHook(fireOptions, 'Lifecycle:contract:failed', 'Lifecycle', 'contract', 'failed', {
      contractId: payload.contractId,
      reason: payload.reason,
      failureKind: payload.failureKind,
    });
  });
  onContract('CONTRACT_CANCELLED', (payload) => {
    fireHook(fireOptions, 'Lifecycle:contract:cancelled', 'Lifecycle', 'contract', 'cancelled', {
      contractId: payload.contractId,
      reason: payload.reason,
      filesModified: payload.filesModified,
    });
  });
  onContract('CONTRACT_SPAWN_GUARD_TRIGGERED', (payload) => {
    fireHook(fireOptions, 'Change:contract:spawn-guard', 'Change', 'contract', 'spawn-guard', {
      ...(payload.contractId !== undefined ? { contractId: payload.contractId } : {}),
      agentId: payload.agentId,
      depth: payload.depth,
      activeAgents: payload.activeAgents,
      reason: payload.reason,
    });
  });
  unsubs.push(runtimeBus.on<Extract<import('../../events/communication.js').CommunicationEvent, { type: 'COMMUNICATION_SENT' }>>('COMMUNICATION_SENT', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:communication:sent', 'Lifecycle', 'communication', 'sent', {
      messageId: payload.messageId,
      fromId: payload.fromId,
      toId: payload.toId,
      scope: payload.scope,
      kind: payload.kind,
      ...(payload.fromRole !== undefined ? { fromRole: payload.fromRole } : {}),
      ...(payload.toRole !== undefined ? { toRole: payload.toRole } : {}),
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('../../events/communication.js').CommunicationEvent, { type: 'COMMUNICATION_DELIVERED' }>>('COMMUNICATION_DELIVERED', ({ payload }) => {
    fireHook(fireOptions, 'Lifecycle:communication:delivered', 'Lifecycle', 'communication', 'delivered', {
      messageId: payload.messageId,
      fromId: payload.fromId,
      toId: payload.toId,
      scope: payload.scope,
      kind: payload.kind,
    });
  }));
  unsubs.push(runtimeBus.on<Extract<import('../../events/communication.js').CommunicationEvent, { type: 'COMMUNICATION_BLOCKED' }>>('COMMUNICATION_BLOCKED', ({ payload }) => {
    fireHook(fireOptions, 'Change:communication:blocked', 'Change', 'communication', 'blocked', {
      messageId: payload.messageId,
      fromId: payload.fromId,
      toId: payload.toId,
      scope: payload.scope,
      kind: payload.kind,
      reason: payload.reason,
      ...(payload.fromRole !== undefined ? { fromRole: payload.fromRole } : {}),
      ...(payload.toRole !== undefined ? { toRole: payload.toRole } : {}),
    });
  }));
  unsubs.push(runtimeBus.on<Extract<OpsEvent, { type: 'OPS_CONTEXT_WARNING' }>>('OPS_CONTEXT_WARNING', ({ payload }) => {
    const { usage, threshold } = payload;
    const specific = payload.reason === 'safety-buffer' || usage >= threshold ? 'exceeded' : 'warning';
    fireHook(fireOptions, `Change:budget:${specific}` as HookEventPath, 'Change', 'budget', specific, payload);
  }));

  return unsubs;
}
