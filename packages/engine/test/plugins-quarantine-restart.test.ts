/**
 * A plugin quarantine recorded in the plugin state file is still in force
 * after a restart: the manager restores the persisted records into its
 * quarantine engine when it loads state, so the record reads as active and
 * can be lifted.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManager } from '../sdk/src/platform/plugins/manager.ts';
import type { PluginLoaderDeps } from '../sdk/src/platform/plugins/loader.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('plugin quarantine across a restart', () => {
  test('a persisted active quarantine is restored and can be lifted', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gv-plugin-quarantine-'));
    roots.push(base);
    mkdirSync(join(base, 'home'), { recursive: true });
    mkdirSync(join(base, 'project'), { recursive: true });
    const stateFilePath = join(base, 'plugins-state.json');
    writeFileSync(stateFilePath, JSON.stringify({
      enabled: {}, config: {}, trust: {},
      quarantine: {
        'jira-sync': { pluginName: 'jira-sync', quarantinedAt: 1_000, reason: 'exfiltration attempt', revokedCapabilities: ['network'], lifted: false },
      },
    }));

    // A fresh manager is the restarted process; no plugin is discovered, so no loader dependency is touched.
    const manager = new PluginManager({ pathOptions: { cwd: join(base, 'project'), homeDir: join(base, 'home') }, stateFilePath });
    await manager.init({} as PluginLoaderDeps);

    expect(manager.getQuarantineRecord('jira-sync')).toMatchObject({ reason: 'exfiltration attempt', lifted: false });
    expect(manager.liftQuarantine('jira-sync')).toEqual({ ok: true });
    expect(manager.getQuarantineRecord('jira-sync')?.lifted).toBe(true);
  });
});
