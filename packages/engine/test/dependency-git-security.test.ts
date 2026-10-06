import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSimpleGit } from '../sdk/src/platform/git/optional-simple-git.js';
import { GitService } from '../sdk/src/platform/git/service.js';
import { SideGitRunner, detectGitToplevel } from '../sdk/src/platform/workspace/checkpoint/side-git.js';

const require = createRequire(import.meta.url);

async function withEnv(values: Record<string, string>, run: () => Promise<void>): Promise<void> {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { await run(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function scratch(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'patched-git-'));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('patched optional Git dependency', () => {
  test('loads the named-only v4 export and its patched argument parser from the engine dependency', async () => {
    const entry = require.resolve('simple-git');
    const manifest = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
    const parserEntry = createRequire(entry).resolve('@simple-git/argv-parser');
    const parser = JSON.parse(readFileSync(join(dirname(parserEntry), '..', 'package.json'), 'utf8'));
    expect(manifest.version).toBe('4.0.2');
    expect(parser.version).toBe('2.0.1');
    expect((await import('simple-git'))).not.toHaveProperty('default');
    await scratch(async root => {
      const git = await createSimpleGit(root);
      await git.raw(['init', '--quiet']);
      expect((await git.status()).isClean()).toBe(true);
    });
  });

  test('rejects trailer commands, includes, and abbreviated execution before changing scratch config', async () => scratch(async root => {
    await (await createSimpleGit(root)).raw(['init', '--quiet']);
    const configPath = join(root, '.git', 'config');
    const before = readFileSync(configPath, 'utf8');
    for (const args of [
      ['config', 'trailer.fixture.command', 'echo harmless-fixture'],
      ['config', 'trailer.fixture.cmd', 'echo harmless-fixture'],
      ['config', 'include.path', join(root, 'unused-config')],
      ['config', 'includeIf.gitdir:fixture.path', join(root, 'unused-config')],
      ['-c', 'trailer.fixture.command=echo harmless-fixture', 'status'],
      ['rebase', '--exe', 'echo harmless-fixture'],
      ['push', '--receive-p=echo harmless-fixture', '.'],
      [`--git-dir=${join(root, '.git')}`, 'status'],
    ]) {
      const git = await createSimpleGit(root);
      await expect(Promise.resolve(git.raw(args))).rejects.toThrow(/not permitted|abbreviat/i);
      expect(readFileSync(configPath, 'utf8')).toBe(before);
    }
  }));

  test('explicit editor/config injection stays blocked without unsafe escape hatches', async () => scratch(async root => {
    for (const key of ['VISUAL', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_INDEX_FILE']) {
      const git = await createSimpleGit(root);
      await expect(Promise.resolve(git.env({ [key]: 'harmless-fixture' }).raw(['--version']))).rejects.toThrow(/not permitted|environment guard/);
    }
  }));

  test('preserves the discovery ceiling for the service and checkpoint lookup', async () => scratch(async root => {
    await (await createSimpleGit(root)).raw(['init', '--quiet']);
    const ceiling = join(root, 'fence');
    const child = join(ceiling, 'plain-workspace');
    mkdirSync(child, { recursive: true });
    expect(await detectGitToplevel(child)).toBe(root);
    await withEnv({ GIT_CEILING_DIRECTORIES: ceiling }, async () => {
      expect(await detectGitToplevel(child)).toBeNull();
      await expect(new GitService(child).status()).rejects.toThrow(/not a git repository/);
    });
  }));

  test('real merge conflicts preserve structured paths after the v4 upgrade', async () => scratch(async root => {
    const git = await createSimpleGit(root);
    await git.raw(['init', '--quiet', '--initial-branch=main']);
    await git.raw(['config', 'user.name', 'Fixture']);
    await git.raw(['config', 'user.email', 'fixture@example.invalid']);
    const service = new GitService(root);
    writeFileSync(join(root, 'shared.txt'), 'initial\n');
    await service.add('shared.txt');
    await service.commit('seed');
    await service.checkout('feature', { create: true });
    writeFileSync(join(root, 'shared.txt'), 'feature\n');
    await service.add('shared.txt');
    await service.commit('feature edit');
    await service.checkout('main');
    writeFileSync(join(root, 'shared.txt'), 'main\n');
    await service.add('shared.txt');
    await service.commit('main edit');
    expect(await service.merge('feature')).toEqual({ success: false, conflicts: ['shared.txt'] });
    expect((await service.status()).conflicted).toEqual(['shared.txt']);
  }));

  test('normal worktrees retain hooks while no-checkout worktrees retain the fixed hook suppression', async () => scratch(async root => {
    const git = await createSimpleGit(root);
    await git.raw(['init', '--quiet']);
    await git.raw(['config', 'user.name', 'Fixture']);
    await git.raw(['config', 'user.email', 'fixture@example.invalid']);
    writeFileSync(join(root, 'fixture.txt'), 'seed\n');
    const service = new GitService(root);
    await service.add('fixture.txt');
    await service.commit('seed');
    writeFileSync(join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nprintf hook-ran > "$PWD/hook-marker"\n', { mode: 0o755 });
    const normal = join(root, 'normal');
    await service.worktreeAdd(normal, 'normal');
    expect(readFileSync(join(normal, 'hook-marker'), 'utf8')).toBe('hook-ran');
    const empty = join(root, 'empty');
    await service.worktreeAdd(empty, 'empty', undefined, false);
    expect(existsSync(join(empty, '.git'))).toBe(true);
    expect(existsSync(join(empty, 'fixture.txt'))).toBe(false);
    expect(existsSync(join(empty, 'hook-marker'))).toBe(false);
    expect((await service.worktreeList()).map(worktree => worktree.branch)).toContain('empty');
  }));

  test('side checkpoints strip inherited injection and keep their owned routing and construction snapshot', async () => scratch(async root => {
    const userGit = await createSimpleGit(root);
    await userGit.raw(['init', '--quiet']);
    const configPath = join(root, '.git', 'config');
    const userConfig = readFileSync(configPath, 'utf8');
    const gitDir = join(root, '.goodvibes', 'checkpoints', 'git');
    writeFileSync(join(root, 'fixture.txt'), 'checkpoint contents\n');
    await withEnv({
      VISUAL: 'harmless-editor', visual: 'harmless-editor-lowercase',
      GIT_CONFIG_PARAMETERS: "'user.name=unexpected'", git_config_parameters: 'invalid',
      GIT_DIR: join(root, 'wrong-repo'), GIT_WORK_TREE: join(root, 'wrong-tree'),
      GIT_INDEX_FILE: join(root, 'wrong-index'), GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'unexpected',
      GIT_CEILING_DIRECTORIES: root,
    }, async () => {
      const side = new SideGitRunner({ workspaceRoot: root, gitDir });
      // The lazy client must retain constructor-time routing, not this later environment.
      process.env.GIT_DIR = join(root, 'later-wrong-repo');
      await side.init();
      expect((await side.raw(['rev-parse', '--absolute-git-dir'])).trim()).toBe(gitDir);
      expect((await side.raw(['rev-parse', '--show-toplevel'])).trim()).toBe(root);
      expect((await side.raw(['config', 'user.name'])).trim()).toBe('GoodVibes Checkpoints');
      await side.stageAll(['fixture.txt']);
      const tree = await side.writeTree();
      const commit = await side.commitTree(tree, 'bounded checkpoint fixture');
      expect(await side.treeOf(commit)).toBe(tree);
      writeFileSync(join(root, 'fixture.txt'), 'changed\n');
      await side.readTreeReset(commit);
      await side.checkoutIndexAll();
      expect(readFileSync(join(root, 'fixture.txt'), 'utf8')).toBe('checkpoint contents\n');
      expect(await detectGitToplevel(root)).toBe(root);
    });
    expect(readFileSync(configPath, 'utf8')).toBe(userConfig);
    expect(existsSync(join(root, '.git', 'index'))).toBe(false);
    for (const path of ['wrong-repo', 'later-wrong-repo', 'wrong-index']) expect(existsSync(join(root, path))).toBe(false);
  }));
});
