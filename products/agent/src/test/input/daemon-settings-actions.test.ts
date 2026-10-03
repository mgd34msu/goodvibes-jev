/**
 * Tests for openDaemonTimezonePicker: a picker over real IANA zone names
 * with an explicit unset option, never a free-text field.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { openDaemonTimezonePicker } from '../../input/daemon-settings-actions.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import type { SelectionItem, SelectionResult } from '../../input/selection-modal.ts';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `gv-daemon-tz-picker-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createConfigManager(root: string): ConfigManager {
  return new ConfigManager({
    surfaceRoot: 'agent',
    workingDir: root,
    homeDir: root,
    configDir: join(root, '.goodvibes', 'global-agent'),
  });
}

/** Captures what openSelection was called with and lets a test drive the callback as if a user picked a row. */
function makeContext(cm: ConfigManager): {
  ctx: CommandContext;
  items: () => SelectionItem[];
  choose: (id: string) => void;
  printed: () => string[];
  rendered: () => number;
} {
  let capturedItems: SelectionItem[] = [];
  let capturedCallback: ((result: SelectionResult | null) => void) | null = null;
  const printedLines: string[] = [];
  let renderCount = 0;

  const ctx = {
    platform: { configManager: cm },
    print: (text: string) => { printedLines.push(text); },
    renderRequest: () => { renderCount += 1; },
    openSelection: (
      _title: string,
      items: SelectionItem[],
      _opts: unknown,
      callback: (result: SelectionResult | null) => void,
    ) => {
      capturedItems = items;
      capturedCallback = callback;
    },
  } as unknown as CommandContext;

  return {
    ctx,
    items: () => capturedItems,
    choose: (id: string) => {
      const item = capturedItems.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`no item with id ${id}`);
      capturedCallback?.({ item, action: 'select' });
    },
    printed: () => printedLines,
    rendered: () => renderCount,
  };
}

describe('openDaemonTimezonePicker', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  let tmpDir: string;
  let cm: ConfigManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    cm = createConfigManager(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('offers UTC (unset) plus every IANA zone Intl recognizes on this host', () => {
    const { ctx, items } = makeContext(cm);
    openDaemonTimezonePicker(ctx);
    const list = items();
    expect(list[0]?.label).toBe('UTC (unset)');
    expect(list.map((item) => item.id)).toContain('America/New_York');
    expect(list.length).toBe(Intl.supportedValuesOf('timeZone').length + 1);
  });

  test('selecting a real IANA zone writes exactly that zone name', () => {
    const { ctx, choose } = makeContext(cm);
    openDaemonTimezonePicker(ctx);
    choose('America/New_York');
    expect(cm.get('daemon.timezone')).toBe('America/New_York');
  });

  test('selecting UTC (unset) writes an empty string', () => {
    cm.setDynamic('daemon.timezone', 'Europe/London');
    const { ctx, choose } = makeContext(cm);
    openDaemonTimezonePicker(ctx);
    choose('__daemon_timezone_utc_unset__');
    expect(cm.get('daemon.timezone')).toBe('');
  });

});
