import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentWorktree } from '../sdk/src/platform/agents/worktree.js';
import { GitService } from '../sdk/src/platform/git/service.js';

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(Buffer.from(result.stderr).toString('utf8'));
  }
  return Buffer.from(result.stdout).toString('utf8');
}

describe('AgentWorktree', () => {
  for (const ignored of [false, true]) test(`commitWorkingTree commits project changes without staging GoodVibes internal state (ignored=${ignored})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-'));
    runGit(root, ['init']);
    runGit(root, ['config', 'user.name', '']);
    runGit(root, ['config', 'user.email', '']);
    runGit(root, ['config', 'user.useConfigOnly', 'true']);
    const originalConfig = readFileSync(join(root, '.git', 'config'), 'utf8');
    expect(() => runGit(root, ['var', 'GIT_AUTHOR_IDENT'])).toThrow();
    expect(() => runGit(root, ['var', 'GIT_COMMITTER_IDENT'])).toThrow();

    if (ignored) writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    writeFileSync(join(root, 'feature.ts'), 'export const ok = true;\n');
    mkdirSync(join(root, '.goodvibes', 'sessions'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'sessions', 'internal.json'), '{}\n');

    const worktree = new AgentWorktree(root);
    const { hash } = await worktree.commitWorkingTree('Contract: commit project changes');

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const trackedFiles = runGit(root, ['ls-files']);
    expect(trackedFiles).toContain('feature.ts');
    expect(trackedFiles).not.toContain('.goodvibes');
    expect(runGit(root, ['show', 'HEAD:feature.ts'])).toBe('export const ok = true;\n');
    expect(runGit(root, ['show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD'])).toBe('GoodVibes\ngoodvibes@local\nGoodVibes\ngoodvibes@local\n');
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(originalConfig);

    writeFileSync(join(root, '.goodvibes', 'sessions', 'later.json'), '{}\n');
    await expect(worktree.commitWorkingTree('Contract: internal only')).resolves.toEqual({ hash: null, skippedIgnored: [] });
  });

  test('commitWorkingTree preserves a configured native identity instead of selecting its fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-identity-'));
    runGit(root, ['init']);
    runGit(root, ['config', 'user.name', 'Native fixture']);
    runGit(root, ['config', 'user.email', 'native-fixture@example.test']);
    const originalConfig = readFileSync(join(root, '.git', 'config'), 'utf8');
    writeFileSync(join(root, 'feature.ts'), 'export const native = true;\n');
    const result = await new AgentWorktree(root).commitWorkingTree('Contract: configured author');
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(runGit(root, ['show', 'HEAD:feature.ts'])).toBe('export const native = true;\n');
    expect(runGit(root, ['show', '-s', '--format=%an%n%ae%n%cn%n%ce', 'HEAD'])).toBe('Native fixture\nnative-fixture@example.test\nNative fixture\nnative-fixture@example.test\n');
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(originalConfig);
  });

  test.each(['absent', 'invalid'] as const)('GitService does not commit with an %s fallback and missing native identity', async fallback => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-invalid-identity-'));
    runGit(root, ['init']);
    runGit(root, ['config', 'user.name', '']);
    runGit(root, ['config', 'user.email', '']);
    runGit(root, ['config', 'user.useConfigOnly', 'true']);
    const originalConfig = readFileSync(join(root, '.git', 'config'), 'utf8');
    writeFileSync(join(root, 'feature.ts'), 'export const pending = true;\n');
    runGit(root, ['add', 'feature.ts']);
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(hookPath, '#!/bin/sh\nprintf "attempt\\n" >> .git/commit-attempts\n');
    if (Bun.spawnSync(['chmod', '+x', hookPath]).exitCode !== 0) throw new Error('Could not make fixture hook executable');
    const options = fallback === 'invalid' ? { fallbackIdentity: { name: '', email: 'invalid-fixture@example.test' } } : undefined;
    await expect(new GitService(root).commit('Contract: unavailable native author', options)).rejects.toThrow();
    expect(() => runGit(root, ['rev-parse', '--verify', 'HEAD'])).toThrow();
    expect(existsSync(join(root, '.git', 'commit-attempts'))).toBe(false);
    expect(runGit(root, ['diff', '--cached', '--name-only'])).toBe('feature.ts\n');
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe(originalConfig);
  });

  test('commitWorkingTree(message, paths) stages only the given paths, leaving other dirty files uncommitted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-scoped-'));
    runGit(root, ['init']);

    writeFileSync(join(root, 'touched.ts'), 'export const touched = true;\n');
    writeFileSync(join(root, 'untouched.ts'), 'export const untouched = true;\n');

    const worktree = new AgentWorktree(root);
    const { hash } = await worktree.commitWorkingTree('Contract: scoped commit', ['touched.ts']);

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('touched.ts');
    expect(committedFiles).not.toContain('untouched.ts');

    const status = runGit(root, ['status', '--porcelain']);
    expect(status).toContain('untouched.ts');
  });

  test('commitWorkingTree(message, paths) tolerates a hallucinated path mixed into the batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-scoped-hallucinated-'));
    runGit(root, ['init']);

    writeFileSync(join(root, 'real.ts'), 'export const real = true;\n');

    const worktree = new AgentWorktree(root);
    const { hash } = await worktree.commitWorkingTree('Contract: scoped commit with bad claim', [
      'real.ts',
      'this/path/was/never/written.ts',
    ]);

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('real.ts');
  });

  test('commitWorkingTree(message, paths) stages a confirmed deletion even though the path no longer exists on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-scoped-deleted-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'gone.ts'), 'export const gone = true;\n');
    runGit(root, ['add', 'gone.ts']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
    // Delete the tracked file from the working tree without staging the removal, the
    // engineer's report claims a deletion of a path that git still has tracked in HEAD.
    Bun.spawnSync(['rm', join(root, 'gone.ts')]);

    const worktree = new AgentWorktree(root);
    const { hash } = await worktree.commitWorkingTree('Contract: scoped deletion', ['gone.ts']);

    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const trackedFiles = runGit(root, ['ls-files']);
    expect(trackedFiles).not.toContain('gone.ts');
  });

  test('commitWorkingTree(message, paths) commits the deliverable and skips a gitignored path in the same ledger, leaving a clean index', async () => {
    // Reproduces the scoped-commit trust defect: the product writes .gitignore (ignoring .goodvibes/) and
    // its own bookkeeping under .goodvibes/, so a self-reported ledger mixes a real deliverable
    // with an ignored path. `git add -A -- <deliverable> <ignored>` exits non-zero AFTER staging
    // the deliverable, the ignored path must be filtered out first.
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-ignored-'));
    runGit(root, ['init']);
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    runGit(root, ['add', '.gitignore']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed .gitignore']);

    writeFileSync(join(root, 'slugify.ts'), 'export const slugify = (s: string) => s;\n');
    mkdirSync(join(root, '.goodvibes', 'memory'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'memory', 'repo_preferences.json'), '{"pref":1}\n');

    const worktree = new AgentWorktree(root);
    const result = await worktree.commitWorkingTree('Contract: slugify', [
      'slugify.ts',
      '.goodvibes/memory/repo_preferences.json',
    ]);

    // The deliverable committed; the ignored bookkeeping path is reported as skipped, not failed.
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.skippedIgnored).toEqual(['.goodvibes/memory/repo_preferences.json']);
    const committedFiles = runGit(root, ['show', '--stat', '--name-only', 'HEAD']);
    expect(committedFiles).toContain('slugify.ts');
    expect(committedFiles).not.toContain('.goodvibes');
    // Index is clean, nothing left staged after the commit.
    expect(runGit(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  test('commitWorkingTree(message, paths) returns hash:null when every scoped path is gitignored, staging nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-all-ignored-'));
    runGit(root, ['init']);
    writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
    runGit(root, ['add', '.gitignore']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);
    mkdirSync(join(root, '.goodvibes', 'memory'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'memory', 'x.json'), '{}\n');

    const worktree = new AgentWorktree(root);
    const result = await worktree.commitWorkingTree('Contract: only ignored', ['.goodvibes/memory/x.json']);

    expect(result.hash).toBeNull();
    expect(result.skippedIgnored).toEqual(['.goodvibes/memory/x.json']);
    expect(runGit(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  test.each([
    ['configured', false],
    ['fallback', false],
    ['configured', true],
    ['fallback', true],
  ] as const)('commitWorkingTree restores the index when the commit step fails after staging (%s identity; diagnostic=%s)', async (identity, diagnostic) => {
    // A genuinely-failing commit (here: a pre-commit hook that rejects) must not leave the
    // deliverable staged in the user's index. The staged path is reset before the error propagates.
    const root = mkdtempSync(join(tmpdir(), 'agent-worktree-restore-'));
    runGit(root, ['init']);
    writeFileSync(join(root, 'seed.ts'), 'export const seed = 1;\n');
    runGit(root, ['add', 'seed.ts']);
    runGit(root, ['-c', 'user.email=a@b.c', '-c', 'user.name=test', 'commit', '-m', 'seed']);

    // Exercise both paths regardless of the host's identity. Empty local values
    // force the fallback path even outside the guarded runner's isolated HOME.
    runGit(root, ['config', 'user.name', identity === 'configured' ? 'test' : '']);
    runGit(root, ['config', 'user.email', identity === 'configured' ? 'a@b.c' : '']);
    const originalHead = runGit(root, ['rev-parse', 'HEAD']).trim();

    // Install a pre-commit hook that always rejects. The executable bit must be set explicitly,
    // git ignores a non-executable hook (and writeFileSync's mode is not honored reliably here).
    const hookDir = join(root, '.git', 'hooks');
    mkdirSync(hookDir, { recursive: true });
    const hookPath = join(hookDir, 'pre-commit');
    const hookMessage = diagnostic ? 'printf "Author identity unknown\\n" >&2\n' : '';
    writeFileSync(hookPath, `#!/bin/sh\nprintf "attempt\\n" >> .git/commit-attempts\n${hookMessage}exit 1\n`);
    Bun.spawnSync(['chmod', '+x', hookPath]);

    writeFileSync(join(root, 'deliverable.ts'), 'export const d = true;\n');
    const worktree = new AgentWorktree(root);
    await expect(worktree.commitWorkingTree('Contract: rejected', ['deliverable.ts'])).rejects.toThrow();

    expect(runGit(root, ['rev-parse', 'HEAD']).trim()).toBe(originalHead);
    expect(readFileSync(join(root, '.git', 'commit-attempts'), 'utf8')).toBe('attempt\n');

    // Index must be clean despite the failed commit, the staged path was reset.
    expect(runGit(root, ['diff', '--cached', '--name-only']).trim()).toBe('');
    // And the working-tree file is untouched (still present, just not staged).
    expect(runGit(root, ['status', '--porcelain']).trim()).toContain('deliverable.ts');
  });
});
