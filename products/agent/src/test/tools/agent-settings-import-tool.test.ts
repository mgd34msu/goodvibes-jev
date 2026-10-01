import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../../input/command-registry.ts';
import { ConfigManager } from '../../config/index.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../config/secret-config.ts';
import { createShellPathService } from '@/runtime/index.ts';
import {
  createAgentSettingsImportTool,
  registerAgentSettingsImportTool,
} from '../../tools/agent-settings-import-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

type ShellPaths = ReturnType<typeof createShellPathService>;

interface Fixture {
  readonly root: string;
  readonly paths: ShellPaths;
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly context: CommandContext;
  readonly cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = makeProjectTempDir('goodvibes-agent-settings-import-tool');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
  const secretsManager = new SecretsManager({ projectRoot: root, globalHome: root, configManager });
  const subscriptionManager = new SubscriptionManager(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'subscriptions.json'));
  const context = {
    session: {
      runtime: {
        model: 'openai:gpt-test',
        provider: 'openai',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
        sessionId: 'test-session',
      },
    },
    provider: {},
    workspace: { shellPaths: paths },
    platform: {
      config: configManager.getAll(),
      configManager,
      secretsManager,
      subscriptionManager,
    },
    ops: {},
    extensions: {},
    renderRequest: () => {},
    print: () => {},
    exit: () => {},
  } as unknown as CommandContext;

  return {
    root,
    paths,
    configManager,
    secretsManager,
    context,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('import_goodvibes_settings adapter', () => {
  test('previews and applies GoodVibes settings import without exposing secrets', async () => {
    const fixture = makeFixture();
    try {
      const nextSaveHistory = !Boolean(fixture.configManager.get('behavior.saveHistory'));
      mkdirSync(fixture.paths.resolveUserPath('tui'), { recursive: true });
      writeFileSync(fixture.paths.resolveUserPath('tui', 'settings.json'), JSON.stringify({
        behavior: { saveHistory: nextSaveHistory },
        surfaces: {
          slack: { botToken: 'xoxb-import-secret' },
        },
      }, null, 2));
      const tool = createAgentSettingsImportTool(fixture.context);

      const preview = await tool.execute({ action: 'preview' });
      expect(preview.success).toBe(true);
      expect(preview.output).toContain('"status": "confirmation_required"');
      expect(preview.output).toContain('"settingsToImport": 2');
      expect(preview.output).toContain('"sourceCatalog"');
      expect(preview.output).toContain('"packageId": "goodvibes-tui"');
      expect(preview.output).toContain('"ownership": "source-owned"');
      expect(preview.output).toContain('"mutatesSource": false');
      expect(preview.output).toContain('<redacted>');
      expect(preview.output).not.toContain('xoxb-import-secret');
      expect(fixture.configManager.get('behavior.saveHistory')).toBe(!nextSaveHistory);

      const missingUserRequest = await tool.execute({ action: 'apply', confirm: true });
      expect(missingUserRequest.success).toBe(false);
      expect(missingUserRequest.error).toContain('explicitUserRequest');

      const applied = await tool.execute({
        action: 'apply',
        confirm: true,
        explicitUserRequest: 'Import my existing GoodVibes settings into Agent.',
      });
      expect(applied.success).toBe(true);
      expect(applied.output).toContain('GoodVibes settings imported');
      expect(applied.output).not.toContain('xoxb-import-secret');
      expect(fixture.configManager.get('behavior.saveHistory')).toBe(nextSaveHistory);
      expect(fixture.configManager.get('surfaces.slack.botToken')).toBe(
        buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.slack.botToken')),
      );
      expect(await fixture.secretsManager.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBe('xoxb-import-secret');
    } finally {
      fixture.cleanup();
    }
  });

  test('registers the direct import adapter', () => {
    const fixture = makeFixture();
    try {
      const registry = new ToolRegistry();

      registerAgentSettingsImportTool(registry, fixture.context);

      expect(registry.has('import_goodvibes_settings')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
