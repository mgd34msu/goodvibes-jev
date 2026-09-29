import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import {
  appendGoodVibesRuntimeAwarenessPrompt,
  createGoodVibesContextTool,
  createGoodVibesSettingsTool,
} from '../sdk/src/platform/tools/goodvibes-runtime/index.js';
import { useConfigReadings } from './_helpers/config-readings.ts';

function makeConfigManager(): ConfigManager {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-runtime-tool-'));
  return new ConfigManager({
    configDir: join(root, 'config'),
    homeDir: join(root, 'home'),
    workingDir: join(root, 'workspace'),
    surfaceRoot: 'goodvibes',
  });
}

function makeProviderRegistry() {
  return {
    getCurrentModel: () => ({
      id: 'gpt-5.5',
      provider: 'openai',
      registryKey: 'openai:gpt-5.5',
      displayName: 'GPT-5.5',
    }),
    listProviders: () => [{ name: 'openai' }],
    listModels: () => [{ id: 'gpt-5.5', provider: 'openai', registryKey: 'openai:gpt-5.5' }],
    getConfiguredProviderIds: () => ['openai'],
  };
}

function makeDeps(configManager = makeConfigManager()) {
  return {
    configManager,
    providerRegistry: makeProviderRegistry() as never,
    toolRegistry: new ToolRegistry(),
    workingDirectory: configManager.getWorkingDirectory() ?? '',
    homeDirectory: configManager.getHomeDirectory() ?? '',
    surfaceRoot: 'goodvibes',
  };
}

describe('GoodVibes runtime tools', () => {
  // Values under keys the declared list does not name are read for
  // credential material; none of this block's values reads as one.
  useConfigReadings({});

  test('goodvibes_context returns redacted settings and never raw secrets', async () => {
    const configManager = makeConfigManager();
    configManager.set('surfaces.homeassistant.accessToken', 'goodvibes://secrets/goodvibes/HASS_TOKEN');
    const tool = createGoodVibesContextTool(makeDeps(configManager));

    const result = await tool.execute({
      mode: 'config_get',
      key: 'surfaces.homeassistant.accessToken',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('"redacted": true');
    expect(result.output).not.toContain('HASS_TOKEN');
  });

  test('goodvibes_settings changes normal settings through ConfigManager validation', async () => {
    const configManager = makeConfigManager();
    const tool = createGoodVibesSettingsTool({ configManager });

    const result = await tool.execute({
      mode: 'set',
      key: 'display.theme',
      value: 'midnight',
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(configManager.get('display.theme')).toBe('midnight');
  });

  test('goodvibes_settings refuses raw credential persistence', async () => {
    const configManager = makeConfigManager();
    const tool = createGoodVibesSettingsTool({ configManager });

    const result = await tool.execute({
      mode: 'set',
      key: 'surfaces.slack.botToken',
      value: 'xoxb-raw-token-value',
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Refusing to persist a raw credential');
    expect(configManager.get('surfaces.slack.botToken')).toBe('');
  });

  test('runtime awareness prompt tells models to inspect harness state', () => {
    const prompt = appendGoodVibesRuntimeAwarenessPrompt('Base prompt');
    expect(prompt).toContain('goodvibes_context');
    expect(prompt).toContain('Do not spawn agents or start contracts');
  });
});

describe('what the runtime tools show of a stored value', () => {
  // The value stored under surfaces.ntfy.topic reads as credential material;
  // every other value reads as not one.
  const log = useConfigReadings({ credentials: ['surfaces.ntfy.topic'] });
  const valueReadings = () => log.requests.filter((request) => typeof (request.state as { value?: unknown }).value === 'string');

  test('a value read as credential material is redacted under a key the declared list does not name', async () => {
    const configManager = makeConfigManager();
    configManager.set('surfaces.ntfy.topic', 'tk_live_8Fq2Lm9Xv4Rz7Pw');
    const result = await createGoodVibesContextTool(makeDeps(configManager)).execute({ mode: 'config_get', key: 'surfaces.ntfy.topic' });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain('tk_live_8Fq2Lm9Xv4Rz7Pw');
    expect(result.output).toContain('"source": "credential-like-value"');
    expect(valueReadings().map((request) => (request.state as { key: string }).key)).toContain('surfaces.ntfy.topic');
  });

  test('a value read as not credential material is shown as stored', async () => {
    const configManager = makeConfigManager();
    configManager.set('display.theme', 'midnight');
    const result = await createGoodVibesContextTool(makeDeps(configManager)).execute({ mode: 'config_get', key: 'display.theme' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('"value": "midnight"');
  });

  test('a declared credential key is redacted without reading its value, and a secret reference is never read', async () => {
    const configManager = makeConfigManager();
    configManager.set('surfaces.slack.botToken', 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN');
    const result = await createGoodVibesContextTool(makeDeps(configManager)).execute({ mode: 'config_get', key: 'surfaces.slack.botToken' });

    expect(result.output).toContain('"source": "goodvibes-secret-ref"');
    expect(valueReadings()).toHaveLength(0);
  });

  test('the schema default is not read: it is the same text on every install', async () => {
    const result = await createGoodVibesContextTool(makeDeps()).execute({ mode: 'config_schema', category: 'display' });

    expect(result.success).toBe(true);
    expect(valueReadings()).toHaveLength(0);
  });
});
