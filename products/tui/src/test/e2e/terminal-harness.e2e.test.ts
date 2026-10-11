/** Real native PTY ownership: current screen, immutable raw history and awaited reap. */
import { expect, test } from 'bun:test';
import { inputAreaVisible, launchTui, makeHome, startStubModel } from './harness.ts';

test('the compiled terminal keeps current screen separate from raw history and awaits idempotent shutdown', async () => {
  const model = startStubModel(() => ({ text: 'Unexpected model request' }));
  const home = await makeHome(model);
  const tui = launchTui(home, { cols: 100, rows: 30 });
  try {
    await tui.waitForScreen('the live composer', inputAreaVisible);
    expect(tui.alive()).toBe(true);
    const beforeResize = tui.rawOutput().length;
    tui.resize(120, 36);
    await tui.waitForScreen('the resized composer', screen => inputAreaVisible(screen) && tui.rawOutput().length > beforeResize);
    expect(tui.screen().split('\n')).toHaveLength(36);
    expect(tui.rawOutput()).toContain('\x1b[');
    const marker = 'owned unsent PTY echo';
    tui.type(marker);
    await tui.waitForScreen('real input echo', screen => screen.includes(marker));
    const echoed = tui.rawOutput();
    tui.key('C-u');
    await tui.waitForScreen('cleared current input', screen => inputAreaVisible(screen) && !screen.includes(marker));
    expect(tui.rawOutput().startsWith(echoed)).toBe(true);
    expect(tui.rawOutput().length).toBeGreaterThan(echoed.length);
    expect(model.requests).toHaveLength(0);
    await tui.stop();
    expect(tui.alive()).toBe(false);
    await tui.stop();
    expect(tui.alive()).toBe(false);
  } finally { try { await tui.stop(); } finally { model.stop(); } }
}, 60_000);
