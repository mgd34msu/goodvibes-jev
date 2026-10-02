// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
import { describe, expect, test } from 'bun:test';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import { selectStreamToolPreview } from '../../runtime/store/selectors/index.ts';

describe('createDomainDispatch', () => {
  test('drives conversation state from typed turn and tool events', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTurnEvent({
      type: 'TURN_SUBMITTED',
      turnId: 'turn-1',
      prompt: 'hello',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_START',
      turnId: 'turn-1',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: 'turn-1',
      content: 'hi',
      accumulated: 'hi',
      toolCalls: [{ index: 0, name: 'read_file', arguments: '{"path":"/tmp/demo.txt"}' }],
    });
    dispatch.dispatchToolEvent({
      type: 'TOOL_RECEIVED',
      callId: 'call-1',
      turnId: 'turn-1',
      tool: 'read_file',
      args: { path: '/tmp/demo.txt' },
    });
    dispatch.dispatchToolEvent({
      type: 'TOOL_EXECUTING',
      callId: 'call-1',
      turnId: 'turn-1',
      tool: 'read_file',
      startedAt: 123,
    });
    dispatch.dispatchTurnEvent({
      type: 'TURN_COMPLETED',
      turnId: 'turn-1',
      response: 'done',
      stopReason: 'completed',
    });

    const state = store.getState();
    expect(state.conversation.currentTurnId).toBe('turn-1');
    expect(state.conversation.turnState).toBe('completed');
    expect(state.conversation.stream.accumulated).toBe('hi');
    expect(state.conversation.toolCallsThisTurn).toBe(1);
    expect(state.conversation.activeToolCalls.get('call-1')?.state).toBe('executing');
    expect(state.conversation.totalTurns).toBe(1);
    expect(state.conversation.lastTurnStopReason).toBe('completed');
    expect(state.conversation.lastTurnResponse).toBe('done');
    expect(selectStreamToolPreview(state)).toBeUndefined();
  });

  test('records explicit preflight failure and reconciliation evidence', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTurnEvent({
      type: 'TURN_SUBMITTED',
      turnId: 'turn-2',
      prompt: 'hello',
    });
    dispatch.dispatchToolEvent({
      type: 'TOOL_RECONCILED',
      turnId: 'turn-2',
      count: 1,
      callIds: ['call-9'],
      toolNames: ['read'],
      reason: 'exception-before-results',
      timestamp: 123,
      isMalformed: false,
    });
    dispatch.dispatchTurnEvent({
      type: 'PREFLIGHT_FAIL',
      turnId: 'turn-2',
      reason: 'context overflow',
      stopReason: 'context_overflow',
    });

    const state = store.getState();
    expect(state.conversation.turnState).toBe('failed');
    expect(state.conversation.lastTurnStopReason).toBe('context_overflow');
    expect(state.conversation.lastPreflightFailure).toBe('context overflow');
    expect(state.conversation.lastToolReconciliation?.reason).toBe('exception-before-results');
  });

  test('rejects out-of-order or wrong-turn events and keeps stream preview in the store', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTurnEvent({
      type: 'STREAM_START',
      turnId: 'turn-missing',
    });
    dispatch.dispatchTurnEvent({
      type: 'TURN_SUBMITTED',
      turnId: 'turn-3',
      prompt: 'hello',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_START',
      turnId: 'wrong-turn',
    });
    dispatch.dispatchTurnEvent({
      type: 'PREFLIGHT_OK',
      turnId: 'turn-3',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_START',
      turnId: 'turn-3',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: 'turn-3',
      content: 'tool call',
      accumulated: 'tool call',
      toolCalls: [{ index: 0, name: 'write_file', arguments: '{"path":"/tmp/out.txt","text":"hello world"}' }],
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: 'wrong-turn',
      content: 'bad',
      accumulated: 'bad',
      toolCalls: [{ index: 0, name: 'delete_file', arguments: '{"path":"/tmp/nope.txt"}' }],
    });
    dispatch.dispatchTurnEvent({
      type: 'TURN_COMPLETED',
      turnId: 'turn-3',
      response: 'done',
      stopReason: 'completed',
    });
    dispatch.dispatchTurnEvent({
      type: 'STREAM_DELTA',
      turnId: 'turn-3',
      content: 'late',
      accumulated: 'late',
    });

    const state = store.getState();
    expect(state.conversation.currentTurnId).toBe('turn-3');
    expect(state.conversation.turnState).toBe('completed');
    expect(state.conversation.stream.accumulated).toBe('tool call');
    expect(selectStreamToolPreview(state)).toBeUndefined();
    expect(state.conversation.stream.deltaCount).toBe(1);
  });

  test('stores permission lifecycle and final decision', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchGateEvent({
      type: 'GATE_REQUESTED',
      callId: 'call-2',
      tool: 'exec',
      args: { cmd: 'ls' },
      category: 'execute',
    });
    dispatch.dispatchGateEvent({
      type: 'DECISION_EMITTED',
      callId: 'call-2',
      tool: 'exec',
      category: 'execute',
      approved: true,
      source: 'user_prompt',
    });

    const state = store.getState();
    expect(state.permissions.awaitingDecision).toBe(false);
    expect(state.permissions.totalChecks).toBe(1);
    expect(state.permissions.approvalCount).toBe(1);
    expect(state.permissions.lastDecision?.callId).toBe('call-2');
    expect(state.permissions.lastDecision?.outcome).toBe('approved');
  });

  test('tracks task, agent, plugin, mcp, and transport domain updates', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTaskEvent({
      type: 'TASK_CREATED',
      taskId: 'task-1',
      description: 'demo task',
      priority: 1,
    });
    dispatch.dispatchTaskEvent({
      type: 'TASK_STARTED',
      taskId: 'task-1',
    });
    dispatch.dispatchAgentEvent({
      type: 'AGENT_SPAWNING',
      agentId: 'agent-1',
      taskId: 'task-1',
      task: 'demo task',
    });
    dispatch.dispatchAgentEvent({
      type: 'AGENT_PROGRESS',
      agentId: 'agent-1',
      taskId: 'task-1',
      progress: 'reading files',
    });
    dispatch.dispatchAgentEvent({
      type: 'AGENT_STREAM_DELTA',
      agentId: 'agent-1',
      taskId: 'task-1',
      content: 'hello',
      accumulated: 'hello world',
    });
    dispatch.dispatchPluginEvent({
      type: 'PLUGIN_DISCOVERED',
      pluginId: 'plugin-1',
      path: '/plugins/demo',
      version: '1.0.0',
    });
    dispatch.dispatchMcpEvent({
      type: 'MCP_CONFIGURED',
      serverId: 'mcp-1',
      transport: 'stdio',
      role: 'docs',
      trustMode: 'ask-on-risk',
      allowedPaths: ['/workspace'],
      allowedHosts: ['docs.example.com'],
    });
    dispatch.dispatchMcpEvent({
      type: 'MCP_CONNECTED',
      serverId: 'mcp-1',
      toolCount: 3,
      resourceCount: 1,
    });
    dispatch.dispatchMcpEvent({
      type: 'MCP_POLICY_UPDATED',
      serverId: 'mcp-1',
      role: 'ops',
      trustMode: 'allow-all',
      allowedPaths: ['/srv/app'],
      allowedHosts: ['ops.example.com'],
    });
    dispatch.dispatchMcpEvent({
      type: 'MCP_SCHEMA_QUARANTINED',
      serverId: 'mcp-1',
      reason: 'operator_flagged',
      detail: 'unexpected deploy surface',
    });
    dispatch.dispatchMcpEvent({
      type: 'MCP_SCHEMA_QUARANTINE_APPROVED',
      serverId: 'mcp-1',
      operatorId: 'alice',
    });
    dispatch.dispatchTransportEvent({
      type: 'TRANSPORT_CONNECTED',
      transportId: 'daemon:primary',
      endpoint: 'ipc://daemon.sock',
    });

    const state = store.getState();
    expect(state.tasks.runningIds).toEqual(['task-1']);
    expect(state.agents.activeAgentIds).toEqual(['agent-1']);
    expect(state.agents.agents.get('agent-1')?.latestProgress).toBe('reading files');
    expect(state.agents.agents.get('agent-1')?.latestOutput).toBe('hello world');
    expect(state.plugins.plugins.get('plugin-1')?.status).toBe('discovered');
    expect(state.mcp.connectedServerNames).toEqual(['mcp-1']);
    expect(state.mcp.availableToolCount).toBe(3);
    expect(state.mcp.servers.get('mcp-1')?.trustMode).toBe('allow-all');
    expect(state.mcp.servers.get('mcp-1')?.role).toBe('ops');
    expect(state.mcp.servers.get('mcp-1')?.allowedPaths).toEqual(['/srv/app']);
    expect(state.mcp.servers.get('mcp-1')?.schemaFreshness).toBe('stale');
    expect(state.mcp.servers.get('mcp-1')?.quarantineReason).toBe('operator_flagged');
    expect(state.mcp.servers.get('mcp-1')?.quarantineApprovedBy).toBe('alice');
    expect(state.daemon.transportState).toBe('connected');
  });

  test('tracks contract groups, unit progress, checks and spawn-guard evidence', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.dispatchContractEvent({ type: 'CONTRACT_CREATED', contractId: 'contract-1', sessionId: 'session-1', origin: 'turn', ask: 'Repair the fixture', ownerAgentId: 'owner-1' });
    dispatch.dispatchContractEvent({
      type: 'CONTRACT_PLANNED', contractId: 'contract-1', goal: 'A validated repair', repair: 0,
      criteria: [{ id: 'criterion-1', text: 'The test passes', origin: 'stated', serves: [], disposition: 'judged' }],
      groups: [{ id: 'group-1', title: 'Repair', kind: 'work', dependsOn: [], unitIds: ['unit-1', 'unit-2'] }],
      units: [
        { id: 'unit-1', groupId: 'group-1', title: 'Implement', role: 'implement', dependsOn: [], attempts: 1 },
        { id: 'unit-2', groupId: 'group-1', title: 'Integrate', role: 'integration', dependsOn: ['unit-1'], attempts: 1 },
      ],
    });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_STATUS_CHANGED', contractId: 'contract-1', from: 'queued', to: 'running' });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_GROUP_STATUS_CHANGED', contractId: 'contract-1', groupId: 'group-1', from: 'pending', to: 'running' });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: 'contract-1', groupId: 'group-1', unitId: 'unit-1', from: 'pending', to: 'running', agentId: 'agent-1' });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: 'contract-1', groupId: 'group-1', unitId: 'unit-2', from: 'pending', to: 'blocked' });
    dispatch.dispatchContractEvent({
      type: 'CONTRACT_CHECKED', contractId: 'contract-1', scope: 'unit', targetId: 'unit-1', checkId: 'check-1', trigger: 'completion', result: 'pass',
      criteria: [{ criterionId: 'criterion-1', verdict: 'met', probabilityUnmet: 0.01, outcome: 'act' }],
      goal: { verdict: 'met', outcome: 'act' }, quality: [], gates: [], decisionIds: [],
    });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_UNIT_STATUS_CHANGED', contractId: 'contract-1', groupId: 'group-1', unitId: 'unit-1', from: 'running', to: 'passed' });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_SPAWN_GUARD_TRIGGERED', contractId: 'contract-1', agentId: 'agent-1', depth: 2, activeAgents: 9, reason: 'breadth limit' });

    const state = store.getState();
    const contract = state.contracts.contracts.get('contract-1');
    expect(contract?.status).toBe('running');
    expect(contract?.ownerAgentId).toBe('owner-1');
    expect(contract?.groups.get('group-1')?.unitIds).toEqual(['unit-1', 'unit-2']);
    expect(contract?.units.get('unit-1')?.status).toBe('passed');
    expect(contract?.units.get('unit-1')?.agentId).toBe('agent-1');
    expect(contract?.units.get('unit-1')?.lastCheckId).toBe('check-1');
    expect(contract?.units.get('unit-1')?.verdicts).toEqual({ 'criterion-1': 'met' });
    expect(contract?.units.get('unit-2')?.status).toBe('blocked');
    expect(state.contracts.spawnGuardTrips).toBe(1);
    expect(state.contracts.activeContractIds).toEqual(['contract-1']);
  });

  test('keeps owner escalation and terminal contract outcomes distinct', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.dispatchContractEvent({ type: 'CONTRACT_CREATED', contractId: 'waiting', sessionId: 'session-1', origin: 'turn', ask: 'Repair', ownerAgentId: 'owner-1' });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_ESCALATED', contractId: 'waiting', escalationId: 'question-1', scope: 'deliverable', targetId: 'waiting', reason: 'owner-decision-needed', question: 'Proceed?', unmetCriterionIds: [] });
    expect(store.getState().contracts.contracts.get('waiting')?.openEscalations).toMatchObject([{ escalationId: 'question-1', question: 'Proceed?' }]);
    dispatch.dispatchContractEvent({ type: 'CONTRACT_OWNER_REPLIED', contractId: 'waiting', escalationId: 'question-1', reading: 'approve', outcome: 'act', action: 'approved' });
    expect(store.getState().contracts.contracts.get('waiting')?.openEscalations).toEqual([]);
    dispatch.dispatchContractEvent({ type: 'CONTRACT_PASSED', contractId: 'waiting', criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_FAILED', contractId: 'failed', reason: 'Reader unavailable', failureKind: 'judgment-unavailable', membersSettled: true });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_CANCELLED', contractId: 'cancelled', reason: 'Owner stopped work', filesModified: 0 });
    const state = store.getState().contracts;
    expect(state.activeContractIds).toEqual([]);
    expect([state.totalPassed, state.totalFailed, state.totalCancelled]).toEqual([1, 1, 1]);
    expect(state.contracts.get('failed')?.failureKind).toBe('judgment-unavailable');
    expect(state.contracts.get('failed')?.reason).toBe('Reader unavailable');
    expect(state.contracts.get('cancelled')?.status).toBe('cancelled');
    expect(state.contracts.get('cancelled')?.reason).toBe('Owner stopped work');
  });

  test('tracks structured communication history and blocked-route evidence', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchCommunicationEvent({
      type: 'COMMUNICATION_SENT',
      messageId: 'comm-1',
      fromId: 'reviewer-1',
      toId: 'engineer-1',
      scope: 'direct',
      kind: 'review',
      content: 'Please address findings.',
      fromRole: 'reviewer',
      toRole: 'engineer',
      contractId: 'contract-1',
    });
    dispatch.dispatchCommunicationEvent({
      type: 'COMMUNICATION_DELIVERED',
      messageId: 'comm-1',
      fromId: 'reviewer-1',
      toId: 'engineer-1',
      scope: 'direct',
      kind: 'review',
    });
    dispatch.dispatchCommunicationEvent({
      type: 'COMMUNICATION_BLOCKED',
      messageId: 'comm-2',
      fromId: 'reviewer-1',
      toId: '*',
      scope: 'broadcast',
      kind: 'status',
      reason: 'broadcast reserved for orchestrator',
      fromRole: 'reviewer',
    });

    const state = store.getState();
    expect(state.communication.totalSent).toBe(1);
    expect(state.communication.totalDelivered).toBe(1);
    expect(state.communication.totalBlocked).toBe(1);
    expect(state.communication.recentRecordIds).toEqual(['comm-2', 'comm-1']);
    expect(state.communication.records.get('comm-1')?.status).toBe('delivered');
    expect(state.communication.records.get('comm-1')?.kind).toBe('review');
    expect(state.communication.records.get('comm-1')?.contractId).toBe('contract-1');
    expect(state.communication.records.get('comm-2')?.status).toBe('blocked');
    expect(state.communication.records.get('comm-2')?.reason).toContain('broadcast');
  });
});
