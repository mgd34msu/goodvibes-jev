import { test, expect } from 'bun:test';
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

