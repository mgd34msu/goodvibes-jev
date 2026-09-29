/**
 * MCP server config: role and trustMode are read only when they name a role or
 * trust mode the permission manager implements. An unknown value is reported
 * and treated as absent (the manager's default applies) instead of flowing on
 * as an unknown mode; a write with one is refused.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig, upsertMcpServerConfig } from '../sdk/src/platform/mcp/config.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(file: unknown) {
  const base = mkdtempSync(join(tmpdir(), 'gv-mcp-config-'));
  roots.push(base);
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  mkdirSync(join(cwd, '.goodvibes'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cwd, '.goodvibes', 'mcp.json'), JSON.stringify(file));
  return { homeDirectory: home, workingDirectory: cwd };
}

describe('MCP role and trust mode', () => {
  test('mcpServers format: known values are kept, unknown ones are dropped', () => {
    const config = loadMcpConfig(workspace({ mcpServers: {
      good: { command: 'good-mcp', role: 'filesystem', trustMode: 'constrained' },
      typo: { command: 'typo-mcp', role: 'filesystems', trustMode: 'allowall' },
    } }));
    const byName = new Map(config.servers.map((server) => [server.name, server]));
    expect(byName.get('good')).toMatchObject({ role: 'filesystem', trustMode: 'constrained' });
    expect(byName.get('typo')?.role).toBeUndefined();
    expect(byName.get('typo')?.trustMode).toBeUndefined();
  });

  test('servers format: an unknown trust mode is dropped the same way', () => {
    const config = loadMcpConfig(workspace({ servers: [{ name: 'typo', command: 'typo-mcp', trustMode: 'trusted' }] }));
    expect(config.servers[0]?.trustMode).toBeUndefined();
  });

  test('writing a server with an unknown trust mode is refused', () => {
    const paths = workspace({ servers: [] });
    expect(() => upsertMcpServerConfig(paths, 'project', { name: 'x', command: 'x-mcp', args: [], trustMode: 'allowall' as never }))
      .toThrow("trustMode 'allowall'");
  });
});
