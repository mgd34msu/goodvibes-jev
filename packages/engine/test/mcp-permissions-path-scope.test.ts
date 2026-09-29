// An MCP server's allowedPaths scope is judged by where a path lands, not by
// how it is spelled: `..` segments, sibling directories that share a prefix
// and symlinks out of an allowed directory all fall outside the scope.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpPermissionManager } from '../sdk/src/platform/runtime/mcp/index.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings([['read_docs', { capability: 'read_fs', mutates: false }]]);

let root = '';
let allowed = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-scope-'));
  allowed = join(root, 'allowed');
  mkdirSync(allowed);
  mkdirSync(join(root, 'allowed-2'));
  mkdirSync(join(root, 'elsewhere'));
  writeFileSync(join(allowed, 'a.md'), 'a');
  writeFileSync(join(root, 'elsewhere', 'secret.md'), 's');
  symlinkSync(join(root, 'elsewhere'), join(allowed, 'link-out'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function verdict(path: string): Promise<string | undefined> {
  const manager = new McpPermissionManager();
  manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained', allowedPaths: [allowed] });
  return (await manager.evaluateToolCall('docs', 'read_docs', { path })).verdict;
}

describe('McpPermissionManager path scope', () => {
  test('a file inside the allowed directory is in scope', async () => {
    expect(await verdict(join(allowed, 'a.md'))).toBe('allow');
    expect(await verdict(join(allowed, 'not-yet', 'new.md'))).toBe('allow');
  });

  test('a path that climbs out with .. is out of scope', async () => {
    expect(await verdict(`${allowed}/../elsewhere/secret.md`)).toBe('deny');
  });

  test('a sibling directory sharing the prefix is out of scope', async () => {
    expect(await verdict(join(root, 'allowed-2', 'x.md'))).toBe('deny');
  });

  test('a symlink inside the allowed directory that points out is out of scope', async () => {
    expect(await verdict(join(allowed, 'link-out', 'secret.md'))).toBe('deny');
  });
});
