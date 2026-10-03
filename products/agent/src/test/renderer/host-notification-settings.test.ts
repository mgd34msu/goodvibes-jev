import { test, expect, spyOn } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY as KEY } from '../../config/host-settings.ts';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { createFeatureFlagManager } from '../../runtime/index.ts';
import { SettingsModal } from '../../input/settings-modal.ts';
import { settingContextLines } from '../../renderer/settings-modal-context.ts';
import { renderSettingsModal } from '../../renderer/settings-modal.ts';
import { frameFromLayer, frameText } from '../helpers/surface-frame.ts';
import { encodeGolden } from '../helpers/golden-snapshot.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { setActiveThemeName, setActiveThemeMode, getActiveThemeName, getActiveThemeMode } from '../../renderer/theme.ts';

const PROOF = process.env.GOODVIBES_TEST_HOST_FRAME_PROOF_DIR;
for (const [width, height] of [[80,24],[120,40]] as const) {
  test(`actual Agent host privacy row renders and persists ${width}x${height}`, () => {
    const root=makeProjectTempDir('host-render'); const configDir=join(root,'config');
    const config = new AgentConfigManager({ configDir });
    const modal = new SettingsModal();
    const previousName=getActiveThemeName(); const previousMode=getActiveThemeMode();
    setActiveThemeName('goodvibes'); setActiveThemeMode('dark');
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root,'subscriptions.json')), { getAll:()=>({}) });
    modal.selectTarget(KEY);
    try {
      for (const phase of ['default', 'details', 'reset', 'docs']) {
        if (phase==='details') modal.activateSelected();
        if (phase==='reset') modal.resetSelected();
        if (phase==='docs') modal.scrollContext(3);
        const expected=phase!=='details';
        expect(config.getHostBooleanSetting(KEY).get()).toBe(expected);
        expect(new AgentConfigManager({configDir}).getHostBooleanSetting(KEY).get()).toBe(expected);
        expect(modal.getSelected()?.currentValue).toBe(expected);
        expect(modal.getSelected()?.effectiveSource).toBe(expected ? 'default' : 'local');
        const help=settingContextLines(modal).join('\n');
        expect(help).toContain(`Source: ${expected ? 'default' : 'local'}`);
        expect(help).toContain('true: Keep notifications metadata-only (restrictive default).');
        expect(help).toContain('false: Explicitly permit notification details on supported paths.');
        const layer=renderSettingsModal(modal,width!,height!);
        expect(layer.x).toBeGreaterThanOrEqual(0); expect(layer.y).toBeGreaterThanOrEqual(0);
        expect(layer.x+layer.lines[0]!.length).toBeLessThanOrEqual(width!);
        expect(layer.y+layer.lines.length).toBeLessThanOrEqual(height!);
        const frame=frameFromLayer(layer,width!,height!);
        if (PROOF) writeFileSync(join(PROOF,`host-${width}x${height}-${phase}.txt`),encodeGolden(`Host notification preference ${phase}`,frame));
        if (PROOF) writeFileSync(join(PROOF,`host-${width}x${height}-${phase}.plain.txt`),frameText(frame).join('\n'));
      }
    } finally { modal.close(); setActiveThemeName(previousName); setActiveThemeMode(previousMode); }
  });
}


test('an open host row observes external revocation and releases subscriptions on close/reopen', () => {
  const root=makeProjectTempDir('host-live-render'); const configDir=join(root,'config');
  const config=new AgentConfigManager({configDir});
  config.getHostBooleanSetting(KEY).set(false);
  const modal=new SettingsModal(); let renders=0; let activeListeners=0;
  const getHandle = config.getHostBooleanSetting.bind(config);
  const handles = spyOn(config, 'getHostBooleanSetting').mockImplementation(key => {
    const handle = getHandle(key);
    return Object.freeze({ ...handle, subscribe: (callback: (value: boolean, previous: boolean) => void) => {
      const stop = handle.subscribe(callback); activeListeners++;
      return () => { activeListeners--; stop(); };
    } });
  });
  const open=()=> {
    modal.open(config,createFeatureFlagManager(),new SubscriptionManager(join(root,'subscriptions.json')),{getAll:()=>({})},undefined,undefined,{requestRender:()=>{renders++;}});
    modal.selectTarget(KEY);
  };
  open();
  expect(activeListeners).toBe(1);
  expect(modal.getSelected()?.currentValue).toBe(false);
  // Reopening replaces the listener; one transition must request one repaint.
  open();
  expect(activeListeners).toBe(1);
  writeFileSync(join(configDir,'settings.json'),JSON.stringify({behavior:{notificationsMetadataOnly:true}}));
  config.load();
  expect(config.getHostBooleanSetting(KEY).get()).toBe(true);
  expect(modal.getSelected()?.currentValue).toBe(true);
  expect(modal.getSelected()?.effectiveSource).toBe('default');
  expect(renders).toBe(1);
  modal.close();
  modal.close();
  expect(activeListeners).toBe(0);
  config.getHostBooleanSetting(KEY).set(false);
  expect(renders).toBe(1);
  open();
  expect(activeListeners).toBe(1);
  expect(modal.getSelected()?.currentValue).toBe(false);
  config.getHostBooleanSetting(KEY).reset();
  expect(modal.getSelected()?.currentValue).toBe(true);
  expect(renders).toBe(2);
  modal.close();
  expect(activeListeners).toBe(0);
  handles.mockRestore();
});

