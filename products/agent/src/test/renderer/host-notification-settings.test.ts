import { test, expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY as KEY } from '../../config/host-settings.ts';
import { SubscriptionManager, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
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
        expect(config.get(KEY)).toBe(expected);
        expect(new AgentConfigManager({configDir}).get(KEY)).toBe(expected);
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
  config.set(KEY,false);
  const modal=new SettingsModal(); let renders=0; let activeListeners=0;
  const subscribe=config.subscribe as unknown as (key: ConfigKey, callback: (value: unknown, previous: unknown) => void) => () => void;
  Object.defineProperty(config,'subscribe',{configurable:true,value:(key: ConfigKey, callback: (value: unknown, previous: unknown) => void) => {
    const stop=subscribe.call(config,key,callback); activeListeners++;
    return ()=>{activeListeners--;stop();};
  }});
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
  expect(config.get(KEY)).toBe(true);
  expect(modal.getSelected()?.currentValue).toBe(true);
  expect(modal.getSelected()?.effectiveSource).toBe('default');
  expect(renders).toBe(1);
  modal.close();
  modal.close();
  expect(activeListeners).toBe(0);
  config.set(KEY,false);
  expect(renders).toBe(1);
  open();
  expect(activeListeners).toBe(1);
  expect(modal.getSelected()?.currentValue).toBe(false);
  config.reset(KEY);
  expect(modal.getSelected()?.currentValue).toBe(true);
  expect(renders).toBe(2);
  modal.close();
  expect(activeListeners).toBe(0);
  Reflect.deleteProperty(config,'subscribe');
});
