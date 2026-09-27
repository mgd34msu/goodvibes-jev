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
 *   - the short list of genuinely dangerous keys asks first, and the refusal
 *     says which key and why;
 *   - no refusal is ever silent, and no refusal is ever dressed as a success;
 *   - the gate stays narrow, it must not creep back into a blanket denial.
 */

import { describe, expect, test } from 'bun:test';
import { CONFIG_SCHEMA } from '../sdk/src/platform/config/schema.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';
import {
  AGENT_CONFIRMATION_REQUIRED_CONFIG_KEYS,
  AGENT_SETTINGS_CONFIRMATION_PROPERTY,
  AGENT_SETTINGS_TOOL_DESCRIPTION,
  findConfirmationRequiredConfigKey,
  validateSettingsToolInvocationForAgentPolicy,
  wrapSettingsToolForAgentPolicy,
} from '../sdk/src/platform/gate/policy/settings-write-policy.ts';
import { explainAgentToolPolicyInvocation } from '../sdk/src/platform/gate/policy/tool-policy-guard.ts';

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

  test('ordinary keys across the schema are not gated', () => {
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
      expect(findConfirmationRequiredConfigKey(key)).toBeNull();
      expect(validateSettingsToolInvocationForAgentPolicy({ mode: 'set', key, value: 'x' })).toBeNull();
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

describe('a genuinely dangerous key asks first, and explains itself', () => {
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
    expect(result.error).toContain('auto-approves every future tool permission request');
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

  test('an empty or whitespace confirmation does not satisfy the gate', () => {
    for (const request of ['', '   ', undefined, null, true, 42]) {
      const denial = validateSettingsToolInvocationForAgentPolicy({
        mode: 'set',
        key: 'sandbox.enabled',
        value: false,
        [AGENT_SETTINGS_CONFIRMATION_PROPERTY]: request,
      });
      expect(denial).toContain('sandbox.enabled');
    }
  });

  test('each hazard class is covered and each denial names its own reason', async () => {
    const cases: Array<[string, string]> = [
      ['permissions.mode', 'which tool classes run without asking you'],
      ['permissions.tools.exec', 'grants or revokes a tool class'],
      ['sandbox.enabled', 'controls the sandbox that contains commands'],
      ['sandbox.judgment', 'controls the sandbox that contains commands'],
      ['controlPlane.hostMode', 'network binding of the control plane'],
      ['httpListener.host', 'network binding of the inbound HTTP listener'],
      ['web.host', 'which interface the web surface binds to'],
      ['danger.httpListener', 'opens an inbound webhook listener'],
      ['fetch.trustedHosts', 'relax response sanitization'],
      ['network.remoteFetch.allowPrivateHosts', 'private, localhost, and cloud metadata addresses'],
    ];

    for (const [key, reason] of cases) {
      const { tool, calls } = guardedSettingsTool();
      const result = await tool.execute({ mode: 'set', key, value: 'x', confirm: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain(key);
      expect(result.error).toContain(reason);
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

  test('the policy explanation reports the same reason the caller would get', () => {
    const denied = explainAgentToolPolicyInvocation('goodvibes_settings', {
      mode: 'set',
      key: 'behavior.autoApprove',
      value: true,
    });
    expect(denied.status).toBe('denied');
    expect(denied.reason).toContain('behavior.autoApprove');
    expect(denied.reason).toContain('requires your confirmation because');

    const allowed = explainAgentToolPolicyInvocation('goodvibes_settings', {
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

describe('the gate stays narrow', () => {
  test('it is a short enumerated list, not a general policy', () => {
    // Modelled on the frozen catastrophic exec list. Growing this materially is
    // a decision, not a maintenance detail, see the exec-guard precedent.
    expect(AGENT_CONFIRMATION_REQUIRED_CONFIG_KEYS.length).toBeLessThanOrEqual(16);
    for (const entry of AGENT_CONFIRMATION_REQUIRED_CONFIG_KEYS) {
      expect(entry.because.length).toBeGreaterThan(20);
      expect(['approval-gate', 'exec-containment', 'host-exposure']).toContain(entry.hazard);
    }
  });

  test('every hazard class is represented', () => {
    const classes = new Set(AGENT_CONFIRMATION_REQUIRED_CONFIG_KEYS.map((entry) => entry.hazard));
    expect([...classes].sort()).toEqual(['approval-gate', 'exec-containment', 'host-exposure']);
  });

  test('reads and unkeyed calls are never gated', () => {
    expect(validateSettingsToolInvocationForAgentPolicy({ mode: 'reset' })).toBeNull();
    expect(validateSettingsToolInvocationForAgentPolicy({})).toBeNull();
    expect(validateSettingsToolInvocationForAgentPolicy({ mode: 'set', key: '   ' })).toBeNull();
  });

  test('every danger.* key is gated here, because none of them are hidden any more', () => {
    // danger.* used to be hidden from the settings modal outright. Hiding is a
    // worse answer than gating, there is no visible thing to confirm, so the
    // prefix was un-hidden. That trade only holds while the narrow gate covers
    // every danger.* key: visible AND ungated is the one combination that would
    // let an unattended write open this machine up with nothing asked.
    const dangerKeys = CONFIG_SCHEMA
      .map((setting) => setting.key)
      .filter((key) => key.startsWith('danger.'));

    expect(dangerKeys.length).toBeGreaterThan(0);
    for (const key of dangerKeys) {
      const entry = findConfirmationRequiredConfigKey(key);
      expect(entry, `${key} is visible in settings but has no confirmation gate`).not.toBeNull();
      expect(entry!.hazard).toBe('host-exposure');
    }
  });

  test('the credential protection is left to the value check, not duplicated as a key gate', () => {
    // The original guard's stated concern included secrets. That half still runs
    // in the SDK tool, which refuses a raw credential value and names the
    // goodvibes:// reference instead, so token keys are not gated here.
    expect(findConfirmationRequiredConfigKey('surfaces.telegram.botToken')).toBeNull();
    expect(findConfirmationRequiredConfigKey('surfaces.slack.appToken')).toBeNull();
  });
});
