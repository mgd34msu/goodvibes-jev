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
    expect(runtime.configManager.getSchema().filter(row => row.key === KEY)).toHaveLength(1);
    expect(runtime.configManager.get(KEY)).toBe(true);
    runtime.configManager.setDynamic(KEY, false);
    expect(new TuiConfigManager({ workingDir: project, homeDir: root, surfaceRoot: 'tui' }).get(KEY)).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
