/** Agent settings execute without a redundant Jev permission question. */
import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';
import {
  AGENT_SETTINGS_CONFIRMATION_PROPERTY,
  AGENT_SETTINGS_TOOL_DESCRIPTION,
  validateSettingsToolInvocationForAgentPolicy,
  wrapSettingsToolForAgentPolicy,
} from '../sdk/src/platform/gate/policy/settings-write-policy.ts';
import { explainAgentToolPolicyInvocation } from '../sdk/src/platform/gate/policy/tool-policy-guard.ts';

useGateReadings([
  ['turn on auto approve', { hazard: 'approval-gate', requested: true }],
  ['"behavior.autoApprove"', { hazard: 'approval-gate' }],
  ['"permissions.', { hazard: 'approval-gate' }],
  ['"sandbox.', { hazard: 'exec-containment' }],
  ['"controlPlane.', { hazard: 'host-exposure' }],
  ['"fetch.trustedHosts"', { hazard: 'host-exposure' }],
]);

interface SettingsCall {
  readonly key: unknown;
  readonly value: unknown;
}

function makeSettingsTool(calls: SettingsCall[]): Tool {
  return {
    definition: {
      name: 'goodvibes_settings',
      description: 'original settings tool description',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['set', 'reset'] },
          key: { type: 'string' },
          value: {},
          confirm: { type: 'boolean' },
        },
        required: ['mode', 'key', 'confirm'],
        additionalProperties: false,
      },
      sideEffects: ['state'],
    },
    execute: async (args) => {
      const record = args as { key?: unknown; value?: unknown };
      calls.push({ key: record.key, value: record.value });
      return { success: true, output: JSON.stringify({ key: record.key, persistedTo: '/daemon/settings.json' }) };
    },
  };
}

function guardedSettingsTool(): { tool: Tool; calls: SettingsCall[] } {
  const calls: SettingsCall[] = [];
  const tool = makeSettingsTool(calls);
  wrapSettingsToolForAgentPolicy(tool);
  return { tool, calls };
}

describe('the Agent can set ordinary settings', () => {
  test('a stated Telegram bot username reaches the underlying tool', async () => {
    const { tool, calls } = guardedSettingsTool();
    const result = await tool.execute({
      mode: 'set',
      key: 'surfaces.telegram.botUsername',
      value: 'goodvibes_agent_bot',
      confirm: true,
    });

    expect(result.success).toBe(true);
    expect(calls).toEqual([{ key: 'surfaces.telegram.botUsername', value: 'goodvibes_agent_bot' }]);
  });

  test('ordinary keys Jev reads as no hazard are not gated', async () => {
    for (const key of [
      'surfaces.telegram.botUsername',
      'surfaces.telegram.defaultChatId',
      'surfaces.telegram.enabled',
      'surfaces.slack.enabled',
      'provider.model',
      'display.theme',
      'tts.voice',
      'watchers.triggers.enabled',
      'device.grants.expiryDays',
    ]) {
      expect(await validateSettingsToolInvocationForAgentPolicy({ mode: 'set', key, value: 'x' })).toBeNull();
    }
  });

  test('the guard leaves the tool usable instead of emptying its schema', () => {
    const { tool } = guardedSettingsTool();
    const properties = tool.definition.parameters.properties as Record<string, unknown>;

    // The previous guard replaced the whole parameter object with `{}`, which
    // left the model unable to see that a settings write was even possible.
    expect(properties.mode).toBeDefined();
    expect(properties.key).toBeDefined();
    expect(properties.value).toBeDefined();
    expect(properties.confirm).toBeDefined();
    expect(properties[AGENT_SETTINGS_CONFIRMATION_PROPERTY]).toBeDefined();
    expect(tool.definition.sideEffects).toEqual(['state']);
    expect(tool.definition.description).toBe(AGENT_SETTINGS_TOOL_DESCRIPTION);
    expect(tool.definition.description).not.toContain('Blocked');
  });
});

describe('settings use tool permissions without a second Jev approval', () => {
  test('settings changes reach the tool without fabricated explicitUserRequest text', async () => {
    for (const key of ['behavior.autoApprove', 'sandbox.enabled', 'controlPlane.hostMode']) {
      const { tool, calls } = guardedSettingsTool();
      expect((await tool.execute({ mode: 'set', key, value: true, confirm: true })).success).toBe(true);
      expect(calls).toEqual([{ key, value: true }]);
      expect((await explainAgentToolPolicyInvocation('goodvibes_settings', { mode: 'set', key, value: true })).status).toBe('allowed');
    }
  });
  test('the registry executes settings under the same policy', async () => {
    const registry = new ToolRegistry(); const calls: SettingsCall[] = [];
    const tool = makeSettingsTool(calls); wrapSettingsToolForAgentPolicy(tool); registry.register(tool);
    expect((await registry.execute('set', 'goodvibes_settings', { mode: 'set', key: 'sandbox.enabled', value: false, confirm: true })).success).toBe(true);
    expect(calls).toEqual([{ key: 'sandbox.enabled', value: false }]);
  });
});

describe('what is never asked about', () => {
  test('unkeyed calls are never gated and never read', async () => {
    expect(await validateSettingsToolInvocationForAgentPolicy({ mode: 'reset' })).toBeNull();
    expect(await validateSettingsToolInvocationForAgentPolicy({})).toBeNull();
    expect(await validateSettingsToolInvocationForAgentPolicy({ mode: 'set', key: '   ' })).toBeNull();
  });
});
