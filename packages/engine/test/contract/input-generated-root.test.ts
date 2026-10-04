/** Regression for an unignored runtime worktree during a later native attempt. */
import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureContractInput, materializeContractInput } from '../../sdk/src/platform/contract/input-snapshot.js';
import { makeRepo } from './runner-support.js';
import { git } from './steps-support.js';

async function generatedWorktree() {
  const root = makeRepo();
  // A caller must not have to change their repository's ignore configuration.
  rmSync(join(root, '.gitignore'));
  const beforeIndex = readFileSync(join(root, '.git/index'));
  const first = await captureContractInput(root);
  const view = join(root, '.goodvibes', '.worktrees', 'contract', 'owned-first');
  mkdirSync(join(root, '.goodvibes', '.worktrees', 'contract'), { recursive: true });
  git(root, 'worktree', 'add', '--no-checkout', '-b', 'owned-first', view, first.inputCommit);
  await materializeContractInput(first, view);
  return { root, first, view, beforeIndex };
}

test('second capture excludes an owned generated worktree before file-path validation without a gitignore edit', async () => {
  const f = await generatedWorktree();
  try {
    expect(git(f.root, 'ls-files', '--others', '--exclude-standard')).toContain('.goodvibes/.worktrees/contract/owned-first/');
    const second = await captureContractInput(f.root);
    expect(second.files).toEqual(f.first.files);
    expect(second.files.some(file => file.path.startsWith('.goodvibes/'))).toBe(false);
    expect(second.inputTree).toBe(f.first.inputTree);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(f.beforeIndex);
    expect(readFileSync(join(f.view, 'README.md'), 'utf8')).toBe('# demo\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('generated-root exclusion never permits a malformed ordinary input path', async () => {
  const f = await generatedWorktree();
  try {
    writeFileSync(join(f.root, 'ordinary\\ambiguous.txt'), 'ordinary fixture');
    await expect(captureContractInput(f.root)).rejects.toThrow('contract input contains an ambiguous path');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a lookalike ordinary directory is not the owned generated root', async () => {
  const f = await generatedWorktree();
  try {
    const ordinary = join(f.root, '.goodvibes-user'); mkdirSync(ordinary);
    git(ordinary, 'init', '-q'); writeFileSync(join(ordinary, 'ordinary.txt'), 'ordinary fixture');
    expect(git(f.root, 'ls-files', '--others', '--exclude-standard')).toContain('.goodvibes-user/');
    await expect(captureContractInput(f.root)).rejects.toThrow('contract input contains an ambiguous path');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
