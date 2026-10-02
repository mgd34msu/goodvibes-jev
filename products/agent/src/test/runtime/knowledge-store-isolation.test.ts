import { seedProviderMetadataCacheFixture } from '../helpers/provider-metadata-cache-fixture.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { KnowledgeStore } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

function makeRuntime() {
  const root = makeProjectTempDir(`gv-knowledge-isolation-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const workingDir = join(root, 'workspace');
  const homeDir = join(root, 'home');
  const configDir = join(root, 'config');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  roots.push(root);

  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir,
    workingDir,
    homeDir,
  });

  seedProviderMetadataCacheFixture({ configManager, homeDirectory: homeDir, workingDirectory: workingDir });
  return {
    configManager,
    services: createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      configManager,
      runtimeBus: new RuntimeEventBus(),
      runtimeStore: createRuntimeStore(),
      workingDir,
      homeDirectory: homeDir,
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runtime knowledge store isolation', () => {
  test('Agent Knowledge is the only runtime knowledge surface created by Agent', async () => {
    const { configManager, services } = makeRuntime();
    const controlPlaneDir = configManager.getControlPlaneConfigDir();

    expect(services.knowledgeService).toBe(services.agentKnowledgeService);
    const agentStatus = await services.agentKnowledgeService.getStatus({ includeAllSpaces: true });

    expect(agentStatus.sourceCount).toBe(0);
    expect(agentStatus.nodeCount).toBe(0);
    expect(existsSync(join(controlPlaneDir, 'knowledge-wiki.sqlite'))).toBe(false);
    // Empty reads initialize the in-memory store without creating a database file.
    expect(existsSync(join(controlPlaneDir, 'knowledge-agent.sqlite'))).toBe(false);
    expect(existsSync(join(controlPlaneDir, ['knowledge-home', 'graph.sqlite'].join('-')))).toBe(false);

    const aliasNodes = services.knowledgeService.queryNodes({ includeAllSpaces: true, limit: 100 }).items;
    const agentNodes = services.agentKnowledgeService.queryNodes({ includeAllSpaces: true, limit: 100 }).items;
    const aliasMap = await services.knowledgeService.map({ includeAllSpaces: true, limit: 100 });
    expect(aliasNodes).toHaveLength(0);
    expect(agentNodes).toHaveLength(0);
    expect(aliasMap.nodes).toHaveLength(0);
  });

  test('orchestrator and multimodal writeback use Agent Knowledge through every runtime alias', () => {
    const { services } = makeRuntime();
    const orchestrator = services.agentOrchestrator as unknown as {
      readonly toolDeps?: {
        readonly knowledgeService?: object;
      };
    };
    const multimodal = services.multimodalService as unknown as {
      readonly knowledgeService?: object;
    };

    expect(orchestrator.toolDeps?.knowledgeService).toBe(services.agentKnowledgeService);
    expect(orchestrator.toolDeps?.knowledgeService).toBe(services.knowledgeService);
    expect(multimodal.knowledgeService).toBe(services.agentKnowledgeService);
    expect(multimodal.knowledgeService).toBe(services.knowledgeService);
  });

  test('project planning and work plans store artifacts in Agent Knowledge only', async () => {
    const { configManager, services } = makeRuntime();
    const controlPlaneDir = configManager.getControlPlaneConfigDir();
    const agentDbPath = join(controlPlaneDir, 'knowledge-agent.sqlite');

    await services.projectPlanningService.createWorkPlanTask({
      task: {
        title: 'Keep Agent work plans isolated',
        source: 'agent',
        originSurface: GOODVIBES_AGENT_SURFACE_ROOT,
      },
    });

    const agentSources = services.agentKnowledgeService.querySources({
      includeAllSpaces: true,
      connectorId: 'goodvibes-project-planning',
      limit: 100,
    }).items;
    const aliasSources = services.knowledgeService.querySources({
      includeAllSpaces: true,
      connectorId: 'goodvibes-project-planning',
      limit: 100,
    }).items;

    expect(agentSources).toHaveLength(1);
    expect(agentSources[0]?.title).toBe('Project Work Plan');
    expect(aliasSources).toHaveLength(1);
    expect(aliasSources[0]?.id).toBe(agentSources[0]?.id);

    // Await a real mutation before asserting durable, physically isolated storage.
    expect(existsSync(agentDbPath)).toBe(true);
    expect(existsSync(join(controlPlaneDir, 'knowledge-wiki.sqlite'))).toBe(false);
    expect(existsSync(join(controlPlaneDir, ['knowledge-home', 'graph.sqlite'].join('-')))).toBe(false);
    const reopened = new KnowledgeStore({ dbPath: agentDbPath, family: 'agent' });
    try {
      await reopened.init();
      expect(reopened.listSources()).toEqual(agentSources);
      expect(reopened.listSources()[0]?.metadata.value).toMatchObject({
        tasks: [{ title: 'Keep Agent work plans isolated', originSurface: GOODVIBES_AGENT_SURFACE_ROOT }],
      });
    } finally {
      await reopened.close();
    }
  });
});
