import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createDomainDispatch, createRuntimeStore } from '../../runtime/store/index.ts';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';
import { emitContractEvent } from '@goodvibes-jev/engine/sdk/platform/contract';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

test('the actual Agent graph exposes the published contract services and disposes offline', async () => {
  const root = makeProjectTempDir('agent-public-service-graph');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const configManager = new ConfigManager({
    surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent'),
  });
  const runtimeBus = new RuntimeEventBus();
  const services = createRuntimeServices({
    configManager, runtimeBus, runtimeStore: createRuntimeStore(),
    workingDir: root, homeDirectory: root, modelDiscovery: 'skip',
  });
  try {
    expect(services.contractRunner.list({ includeTerminal: true })).toEqual([]);
    expect(services.contractIntake).toBeDefined();
    expect(services.contractOperator).toBeDefined();
    expect(services.judgment).toBeDefined();
    expect(services.permissionManager).toBeDefined();
    expect(services.execPromptAnswerHandler).toBeFunction();
    expect(services.sandboxEscalationHandler).toBeFunction();
    expect(services.asDaemonGradeView().contractRunner).toBe(services.contractRunner);
    expect(services.runtimeStore.getState().contracts.contracts.size).toBe(0);
    const lines: string[] = [];
    let rendered!: () => void;
    const didRender = new Promise<void>(resolve => { rendered = resolve; });
    const bridge = registerAgentRuntimeEvents({
      runtimeBus, domainDispatch: createDomainDispatch(services.runtimeStore), configManager,
      agentManager: services.agentManager, contractRunner: services.contractRunner, toolRegistry: new ToolRegistry(),
      getSystemMessageRouter: () => ({ contract: line => lines.push(line), high: line => lines.push(line), low: line => lines.push(line) }),
      requestRender: rendered,
    });
    try {
      configManager.set('permissions.mode', 'plan');
      await didRender;
      expect(services.runtimeStore.getState().permissions.mode).toBe('plan');
      expect(lines.filter(line => line.includes('Permission preset changed:'))).toHaveLength(1);
      expect(lines[0]).toContain('-> plan');
      emitContractEvent(runtimeBus, 'agent-graph-session', {
        type: 'CONTRACT_CREATED', contractId: 'ctr-agent-graph', sessionId: 'agent-graph-session',
        origin: 'turn', ask: 'Verify the Agent graph contract caller', ownerAgentId: 'agent-owner',
      });
      emitContractEvent(runtimeBus, 'agent-graph-session', {
        type: 'CONTRACT_PASSED', contractId: 'ctr-agent-graph', criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0,
      });
      // The event bus queues each synchronous lifecycle handler on a microtask.
      await Promise.resolve();
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe('[Contract] ctr-agent-graph started: Verify the Agent graph contract caller');
      expect(lines[2]).toBe('[Contract] ✓ ctr-agent-graph PASSED: 1 of 1 criteria met, 0 corrections');
      expect(services.runtimeStore.getState().contracts.contracts.get('ctr-agent-graph')?.status).toBe('passed');
    } finally {
      for (const unsubscribe of bridge.unsubs) unsubscribe();
      if (bridge.agentStatusIntervalRef.value) clearInterval(bridge.agentStatusIntervalRef.value);
    }
  } finally {
    services.dispose();
    await Promise.resolve();
    await Promise.resolve();
  }
}, 15_000);
