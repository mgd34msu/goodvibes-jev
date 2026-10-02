import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('Agent memory storage path', () => {
  let root = '';

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function makeRuntimeServices(): {
    readonly services: RuntimeServices;
    readonly workingDir: string;
    readonly homeDir: string;
  } {
    root = makeProjectTempDir('goodvibes-agent-memory-path');
    const workingDir = join(root, 'workspace');
    const homeDir = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const configManager = new ConfigManager({
      surfaceRoot: 'agent',
      workingDir,
      homeDir,
      configDir: join(homeDir, '.goodvibes', 'agent'),
    });
    return {
      services: createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
        runtimeBus: new RuntimeEventBus(),
        runtimeStore: createRuntimeStore(),
        configManager,
        workingDir,
        homeDirectory: homeDir,
      }),
      workingDir,
      homeDir,
    };
  }

  test('runtime memory store is Agent-home owned instead of workspace owned', async () => {
    const { services, workingDir, homeDir } = makeRuntimeServices();
    // The agent opens the ONE canonical cross-surface store under the
    // Agent home (~/.goodvibes/shared/memory.sqlite) rather than a private per-surface
    // agent/memory.sqlite, a fact learned here must recall in the TUI and vice-versa.
    // The invariant this test guards is unchanged: the store is Agent-home owned, never
    // workspace owned.
    const homeMemoryPath = join(homeDir, '.goodvibes', 'shared', 'memory.sqlite');
    const workspaceMemoryPath = join(workingDir, '.goodvibes', 'shared', 'memory.sqlite');

    try {
      await services.memoryStore.init();
      await services.memoryRegistry.add({
        cls: 'fact',
        scope: 'project',
        summary: 'Agent memory follows the Agent home/profile.',
      });
      await services.memoryStore.save();
    } finally {
      services.memoryStore.close();
      services.providerRegistry.stopWatching();
    }

    expect(existsSync(homeMemoryPath)).toBe(true);
    expect(existsSync(workspaceMemoryPath)).toBe(false);
  });
});
