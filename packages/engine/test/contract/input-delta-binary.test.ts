import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, chmodSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureContractInput, materializeContractInput } from '../../sdk/src/platform/contract/input-snapshot.js';
import { applyCapturedInputDelta } from '../../sdk/src/platform/contract/input-apply.js';
function git(root: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', root, ...args]);
  if (r.status !== 0) throw Error(r.stderr.toString());
  return r.stdout;
}
test('binary/modification/deletion/mode delta preserves owner raw index and dirty same-path staging', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-dirty-binary-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Owned Fixture');
    git(root, 'config', 'user.email', 'owned@example.invalid');
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    writeFileSync(join(root, 'same.txt'), 'base\n');
    writeFileSync(join(root, 'delete.txt'), 'remove\n');
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, 'mode.sh'), 'exit 0\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'baseline');
    writeFileSync(join(root, 'same.txt'), 'staged owner\n');
    git(root, 'add', 'same.txt');
    writeFileSync(join(root, 'same.txt'), 'unstaged owner\n');
    writeFileSync(join(root, 'notes'), 'untracked owner\n');
    const index = readFileSync(join(root, '.git/index'));
    const head = git(root, 'rev-parse', 'HEAD');
    const staged = git(root, 'show', ':same.txt');
    const snapshot = await captureContractInput(root);
    const view = join(root, '.goodvibes/.worktrees/contract/review');
    mkdirSync(join(root, '.goodvibes/.worktrees/contract'), { recursive: true });
    git(root, 'worktree', 'add', '--no-checkout', '-b', 'review-result', view, snapshot.inputCommit);
    await materializeContractInput(snapshot, view);
    writeFileSync(join(view, 'same.txt'), 'unstaged owner\ncontract addition\n');
    writeFileSync(join(view, 'binary.bin'), Buffer.from([0, 7, 255, 0]));
    rmSync(join(view, 'delete.txt'));
    chmodSync(join(view, 'mode.sh'), 0o755);
    writeFileSync(join(view, 'new.bin'), Buffer.from([0, 9, 0]));
    git(view, 'add', '-A');
    git(view, 'commit', '-qm', 'owned result');
    const contract = {
      projectRoot: root,
      inputSnapshot: snapshot,
      worktreePath: view,
      branch: 'review-result',
    } as import('../../sdk/src/platform/contract/types.js').Contract;
    expect(await applyCapturedInputDelta(contract, async () => true, new AbortController().signal)).toBe(5);
    expect(readFileSync(join(root, 'same.txt'), 'utf8')).toBe('unstaged owner\ncontract addition\n');
    expect(readFileSync(join(root, 'notes'), 'utf8')).toBe('untracked owner\n');
    expect(readFileSync(join(root, 'binary.bin'))).toEqual(Buffer.from([0, 7, 255, 0]));
    expect(readFileSync(join(root, 'new.bin'))).toEqual(Buffer.from([0, 9, 0]));
    expect(existsSync(join(root, 'delete.txt'))).toBe(false);
    expect(statSync(join(root, 'mode.sh')).mode & 0o111).toBeGreaterThan(0);
    expect(readFileSync(join(root, '.git/index'))).toEqual(index);
    expect(git(root, 'rev-parse', 'HEAD')).toEqual(head);
    expect(git(root, 'show', ':same.txt')).toEqual(staged);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
