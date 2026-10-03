import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createDomainDispatch, createRuntimeStore } from '../../runtime/store/index.ts';
import { registerAgentRuntimeEvents } from '../../runtime/agent-runtime-events.ts';
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
      agentManager: services.agentManager, toolRegistry: new ToolRegistry(),
      getSystemMessageRouter: () => ({ high: line => lines.push(line), low: line => lines.push(line) }),
      requestRender: rendered,
    });
    try {
      configManager.set('permissions.mode', 'plan');
      await didRender;
      expect(services.runtimeStore.getState().permissions.mode).toBe('plan');
      expect(lines.filter(line => line.includes('Permission preset changed:'))).toHaveLength(1);
      expect(lines[0]).toContain('-> plan');
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
