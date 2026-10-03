import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { createAgentTool, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { installAgentToolPolicyGuard } from '../../tools/agent-tool-policy-guard.ts';
import { installToolExecutionSafetyGuard } from '../../tools/tool-execution-safety.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

test('Agent policy exposes public contract reads and rejects retired WRFC modes', async () => {
  const root = makeProjectTempDir('agent-contract-policy');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
  const services = createRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), workingDir: root, homeDirectory: root, modelDiscovery: 'skip' });
  try {
    const registry = new ToolRegistry();
    registry.register(createAgentTool({ manager: services.agentManager, messageBus: services.agentMessageBus, configManager, contractRunner: services.contractRunner, projectRoot: root, resolveSessionId: () => 'contract-policy-test' }));
    installAgentToolPolicyGuard(registry);
    installToolExecutionSafetyGuard(registry);
    const parameters = registry.getToolDefinitions().find(tool => tool.name === 'agent')?.parameters;
    expect(parameters).toHaveProperty('properties.mode.enum', expect.arrayContaining(['contracts', 'contract-history']));
    expect(parameters).toHaveProperty('properties.mode.enum', expect.not.arrayContaining(['wrfc-chains', 'wrfc-history']));
    const listed = await registry.execute('list-contracts', 'agent', { mode: 'contracts' });
    expect(listed.success).toBe(true);
    expect(JSON.parse(String(listed.output))).toMatchObject({ mode: 'contracts', count: 0 });
    const history = await registry.execute('read-contract-history', 'agent', { mode: 'contract-history', contractId: 'missing-contract' });
    expect(history.success).toBe(false);
    expect(history.error).toContain("Unknown contract: 'missing-contract'");
    for (const mode of ['wrfc-chains', 'wrfc-history']) {
      const rejected = await registry.execute(`retired-${mode}`, 'agent', { mode });
      expect(rejected.success).toBe(false);
    }
    expect(services.contractRunner.list({ includeTerminal: true })).toEqual([]);
  } finally {
    services.dispose();
    await Promise.resolve();
    await Promise.resolve();
  }
}, 15_000);
