/**
 * Ported from goodvibes-agent src/test/tools/agent-settings-write-policy.test.ts.
 *
 * The Agent used to hard-deny `goodvibes_settings` outright. The owner asked it
 * to set his Telegram bot username; between that denial and the model treating a
 * stated value as trivia, nothing was written and he spent hours believing his
 * system was configured.
 *
 * What must hold now:
 *   - an ordinary setting goes through;
 *   - a write Jev reads as a hazard (approval gate, exec containment, host
 *     exposure) asks first, and the refusal says which key and why;
 *   - the user's words let it through only when Jev reads them as asking for
 *     this change;
 *   - no refusal is ever silent, and no refusal is ever dressed as a success.
 * Readings come from a fake port (gate-readings.ts); the battery itself is
 * calibrated live (engine.gate.settings-hazard).
 */

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

describe('a write Jev reads as a hazard asks first, and explains itself', () => {
  test('turning off the approval gate is refused with the key and the reason', async () => {
    const { tool, calls } = guardedSettingsTool();
    const result = await tool.execute({
      mode: 'set',
      key: 'behavior.autoApprove',
      value: true,
      confirm: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('behavior.autoApprove');
    expect(result.error).toContain('requires your confirmation because');
    expect(result.error).toContain('changes which actions run without asking you');
    expect(result.error).toContain('was NOT changed');
    expect(result.error).toContain(AGENT_SETTINGS_CONFIRMATION_PROPERTY);
    // The refusal must also say the rest of the surface is open, so it does not
    // read as "settings are blocked" all over again.
    expect(result.error).toContain('Every other setting can be applied');

    // Nothing reached the real tool.
    expect(calls).toEqual([]);
  });

  test('the user asking for it lets it through', async () => {
    const { tool, calls } = guardedSettingsTool();
    const result = await tool.execute({
      mode: 'set',
      key: 'behavior.autoApprove',
      value: true,
      confirm: true,
      [AGENT_SETTINGS_CONFIRMATION_PROPERTY]: 'turn on auto approve, I do not want to be asked',
    });

    expect(result.success).toBe(true);
    expect(calls).toEqual([{ key: 'behavior.autoApprove', value: true }]);
  });

  test('an empty, non-text or unrelated request does not satisfy the gate', async () => {
    for (const request of ['', '   ', undefined, null, true, 42, 'set my telegram bot username']) {
      const denial = await validateSettingsToolInvocationForAgentPolicy({
        mode: 'set',
        key: 'sandbox.enabled',
        value: false,
        [AGENT_SETTINGS_CONFIRMATION_PROPERTY]: request,
      });
      expect(denial).toContain('sandbox.enabled');
    }
  });

  test('each hazard class names its own reason', async () => {
    const cases: Array<[string, string, string]> = [
      ['permissions.mode', 'approval-gate', 'changes which actions run without asking you'],
      ['sandbox.enabled', 'exec-containment', 'changes the sandbox that contains commands'],
      ['controlPlane.hostMode', 'host-exposure', 'exposed to the network'],
    ];
    for (const [key, hazard, reason] of cases) {
      const { tool, calls } = guardedSettingsTool();
      const result = await tool.execute({ mode: 'set', key, value: 'x', confirm: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain(key);
      expect(result.error).toContain(reason);
      expect(result.error).toContain(`hazard class: ${hazard}`);
      expect(calls).toEqual([]);
    }
  });
});

describe('no denial is ever silent', () => {
  test('a refused write returns an explanatory error and never a success', async () => {
    const { tool } = guardedSettingsTool();
    const result = await tool.execute({ mode: 'set', key: 'behavior.autoApprove', value: true, confirm: true });

    // The failure this whole change exists to remove: a call that looks like it
    // worked, or one that fails with nothing the user can act on.
    expect(result.success).toBe(false);
    expect(result.output).toBeUndefined();
    expect(typeof result.error).toBe('string');
    expect((result.error ?? '').length).toBeGreaterThan(80);
  });

  test('the policy explanation reports the same reason the caller would get', async () => {
    const denied = await explainAgentToolPolicyInvocation('goodvibes_settings', {
      mode: 'set',
      key: 'behavior.autoApprove',
      value: true,
    });
    expect(denied.status).toBe('denied');
    expect(denied.reason).toContain('behavior.autoApprove');
    expect(denied.reason).toContain('requires your confirmation because');

    const allowed = await explainAgentToolPolicyInvocation('goodvibes_settings', {
      mode: 'set',
      key: 'surfaces.telegram.botUsername',
      value: 'goodvibes_agent_bot',
    });
    expect(allowed.status).toBe('allowed');
  });

  test('a guarded registry surfaces the denial through execute()', async () => {
    const registry = new ToolRegistry();
    const calls: SettingsCall[] = [];
    const tool = makeSettingsTool(calls);
    wrapSettingsToolForAgentPolicy(tool);
    registry.register(tool);

    const result = await registry.execute('call-1', 'goodvibes_settings', {
      mode: 'set',
      key: 'sandbox.enabled',
      value: false,
      confirm: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('sandbox.enabled');
    expect(calls).toEqual([]);
  });
});

describe('what is never asked about', () => {
  test('unkeyed calls are never gated and never read', async () => {
    expect(await validateSettingsToolInvocationForAgentPolicy({ mode: 'reset' })).toBeNull();
    expect(await validateSettingsToolInvocationForAgentPolicy({})).toBeNull();
    expect(await validateSettingsToolInvocationForAgentPolicy({ mode: 'set', key: '   ' })).toBeNull();
  });
});
