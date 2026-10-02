import { afterEach, expect, test } from 'bun:test';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitService } from '../sdk/src/platform/git/service.ts';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repository() {
  const root = mkdtempSync(join(tmpdir(), 'worktree-metadata-')); roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'seed']);
  return root;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function controlledService(cwd: string, intercept: (args: string[]) => Promise<void>, afterRaw?: (args: string[]) => void): GitService {
  const service = new GitService(cwd);
  // Per-instance client seam only: leave the module and every other service
  // untouched. All commands still execute the host's real Git after the pause.
  Object.defineProperty(service, 'gitClient', { value: Promise.resolve({ raw: async (args: string[]) => {
    await intercept(args);
    const result = (await exec('git', args, { cwd })).stdout;
    afterRaw?.(args);
    return result;
  } }) });
  return service;
}

test.each(['same root', 'symlink alias', 'linked worktree'])('sibling services never observe half-written administration via %s', async location => {
  const root = repository();
  let bottomCwd = root;
  if (location === 'symlink alias') {
    bottomCwd = join(root, 'alias'); symlinkSync(root, bottomCwd, 'dir');
  } else if (location === 'linked worktree') {
    bottomCwd = join(root, 'linked');
    execFileSync('git', ['-C', root, 'worktree', 'add', bottomCwd, '-b', 'linked'], { stdio: 'pipe' });
  }
  const entered = deferred(); const finish = deferred(); const commonDirRead = deferred();
  const partial = join(root, '.git', 'worktrees', 'top');
  const top = controlledService(root, async args => {
    if (args[0] !== 'worktree') return;
    // Reproduce Git's actual open-before-write window, which makes a concurrent
    // add die with "failed to read .../commondir: Success" on the CI Git build.
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'commondir'), '');
    writeFileSync(join(partial, 'gitdir'), join(root, 'top', '.git') + '\n');
    writeFileSync(join(partial, 'HEAD'), 'ref: refs/heads/top\n');
    entered.resolve();
    await finish.promise;
    rmSync(partial, { recursive: true });
  });
  let bottomStarted = false;
  const bottom = controlledService(bottomCwd, async args => {
    if (args[0] === 'worktree') bottomStarted = true;
  }, args => { if (args[0] === 'rev-parse') commonDirRead.resolve(); });
  const first = top.worktreeAdd(join(root, 'top'), 'top');
  await entered.promise;
  const second = bottom.worktreeAdd(join(root, 'bottom'), 'bottom');
  // Let the contender finish its repository-key read and yield one event-loop
  // turn so its queued promise callbacks can run while top is still paused.
  await Promise.race([commonDirRead.promise, second.catch(() => undefined)]);
  await new Promise<void>(resolve => setImmediate(resolve));
  const startedWhilePartial = bottomStarted;
  finish.resolve();
  const outcomes = await Promise.allSettled([first, second]);
  expect(startedWhilePartial).toBe(false);
  expect(outcomes.map(result => result.status)).toEqual(['fulfilled', 'fulfilled']);
  expect((await new GitService(root).worktreeList()).map(w => w.branch).sort()).toContain('bottom');
});

test('failed creation releases the lane and unrelated repositories do not wait', async () => {
  const root = repository(); const other = repository();
  const entered = deferred(); const finish = deferred();
  const blocking = controlledService(root, async args => {
    if (args[0] !== 'worktree') return;
    entered.resolve(); await finish.promise; throw new Error('synthetic setup failure');
  });
  const failed = blocking.worktreeAdd(join(root, 'failed'), 'failed').catch(error => error);
  await entered.promise;
  await new GitService(other).worktreeAdd(join(other, 'independent'), 'independent');
  const queued = new GitService(root).worktreeAdd(join(root, 'after'), 'after');
  finish.resolve();
  expect((await failed).message).toContain('synthetic setup failure');
  await queued;
  expect((await new GitService(root).worktreeList()).some(w => w.branch === 'after')).toBe(true);
  // Reuse the repository after both rejection and success, including teardown.
  await new GitService(root).worktreeRemove(join(root, 'after'));
  await new GitService(root).worktreeAdd(join(root, 'retry'), 'retry');
  const remaining = await new GitService(root).worktreeList();
  expect(remaining.some(w => w.branch === 'after')).toBe(false);
  expect(remaining.some(w => w.branch === 'retry')).toBe(true);
});
