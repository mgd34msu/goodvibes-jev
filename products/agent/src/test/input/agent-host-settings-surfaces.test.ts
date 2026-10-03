import { describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { ConfigManager, SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { FocusTracker } from '@goodvibes-jev/engine/sdk/platform/runtime/operations';
import type { PermissionPromptRequest } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { SlackIntegration } from '@goodvibes-jev/engine/sdk/platform/integrations';
import { defaultStore } from '@goodvibes-jev/engine/sdk/platform/runtime/settings';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY as KEY, readAgentHostSetting } from '../../config/host-settings.ts';
import { getHarnessSetting, resetHarnessSetting, setHarnessSetting } from '../../agent/harness-control.ts';
import { agentWorkspaceSettingSchema, applyAgentWorkspaceSettingValue, buildAgentWorkspaceSettingActionEffect, previewAgentWorkspaceTuiSettingsImport, importAgentWorkspaceTuiSettings } from '../../input/agent-workspace-settings.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createEventEnvelope, createFeatureFlagManager, createShellPathService, RuntimeEventBus } from '../../runtime/index.ts';
import { settingContextLines } from '../../renderer/settings-modal-context.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
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
      expect(modal.getSelected()?.setting.key).toBe(KEY);
      expect(modal.getSelected()?.currentValue).toBe(true);
      expect(modal.getSelected()?.isDefault).toBe(true);
      expect(modal.getSelected()?.effectiveSource).toBe('default');
      modal.activateSelected();
      expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
      expect(new AgentConfigManager({ configDir }).getHostBooleanSetting(KEY).get()).toBe(false);
      expect(modal.getSelected()?.currentValue).toBe(false);
      expect(modal.getSelected()?.effectiveSource).toBe('local');
      modal.resetSelected();
      expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
      expect(new AgentConfigManager({ configDir }).getHostBooleanSetting(KEY).get()).toBe(true);
      expect(modal.getSelected()?.effectiveSource).toBe('default');
      expect(modal.groups.get('behavior')?.filter((entry) => entry.setting.key === KEY)).toHaveLength(1);
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
    expect(new AgentConfigManager({ configDir }).getHostBooleanSetting(KEY).get()).toBe(false);
    expect(buildAgentWorkspaceSettingActionEffect(context, action)).toMatchObject({ kind: 'apply', value: true });
  });

  test('modal reset preserves project scope while host harness leaves destination reporting unspecified', async () => {
    const { root, configDir } = fixture();
    const workingDir = join(root, 'project');
    mkdirSync(workingDir);
    const options = { configDir, workingDir, surfaceRoot: 'agent' };
    const config = new AgentConfigManager(options);
    config.getHostBooleanSetting(KEY).set(false);
    config.getHostBooleanSetting(KEY).setProjectValue(false);
    const modal = new SettingsModal();
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
    try {
      modal.selectTarget(KEY);
      expect(modal.getSelected()?.effectiveSource).toBe('local');
      modal.resetSelected();
      expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(true);
      expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
      expect(modal.getSelected()?.effectiveSource).toBe('default');
      modal.activateSelected();
      expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(false);
      expect(modal.getSelected()?.effectiveSource).toBe('local');
      const mutation = await setHarnessSetting(config, null, KEY, true);
      expect(mutation.current).toBe(true);
      expect(Object.hasOwn(mutation, 'persistedTo')).toBe(false);
      expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(true);
      expect(new AgentConfigManager(options).getHostBooleanSetting(KEY).get()).toBe(true);
      await resetHarnessSetting(config, null, KEY);
      expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(true);
      expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(true);
    } finally { modal.close(); }
  });

  test('host row exposes genuine managed-lock metadata and refuses a change', () => {
    const { root, configDir, config } = fixture();
    config.getHostBooleanSetting(KEY).set(false);
    writeFileSync(join(configDir, 'settings-sync.json'), JSON.stringify({ ...defaultStore(), managedLocks: [{ key: KEY, source: 'host-policy', reason: 'managed privacy choice', updatedAt: 1 }] }));
    const modal = new SettingsModal();
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
    try {
      modal.selectTarget(KEY);
      expect(modal.getSelected()).toMatchObject({
        currentValue: false, effectiveSource: 'local', locked: true, lockReason: 'host-policy: managed privacy choice',
      });
      modal.activateSelected();
      expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
      expect(new AgentConfigManager({ configDir }).getHostBooleanSetting(KEY).get()).toBe(false);
    } finally { modal.close(); }
  });

  test('harness exact lookup and guarded boolean writes work only on Agent instances', async () => {
    const { configDir, config } = fixture();
    expect(getHarnessSetting(config, KEY)).toMatchObject({ key: KEY, value: true, default: true });
    expect(getHarnessSetting(new ConfigManager({ configDir }), KEY)).toBeNull();
    expect(await setHarnessSetting(config, null, KEY, false)).toMatchObject({ key: KEY, current: false });
    expect(new AgentConfigManager({ configDir }).getHostBooleanSetting(KEY).get()).toBe(false);
    for (const invalid of ['false', 'off', 0, null, undefined, {}, []]) {
      await expect(setHarnessSetting(config, null, KEY, invalid)).rejects.toThrow('literal boolean');
      expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
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
      configGet: (key) => readAgentHostSetting(config, key),
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
    config.getHostBooleanSetting(KEY).set(false);
    await wrapper(request);
    expect(JSON.stringify(notices.at(-1))).toContain('private task name');
    expect(JSON.stringify(notices.at(-1))).toContain('private-command');
    config.getHostBooleanSetting(KEY).reset();
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
    const notifier = await createRuntimeNotifier(registry as never, (key) => readAgentHostSetting(config, key));
    const bus = new RuntimeEventBus();
    notifier.attachToRuntimeBus(bus);
    try {
      for (const value of [undefined, true, false, true]) {
        if (value !== undefined) config.getHostBooleanSetting(KEY).set(value);
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

test.each(['malformed', 'unreadable'])('actual modal preserves %s policy and disables affected editing without dropping rows', (failure) => {
  const { root, configDir, config } = fixture();
  config.getHostBooleanSetting(KEY).set(false);
  const policyPath = join(configDir, 'settings-sync.json');
  const raw = failure === 'malformed' ? '{invalid policy' : JSON.stringify(defaultStore());
  writeFileSync(policyPath, raw);
  const names = readdirSync(configDir);
  if (failure === 'unreadable') chmodSync(policyPath, 0);
  const modal = new SettingsModal();
  try {
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
    modal.selectTarget(KEY);
    expect(modal.getSelected()).toMatchObject({ currentValue: false, effectiveSource: 'unavailable' });
    expect(modal.getSelected()?.metadataUnavailable).toContain('metadata is unavailable');
    const context = settingContextLines(modal).join('\n');
    expect(context).toContain('Source: unavailable');
    expect(context).toContain('Editing unavailable:');
    expect(context).not.toContain('Locked:');
    expect(() => renderSettingsModal(modal, 80, 24)).not.toThrow();
    modal.activateSelected(); modal.adjustSelected('right');
    expect(modal.resetSelected()).toBeNull();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
    const ordinary = config.get('behavior.autoApprove');
    modal.selectTarget('behavior.autoApprove');
    expect(modal.getSelected()?.currentValue).toBe(ordinary);
    expect(modal.getSelected()?.metadataUnavailable).toContain('metadata is unavailable');
    modal.activateSelected();
    expect(config.get('behavior.autoApprove')).toBe(ordinary);
    expect(readdirSync(configDir)).toEqual(names);
  } finally {
    modal.close();
    if (failure === 'unreadable') chmodSync(policyPath, 0o600);
  }
  expect(readFileSync(policyPath, 'utf8')).toBe(raw);
});

test('a policy failure after open blocks the next edit without recovery writes, and readable recovery restores editing', () => {
  const { root, configDir, config } = fixture();
  config.getHostBooleanSetting(KEY).set(false);
  const modal = new SettingsModal();
  modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
  const policyPath = join(configDir, 'settings-sync.json');
  try {
    writeFileSync(policyPath, '{invalid after open');
    modal.selectTarget('behavior.autoApprove');
    const ordinary = config.get('behavior.autoApprove');
    modal.activateSelected();
    expect(config.get('behavior.autoApprove')).toBe(ordinary);
    expect(readFileSync(policyPath, 'utf8')).toBe('{invalid after open');
    modal.selectTarget(KEY); modal.activateSelected();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
    expect(modal.getSelected()?.effectiveSource).toBe('unavailable');
    const unavailable = getHarnessSetting(config, KEY);
    expect(unavailable).toMatchObject({ value: false, writable: false, valueSource: 'local' });
    expect(unavailable?.metadataUnavailable).toContain('metadata is unavailable');
    writeFileSync(policyPath, JSON.stringify(defaultStore()));
    modal.activateSelected();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(modal.getSelected()?.effectiveSource).toBe('default');
    expect(modal.getSelected()?.metadataUnavailable).toBeUndefined();
  } finally { modal.close(); }
});

test('TUI settings import does not opt into the Agent host preference', async () => {
  const { root, config, configDir } = fixture();
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const sourcePath = shellPaths.resolveUserPath('tui', 'settings.json');
  mkdirSync(join(sourcePath, '..'), { recursive: true });
  const raw = JSON.stringify({ behavior: { notificationsMetadataOnly: false } });
  writeFileSync(sourcePath, raw);
  const context = { platform: { configManager: config }, workspace: { shellPaths } } as unknown as CommandContext;
  const preview = previewAgentWorkspaceTuiSettingsImport(context);
  expect(JSON.stringify(preview)).not.toContain(KEY);
  await importAgentWorkspaceTuiSettings(context);
  expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  expect(new AgentConfigManager({ configDir }).getHostBooleanSetting(KEY).get()).toBe(true);
  expect(readFileSync(sourcePath, 'utf8')).toBe(raw);
});

test.each(['toggle', 'adjust'])('Features %s cannot repair unavailable policy or enable later host editing', (route) => {
  const { root, configDir, config } = fixture();
  config.getHostBooleanSetting(KEY).set(true);
  const policyPath = join(configDir, 'settings-sync.json');
  writeFileSync(policyPath, '{invalid policy');
  const names = readdirSync(configDir);
  const modal = new SettingsModal();
  modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
  const selectFeature = () => {
    modal.selectTarget('flags');
    modal.selectedIndex = modal.flagEntries.findIndex(entry => entry.feature.enablement.kind === 'boolean' && entry.state !== 'killed');
    expect(modal.selectedIndex).toBeGreaterThanOrEqual(0);
    return modal.getSelectedFlag()!;
  };
  const apply = () => route === 'toggle' ? modal.toggleSelectedFlag() : modal.adjustSelected(modal.getSelectedFlag()!.state === 'enabled' ? 'left' : 'right');
  try {
    const entry = selectFeature();
    if (entry.feature.enablement.kind !== 'boolean') throw new Error('Expected a boolean feature fixture');
    const key = entry.feature.enablement.key;
    const before = config.get(key);
    apply();
    expect(config.get(key)).toBe(before);
    expect(modal.lastSettingEffectMessage).toContain('Editing unavailable');
    expect(readFileSync(policyPath, 'utf8')).toBe('{invalid policy');
    expect(readdirSync(configDir)).toEqual(names);
    modal.selectTarget(KEY); modal.activateSelected();
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
    expect(modal.getSelected()?.metadataUnavailable).toBeDefined();
    writeFileSync(policyPath, JSON.stringify(defaultStore()));
    selectFeature(); apply();
    expect(config.get(key)).not.toBe(before);
    expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  } finally { modal.close(); }
});
