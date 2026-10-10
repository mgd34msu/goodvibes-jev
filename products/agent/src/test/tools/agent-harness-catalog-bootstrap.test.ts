import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { RuntimeEventBus } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAgentTools } from '../../runtime/bootstrap-agent-tools.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { cleanupResearchScreeningFixtures, researchScreeningFixture } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);

test('actual default Agent registration fits full protected schema bounds before model-tool discovery', async () => {
  const root = makeProjectTempDir('agent-catalog-bootstrap');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
  const services = createRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), workingDir: root, homeDirectory: root, modelDiscovery: 'skip' });
  const screening = researchScreeningFixture();
  try {
    const registry = new ToolRegistry();
    bindAgentResearchSourceOwner(registry, screening.owner);
    const context = {
      workspace: { shellPaths: services.shellPaths },
      provider: { providerRegistry: services.providerRegistry },
      platform: { config: configManager.getAll(), configManager },
      session: { runtime: { sessionId: 'catalog-bootstrap' } },
      extensions: {}, ops: {},
    } as unknown as CommandContext;
    registerAgentTools({ toolRegistry: registry, commandRegistry: new CommandRegistry(), commandContext: context, configManager, services, getSessionId: () => 'catalog-bootstrap' });
    const fake = fakePort((_name, _question, state) => noulAnswer((state as unknown as { candidate: { name: string } }).candidate.name === 'agent_harness' ? 0.99 : 0.01));
    services.judgment.port.ask = fake.port.ask;
    expect(judgmentPort('agent.harness.tools')).toBe(services.judgment.port);
    const result = await registry.execute('catalog-bootstrap', 'agent_harness', { mode: 'tools', query: 'an unrelated discovery request', limit: 1, includeParameters: true });
    expect(result.success).toBe(true);
    const output = JSON.parse(String(result.output));
    expect(output.tools).toHaveLength(1);
    expect(output.tools[0].name).toBe('agent_harness');
    expect(output.tools[0].parameters).toEqual(registry.getToolDefinitions().find(tool => tool.name === 'agent_harness')!.parameters);
    expect(registry.list().length).toBeGreaterThan(25);
    expect(fake.requests).toHaveLength(registry.list().length);
    const batches = screening.calls.filter(call => call.path === '/v1/chat/completions').map(call => JSON.parse((call.body.messages as { content: string }[])[1]!.content) as { parts: string[] });
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches.flatMap(batch => batch.parts.map(part => part.length)))).toBeLessThanOrEqual(40_000);
    expect(batches.every(batch => batch.parts.length <= 8 && batch.parts.reduce((sum, part) => sum + part.length, 0) <= 40_000)).toBe(true);
  } finally {
    services.dispose();
    await Promise.resolve();
    await Promise.resolve();
  }
}, 15_000);
