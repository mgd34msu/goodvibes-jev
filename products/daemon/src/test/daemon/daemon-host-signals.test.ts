import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function hostChild(mode: string) {
  const root = makeOwnedTempDir('daemon-host-signal');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../helpers/daemon-host-child.ts', import.meta.url)), mode, root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg'), NO_COLOR: '1' },
  });
  let stdout = '';
  let stderr = '';
  let exited = false;
  const updates = new EventEmitter();
  child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); updates.emit('change'); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { exited = true; updates.emit('change'); resolve({ code, signal }); });
  });
  const lines = () => stdout.split('\n');
  async function waitFor(line: string): Promise<void> {
    if (lines().includes(line)) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Host did not reach ${line}: ${stdout}\n${stderr}`)); }, 12_000);
      const check = () => {
        if (lines().includes(line)) { cleanup(); resolve(); }
        else if (exited) { cleanup(); reject(new Error(`Host exited before ${line}: ${stdout}\n${stderr}`)); }
      };
      const cleanup = () => { clearTimeout(timeout); updates.off('change', check); };
      updates.on('change', check);
      check();
    });
  }
  return {
    root, child, done, lines, waitFor,
    output: () => ({ stdout, stderr, exited }),
    release: (phase: 'phase' | 'graph') => { child.stdin.write(`release-${phase}\n`); },
    checkpoint: () => { child.stdin.write('check-phase\n'); },
    async cleanup() { if (!exited) child.kill('SIGKILL'); await done; },
  };
}

for (const phase of ['runtime', 'server', 'notifier', 'plugin']) {
  test(`real host SIGTERM during held ${phase} preserves dependencies until graph drainage`, async () => {
    const fx = hostChild(phase);
    try {
      await fx.waitFor('HELD');
      expect(fx.child.kill('SIGTERM')).toBe(true);
      await fx.waitFor('CLOSING');
      expect(fx.child.kill('SIGTERM')).toBe(true);
      if (phase === 'plugin') {
        await fx.waitFor('PLUGIN_REFUSED');
        expect(fx.lines()).toContain('PLUGIN_STATE:closing');
        expect(fx.lines()).not.toContain('PLUGIN_ADMITTED_AFTER_CLOSE');
      }
      fx.checkpoint();
      await fx.waitFor('PHASE_CHECKED');
      expect(fx.lines()).toContain('PHASE_GRAPH_CLOSES:0');
      expect(fx.output().exited).toBe(false);
      expect(fx.lines()).not.toContain('GRAPH_CLOSING');
      fx.release('phase');
      await fx.waitFor('GRAPH_CLOSING');
      if (phase === 'plugin') expect(fx.lines()).toContain('PLUGIN_SETTLED');
      await setImmediate();
      expect(fx.output().exited).toBe(false);
      expect(fx.lines()).not.toContain('GRAPH_CLOSED');
      fx.release('graph');
      expect(await fx.done).toEqual({ code: 0, signal: null });
      expect(fx.lines()).toContain('GRAPH_CLOSED');
      expect(fx.lines()).toContain('EXIT:0:0:0');
      expect(fx.lines().filter((line) => line === 'CLOSING')).toHaveLength(1);
      const bootStarts = phase === 'runtime' || phase === 'server' ? 0 : 1;
      const serverCreates = phase === 'runtime' ? 0 : 1;
      expect(fx.lines()).toContain(`COUNTS:${bootStarts}:${serverCreates}:0:1:1`);
      expect(fx.output().stderr).not.toContain('Daemon startup failed');
      expect(fx.lines()).not.toContain('FIXTURE_FAILURE');
      if (phase === 'plugin') {
        const preferences = JSON.parse(readFileSync(join(fx.root, 'home', '.goodvibes', 'tui', 'plugins.json'), 'utf8'));
        expect(preferences.enabled['signal-owned']).toBe(true);
      }
    } finally { await fx.cleanup(); }
  }, 20_000);
}

test('real host startup failure starts a bounded graph drain and timeout exits nonzero', async () => {
  const fx = hostChild('startup-timeout');
  try {
    await fx.waitFor('GRAPH_CLOSING');
    expect(fx.lines()).not.toContain('GRAPH_CLOSED');
    expect(await fx.done).toEqual({ code: 1, signal: null });
    expect(fx.lines()).toContain('EXIT:1:0:0');
    expect(fx.lines()).toContain('COUNTS:0:1:0:1:1');
    expect(fx.output().stderr).toContain('Daemon startup failed');
    expect(fx.output().stderr).toContain('Daemon shutdown deadline exceeded');
    expect(fx.output().stderr).not.toContain('PRIVATE_HOST_STARTUP_SENTINEL');
    expect(fx.output().stderr).not.toContain('daemon-host-child');
  } finally { await fx.cleanup(); }
}, 20_000);

for (const phase of ['sibling', 'rollback']) {
  test(`actual failed server retains held ${phase} until signal deadline without closing graph`, async () => {
    const fx = hostChild(`${phase}-timeout`);
    try {
      await fx.waitFor('HELD');
      await fx.waitFor('CLOSING');
      expect(fx.child.kill('SIGTERM')).toBe(true);
      expect(await fx.done).toEqual({ code: 1, signal: null });
      expect(fx.lines()).not.toContain('GRAPH_CLOSING');
      expect(fx.lines()).not.toContain('GRAPH_CLOSED');
      expect(fx.lines()).toContain('COUNTS:0:1:0:0:1');
      expect(fx.lines().some((line) => line.startsWith('EXIT:1:'))).toBe(true);
      expect(fx.lines()).toContain('OWNED_SIGNALS:0:0');
      expect(fx.output().stderr).toContain('Daemon startup failed');
      expect(fx.output().stderr).toContain('Daemon shutdown deadline exceeded');
      expect(fx.output().stderr).not.toContain('PRIVATE_STARTUP_');
    } finally { await fx.cleanup(); }
  }, 20_000);
}
