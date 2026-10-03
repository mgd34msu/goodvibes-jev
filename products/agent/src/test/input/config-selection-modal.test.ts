import { describe, expect, test } from 'bun:test';
import { join } from 'path';
import { rmSync } from 'fs';

import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerConfigCommand } from '../../input/commands/config.ts';
import { isAgentHiddenSettingKey, SettingsModal } from '../../input/settings-modal.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { CONFIG_SCHEMA } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeConfigManager(dir: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'tui',
    workingDir: dir,
    configDir: join(dir, '.goodvibes', 'tui'),
  });
}

function makeContext(dir: string): {
  ctx: CommandContext;
  calls: {
    printed: string[];
    settingsTargets: Array<string | undefined>;
  };
} {
  const cm = makeConfigManager(dir);
  const calls = {
    printed: [] as string[],
    settingsTargets: [] as Array<string | undefined>,
  };
  const ctx = {
    session: {
      conversationManager: {} as never,
      runtime: { model: '', provider: '', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 's' },
    },
    provider: { providerRegistry: {} as never },
    workspace: {},
    platform: {
      config: cm.getAll(),
      configManager: cm,
    },
    ops: {},
    extensions: {
      toolRegistry: {} as never,
      mcpRegistry: {} as never,
    },
    renderRequest: () => {},
    print: (text: string) => { calls.printed.push(text); },
    exit: () => {},
    openSettingsModal: (target?: string) => {
      calls.settingsTargets.push(target);
    },
  } as unknown as CommandContext;
  return { ctx, calls };
}

describe('/config fullscreen workspace command', () => {
  test('/config opens the fullscreen configuration workspace at an optional target', async () => {
    const dir = makeProjectTempDir(`gv-config-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const registry = new CommandRegistry();
      registerConfigCommand(registry);

      const command = registry.get('config');
      expect(command).toEqual(expect.objectContaining({ name: 'config' }));
      expect(registry.get('cfg')).toBe(command);
      expect(registry.get('config-old')).toBeUndefined();
      expect(registry.get('cfg-old')).toBeUndefined();

      const { ctx, calls } = makeContext(dir);
      await command!.handler(['surfaces.ntfy.baseUrl'], ctx);

      expect(calls.settingsTargets).toEqual(['surfaces.ntfy.baseUrl']);
      expect(calls.printed).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the fullscreen workspace includes every shared config key previously reachable through raw config', () => {
    const dir = makeProjectTempDir(`gv-config-coverage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const cm = makeConfigManager(dir);
      const modal = new SettingsModal();
      const subscriptions = new SubscriptionManager(join(dir, '.goodvibes', 'tui', 'subscriptions.json'));
      const services = new ServiceRegistry(join(dir, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: dir, globalHome: dir, configManager: cm }),
        subscriptionManager: subscriptions,
      });

      modal.open(cm, createFeatureFlagManager(), subscriptions, services);

      const workspaceKeys = new Set<string>();
      for (const entries of modal.groups.values()) {
        for (const entry of entries) workspaceKeys.add(entry.setting.key);
      }

      expect(CONFIG_SCHEMA.map((entry) => entry.key).filter((key) => !isAgentHiddenSettingKey(key) && !workspaceKeys.has(key))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the fullscreen workspace does not expose copied host/runtime lifecycle targets', () => {
    const dir = makeProjectTempDir(`gv-config-hidden-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const cm = makeConfigManager(dir);
      const modal = new SettingsModal();
      const subscriptions = new SubscriptionManager(join(dir, '.goodvibes', 'tui', 'subscriptions.json'));
      const services = new ServiceRegistry(join(dir, '.goodvibes', 'tui', 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: dir, globalHome: dir, configManager: cm }),
        subscriptionManager: subscriptions,
      });

      modal.open(cm, createFeatureFlagManager(), subscriptions, services);

      const workspaceKeys = new Set<string>();
      for (const entries of modal.groups.values()) {
        for (const entry of entries) workspaceKeys.add(entry.setting.key);
      }

      // `ui.wrfcMessages` is internal plumbing with nothing for the owner to
      // decide, so it stays out. `danger.httpListener` is the opposite: it is a
      // real choice about this machine, so it is SHOWN and its write is gated by
      // the confirmation list in src/tools/agent-settings-write-policy.ts. A
      // hidden setting cannot state a hazard or be confirmed; a gated one can.
      expect(isAgentHiddenSettingKey('danger.httpListener')).toBe(false);
      expect(isAgentHiddenSettingKey('controlPlane.port')).toBe(false);
      expect(isAgentHiddenSettingKey('runtime.eventBus.maxListeners')).toBe(false);
      expect(isAgentHiddenSettingKey('ui.wrfcMessages')).toBe(true);
      expect(workspaceKeys.has('danger.httpListener')).toBe(true);
      expect(workspaceKeys.has('controlPlane.port')).toBe(true);
      expect(workspaceKeys.has('runtime.eventBus.maxListeners')).toBe(true);
      expect(workspaceKeys.has('ui.wrfcMessages')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
