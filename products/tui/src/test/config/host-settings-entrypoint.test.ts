import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareShellCliRuntime } from '../../cli/entrypoint.ts';
import { TuiConfigManager, TUI_NOTIFICATIONS_METADATA_ONLY_KEY as KEY } from '../../config/host-settings.ts';

test('real TUI entrypoint constructs the registered host manager', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-host-entrypoint-'));
  const project = join(root, 'project'); mkdirSync(project);
  const originalFetch = globalThis.fetch;
  try {
    const runtime = await prepareShellCliRuntime(['tui'], { defaultWorkingDirectory: project, homeDirectory: root });
    expect(runtime.configManager).toBeInstanceOf(TuiConfigManager);
    expect(runtime.configManager.getHostSettingsSchema().filter(row => row.key === KEY)).toHaveLength(1);
    expect(runtime.configManager.getHostBooleanSetting(KEY).get()).toBe(true);
    runtime.configManager.getHostBooleanSetting(KEY).set(false);
    expect(new TuiConfigManager({ workingDir: project, homeDir: root, surfaceRoot: 'tui' }).getHostBooleanSetting(KEY).get()).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
