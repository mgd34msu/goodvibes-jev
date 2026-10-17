import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMcpConfigAutoReload } from '../../mcp/runtime-reload.ts';

test('MCP reload retries failure, retains edits during reload, and suppresses callbacks after stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tui-mcp-reload-'));
  mkdirSync(join(root, '.mcp'));
  const config = join(root, '.mcp', 'mcp.json');
  let calls = 0;
  let reports = 0;
  let errors = 0;
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const handle = startMcpConfigAutoReload({
    roots: { workingDirectory: root, homeDirectory: root }, intervalMs: 500,
    registry: {
      async reload() {
        calls++;
        if (calls === 1) throw new Error('transient connection failure');
        if (calls === 2) await pending;
        return { added: 0, changed: 0, removed: 0, unchanged: 0, servers: [] };
      },
      listServerSecurity: () => [],
    },
    onReload() { reports++; }, onError() { errors++; },
  });
  try {
    writeFileSync(config, '{}');
    await Bun.sleep(1100);
    expect(calls).toBe(2);
    expect(errors).toBe(1);
    writeFileSync(config, '{"mcpServers":{}}');
    await Bun.sleep(500);
    expect(calls).toBe(2);
    finish();
    await Bun.sleep(500);
    expect(calls).toBe(3);
    expect(reports).toBe(2);
    handle.stop();
    writeFileSync(config, '{}');
    await Bun.sleep(550);
    expect(calls).toBe(3);
  } finally { handle.stop(); finish(); rmSync(root, { recursive: true, force: true }); }
});
