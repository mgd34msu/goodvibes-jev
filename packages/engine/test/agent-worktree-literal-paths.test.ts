import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { AgentWorktree } from '../sdk/src/platform/agents/worktree.js';
function git(root: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', root, ...args]);
  if (r.status !== 0) throw Error(r.stderr.toString());
  return r.stdout.toString();
}
test('all-scope staging treats names literally, commits deletion, excludes ignored files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-stage-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Fixture');
    git(root, 'config', 'user.email', 'fixture@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\nignored.bin\n');
    writeFileSync(join(root, 'delete.txt'), 'old');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    rmSync(join(root, 'delete.txt'));
    mkdirSync(join(root, '.goodvibes'));
    writeFileSync(join(root, '.goodvibes/internal'), 'owned internal');
    writeFileSync(join(root, 'ignored.bin'), 'owned ignored');
    for (const name of ['[brackets].txt', 'with space.txt', ':(glob)odd.txt', 'line\nbreak.txt'])
      writeFileSync(join(root, name), 'owned addition');
    const result = await new AgentWorktree(root).commitWorkingTree('owned result');
    expect(result.hash).toBeTruthy();
    const names = git(root, 'ls-tree', '--name-only', '-z', 'HEAD').split('\0');
    for (const name of ['[brackets].txt', 'with space.txt', ':(glob)odd.txt', 'line\nbreak.txt'])
      expect(names).toContain(name);
    for (const name of ['delete.txt', '.goodvibes', 'ignored.bin']) expect(names).not.toContain(name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
