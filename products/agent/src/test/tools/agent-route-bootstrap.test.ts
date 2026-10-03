import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { registerAgentTools } from '../../runtime/bootstrap-agent-tools.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { taskRoutePort } from '../helpers/task-route-readings.ts';

test('actual Agent service composition and bootstrap register both consumers against its installed judgment binding', async () => {
  const root = makeProjectTempDir('agent-route-bootstrap');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
  const services = createRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), workingDir: root, homeDirectory: root, modelDiscovery: 'skip' });
  try {
    // Production composition already installed this settings-driven port. Replace
    // only its I/O method with explicit local readings, never install a test port.
    expect(judgmentPort('routing.task-route.plan')).toBe(services.judgment.port);
    const query = 'send this to the registered fixture channel';
    const fake = taskRoutePort({ [query]: { pick: 'channels', choices: { channelTask: 'send' }, named: { channelTarget: 'msteams', modelProvider: 'openrouter' } } });
    services.judgment.port.ask = fake.port.ask;
    services.channelPlugins.register({ id: 'fixture-teams', surface: 'msteams', displayName: 'Microsoft Teams', capabilities: [] });
    const toolRegistry = new ToolRegistry();
    const commandContext = {
      workspace: { shellPaths: services.shellPaths },
      provider: { providerRegistry: services.providerRegistry },
      platform: { config: configManager.getAll(), configManager },
      session: { runtime: {} },
      extensions: {}, ops: {},
    } as unknown as CommandContext;
    registerAgentTools({ toolRegistry, commandRegistry: new CommandRegistry(), commandContext, configManager, services, getSessionId: () => 'fixture-session' });
    for (const name of ['route', 'agent_harness']) {
      const tool = toolRegistry.list().find(tool => tool.definition.name === name);
      expect(tool).toBeDefined();
      const result = await tool!.execute({ action: 'plan', mode: 'route_decision', query });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(result.error);
      const plan = JSON.parse(result.output!);
      expect(plan).toMatchObject({ status: 'ready', request: query, preferred: { id: 'channel-delivery-boundary', modelRoute: 'channels action:"channel" target:"msteams" includeParameters:true', requiresConfirmation: true }, alternatives: [], routesConsidered: 1, workspaceMatches: [], harnessModeMatches: [] });
    }
    expect(judgmentPort('routing.task-route.plan')).toBe(services.judgment.port);
    expect(fake.requests.filter(request => (request.state as { context?: { kind?: string } }).context?.kind === 'model provider')).toHaveLength(2);
    expect(fake.requests.filter(request => (request.state as { context?: { kind?: string } }).context?.kind === 'messaging channel or notification target')).toHaveLength(2);
  } finally {
    services.dispose();
    await Promise.resolve();
    await Promise.resolve();
  }
}, 15_000);
