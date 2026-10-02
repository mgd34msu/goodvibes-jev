import { describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ConfigManager, SubscriptionManager, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { FocusTracker } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { SlackIntegration } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { setManagedSettingLock } from '@goodvibes-jev/engine/sdk/platform/runtime/settings';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY as KEY } from '../../config/host-settings.ts';
import { getHarnessSetting, resetHarnessSetting, setHarnessSetting } from '../../agent/harness-control.ts';
import { agentWorkspaceSettingSchema, applyAgentWorkspaceSettingValue, buildAgentWorkspaceSettingActionEffect } from '../../input/agent-workspace-settings.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createEventEnvelope, createFeatureFlagManager, RuntimeEventBus } from '../../runtime/index.ts';
import { createRuntimeNotifier } from '../../runtime/bootstrap-notifier.ts';
import { wrapRequestPermissionWithApprovalAlert } from '../../shell/terminal-focus-mode.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const root = makeProjectTempDir('agent-host-setting-surfaces');
  const configDir = join(root, 'config');
  return { root, configDir, config: new AgentConfigManager({ configDir }) };
}

describe('Agent host notification setting through actual settings surfaces', () => {
  test('modal uses the instance schema and toggles and resets the persisted setting', () => {
    const { root, configDir, config } = fixture();
    const modal = new SettingsModal();
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
    try {
      modal.selectTarget(KEY);
      expect(String(modal.getSelected()?.setting.key)).toBe(KEY);
      expect(modal.getSelected()?.currentValue).toBe(true);
      expect(modal.getSelected()?.isDefault).toBe(true);
      expect(modal.getSelected()?.effectiveSource).toBe('default');
      modal.activateSelected();
      expect(config.get(KEY)).toBe(false);
      expect(new AgentConfigManager({ configDir }).get(KEY)).toBe(false);
      expect(modal.getSelected()?.currentValue).toBe(false);
      expect(modal.getSelected()?.effectiveSource).toBe('local');
      modal.resetSelected();
      expect(config.get(KEY)).toBe(true);
      expect(new AgentConfigManager({ configDir }).get(KEY)).toBe(true);
      expect(modal.getSelected()?.effectiveSource).toBe('default');
      expect(modal.groups.get('behavior')?.filter((entry) => String(entry.setting.key) === KEY)).toHaveLength(1);
    } finally { modal.close(); }
  });

  test('workspace resolves its visible toggle against the real instance and applies it through harness persistence', async () => {
    const { configDir, config } = fixture();
    const context = { platform: { configManager: config } } as unknown as CommandContext;
    const action = AGENT_WORKSPACE_CATEGORIES.flatMap((category) => category.actions).find((candidate) => candidate.settingKey === KEY)!;
    const setting = agentWorkspaceSettingSchema(context, KEY);
    expect(setting).not.toBeNull();
    expect(buildAgentWorkspaceSettingActionEffect(context, action)).toMatchObject({ kind: 'apply', value: false });
    const applied = await applyAgentWorkspaceSettingValue(context, setting!, false);
    expect(applied.result.kind).toBe('refreshed');
    expect(new AgentConfigManager({ configDir }).get(KEY)).toBe(false);
    expect(buildAgentWorkspaceSettingActionEffect(context, action)).toMatchObject({ kind: 'apply', value: true });
  });

  test('modal toggles and reset preserve restrictive project preference after reload; harness names that store', async () => {
    const { root, configDir } = fixture();
    const workingDir = join(root, 'project');
    mkdirSync(workingDir);
    const options = { configDir, workingDir, surfaceRoot: 'agent' };
    const config = new AgentConfigManager(options);
    config.setProjectValue(KEY, false);
    const modal = new SettingsModal();
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
    try {
      modal.selectTarget(KEY);
      expect(modal.getSelected()?.effectiveSource).toBe('local');
      modal.resetSelected();
      expect(new AgentConfigManager(options).get(KEY)).toBe(true);
      expect(modal.getSelected()?.effectiveSource).toBe('default');
      modal.activateSelected();
      expect(new AgentConfigManager(options).get(KEY)).toBe(false);
      expect(modal.getSelected()?.effectiveSource).toBe('local');
      expect(await setHarnessSetting(config, null, KEY, true)).toMatchObject({
        current: true, persistedTo: config.getProjectConfigPath(),
      });
      expect(new AgentConfigManager(options).get(KEY)).toBe(true);
    } finally { modal.close(); }
  });

  test('host row exposes genuine managed-lock metadata and refuses a change', () => {
    const { root, configDir, config } = fixture();
    config.set(KEY, false);
    setManagedSettingLock(KEY, 'host-policy', 'managed privacy choice', configDir);
    const modal = new SettingsModal();
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
    try {
      modal.selectTarget(KEY);
      expect(modal.getSelected()).toMatchObject({
        currentValue: false, effectiveSource: 'local', locked: true, lockReason: 'host-policy: managed privacy choice',
      });
      modal.activateSelected();
      expect(config.get(KEY)).toBe(false);
      expect(new AgentConfigManager({ configDir }).get(KEY)).toBe(false);
    } finally { modal.close(); }
  });

  test('harness exact lookup and guarded boolean writes work only on Agent instances', async () => {
    const { configDir, config } = fixture();
    expect(getHarnessSetting(config, KEY)).toMatchObject({ key: KEY, value: true, default: true });
    expect(getHarnessSetting(new ConfigManager({ configDir }), KEY)).toBeNull();
    expect(await setHarnessSetting(config, null, KEY, false)).toMatchObject({ key: KEY, current: false });
    expect(new AgentConfigManager({ configDir }).get(KEY)).toBe(false);
    for (const invalid of ['false', 'off', 0, null, undefined, {}, []]) {
      await expect(setHarnessSetting(config, null, KEY, invalid)).rejects.toThrow('literal boolean');
      expect(config.get(KEY)).toBe(false);
    }
    expect(await resetHarnessSetting(config, null, KEY)).toMatchObject({ key: KEY, current: true });
    // Ordinary SDK keys retain the harness's existing string coercion.
    expect(await setHarnessSetting(config, null, 'behavior.autoApprove', 'false')).toMatchObject({ current: false });
  });

  test('real config drives a fake approval sink live and reset revokes supported details', async () => {
    const { config } = fixture();
    const notices: { title: string; body: string }[] = [];
    const wrapper = wrapRequestPermissionWithApprovalAlert(async () => ({ approved: true, remember: false }), {
      focusTracker: new FocusTracker(),
      configGet: (key) => config.get(key as ConfigKey),
      notify: (title, body) => { notices.push({ title, body }); },
      conversation: {
        title: 'private task name',
        getTitleSource: () => 'user',
        getLastUserMessage: () => 'private task request',
      },
    });
    const request = {
      callId: 'host-privacy-test', tool: 'exec', category: 'execute',
      args: { commands: [{ cmd: 'echo private-command' }] }, analysis: {},
    } as unknown as PermissionPromptRequest;
    await wrapper(request);
    expect(JSON.stringify(notices.at(-1))).not.toContain('private');
    config.set(KEY, false);
    await wrapper(request);
    expect(JSON.stringify(notices.at(-1))).toContain('private task name');
    expect(JSON.stringify(notices.at(-1))).toContain('private-command');
    config.reset(KEY);
    await wrapper(request);
    expect(JSON.stringify(notices.at(-1))).not.toContain('private');
    expect(notices).toHaveLength(3);
  });

  test('runtime-bus fake sink follows current SDK literal-false admission and live revocation', async () => {
    const { config } = fixture();
    const sent: string[] = [];
    const sink = spyOn(SlackIntegration.prototype, 'postWebhook').mockImplementation(async (text: string) => { sent.push(text); });
    const registry = { resolveSecret: async (service: string, key: string) => (
      service === 'slack' && key === 'webhookUrl' ? 'https://hooks.slack.example/fake-sink' : null
    ) };
    const notifier = await createRuntimeNotifier(registry as never, (key) => config.get(key as ConfigKey));
    const bus = new RuntimeEventBus();
    notifier.attachToRuntimeBus(bus);
    try {
      for (const value of [undefined, true, false, true]) {
        if (value !== undefined) config.set(KEY, value);
        bus.emit('contracts', createEventEnvelope('CONTRACT_FAILED', {
          type: 'CONTRACT_FAILED', contractId: 'private-contract', reason: 'private failure reason',
          failureKind: 'other', membersSettled: true,
        }, { sessionId: 'host-setting-test', traceId: 'test', source: 'test' }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sent).toEqual([
        'GoodVibes: notification available',
        'GoodVibes: notification available',
        'The workstream could not be finished: private failure reason',
        'GoodVibes: notification available',
      ]);
    } finally {
      notifier.detach();
      await notifier.close();
      sink.mockRestore();
    }
  });
});