test('the actual modal follows file-watch revocation and detaches when its manager is replaced', async () => {
  const root = makeProjectTempDir('host-watch-render');
  const first = new AgentConfigManager({ configDir: join(root, 'first') });
  const second = new AgentConfigManager({ configDir: join(root, 'second') });
  first.getHostBooleanSetting(KEY).set(false);
  const modal = new SettingsModal();
  let renders = 0;
  const open = (config: AgentConfigManager) => {
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) }, undefined, undefined, { requestRender: () => { renders++; } });
    modal.selectTarget(KEY);
  };
  open(first);
  const stop = first.watchConfigFiles({ intervalMs: 5 });
  try {
    writeFileSync(first.getConfigPath(), JSON.stringify({ behavior: { notificationsMetadataOnly: true } }));
    const deadline = Date.now() + 2_000;
    while (modal.getSelected()?.currentValue !== true && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(modal.getSelected()?.currentValue).toBe(true);
    expect(renders).toBe(1);
    open(second);
    first.getHostBooleanSetting(KEY).set(false);
    expect(renders).toBe(1);
    expect(modal.getSelected()?.currentValue).toBe(true);
    second.getHostBooleanSetting(KEY).set(false);
    expect(modal.getSelected()?.currentValue).toBe(false);
    expect(renders).toBe(2);
    modal.close();
    second.getHostBooleanSetting(KEY).set(true);
    expect(renders).toBe(2);
  } finally { stop(); modal.close(); }
});

for (const [width, height] of [[80, 24], [120, 40]] as const) {
  test(`actual Agent unavailable-policy row renders disabled editing ${width}x${height}`, () => {
    const root = makeProjectTempDir('host-unavailable-render');
    const configDir = join(root, 'config');
    const config = new AgentConfigManager({ configDir });
    config.getHostBooleanSetting(KEY).set(false);
    const policyPath = join(configDir, 'settings-sync.json');
    writeFileSync(policyPath, '{invalid policy fixture');
    const modal = new SettingsModal();
    const previousName = getActiveThemeName(); const previousMode = getActiveThemeMode();
    setActiveThemeName('goodvibes'); setActiveThemeMode('dark');
    modal.open(config, createFeatureFlagManager(), new SubscriptionManager(join(root, 'subscriptions.json')), { getAll: () => ({}) });
    modal.selectTarget(KEY);
    try {
      expect(modal.getSelected()?.currentValue).toBe(false);
      expect(modal.getSelected()?.effectiveSource).toBe('unavailable');
      expect(modal.getSelected()?.locked).toBeUndefined();
      modal.activateSelected();
      expect(config.getHostBooleanSetting(KEY).get()).toBe(false);
      expect(modal.lastSettingEffectMessage).toContain('Editing unavailable');
      const layer = renderSettingsModal(modal, width, height);
      const frame = frameFromLayer(layer, width, height);
      const visible = frameText(frame).join('\n');
      expect(visible).toContain('unavailable');
      expect(visible).not.toContain('Locked:');
      expect(layer.x).toBeGreaterThanOrEqual(0); expect(layer.y).toBeGreaterThanOrEqual(0);
      expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(width);
      expect(layer.y + layer.lines.length).toBeLessThanOrEqual(height);
      if (PROOF) writeFileSync(join(PROOF, `host-${width}x${height}-unavailable.txt`), encodeGolden('Host notification preference metadata unavailable', frame));
      if (PROOF) writeFileSync(join(PROOF, `host-${width}x${height}-unavailable.plain.txt`), visible);
    } finally { modal.close(); setActiveThemeName(previousName); setActiveThemeMode(previousMode); }
  });
}
