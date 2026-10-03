import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isPrivateWorkspaceSource } from '../../cli/workspace-source.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function write(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function fixture() {
  const root = makeProjectTempDir('workspace-source');
  const product = join(root, 'products', 'tui');
  const pkg = { name: '@goodvibes-jev/tui', private: true, dependencies: { '@goodvibes-jev/engine': 'workspace:*' } };
  write(join(product, 'package.json'), pkg);
  write(join(root, 'package.json'), { private: true, workspaces: ['packages/*', 'products/*'] });
  write(join(root, 'packages', 'engine', 'package.json'), { name: '@goodvibes-jev/engine' });
  writeFileSync(join(root, '.git'), 'gitdir: fixture-worktree');
  return { root, product, pkg };
}

test('recognizes the exact private source workspace with a git worktree marker', () => {
  expect(isPrivateWorkspaceSource(fixture().product)).toBe(true);
});
test.each([
  { private: false }, { private: 'true' }, { name: '@fixture/tui' },
  { dependencies: {} }, { dependencies: { '@goodvibes-jev/engine': '^2.0.0' } },
  { dependencies: { '@goodvibes-jev/engine': 'workspace:^' } },
  { dependencies: null }, { dependencies: [] },
])('near-match product manifests do not suppress installation: %j', override => {
  const f = fixture(); write(join(f.product, 'package.json'), { ...f.pkg, ...override });
  expect(isPrivateWorkspaceSource(f.product)).toBe(false);
});
test.each(['product', 'workspace', 'engine'] as const)('malformed %s manifest is not a workspace', target => {
  const f = fixture(); const path = target === 'product' ? join(f.product, 'package.json') : target === 'workspace' ? join(f.root, 'package.json') : join(f.root, 'packages', 'engine', 'package.json');
  writeFileSync(path, '{'); expect(isPrivateWorkspaceSource(f.product)).toBe(false);
});
test('an installed copy outside the declared product boundary does not suppress installation', () => {
  const f = fixture(); const installed = join(f.root, 'node_modules', '@goodvibes-jev', 'tui');
  write(join(installed, 'package.json'), f.pkg); expect(isPrivateWorkspaceSource(installed)).toBe(false);
});
test('both product and engine workspace declarations are required', () => {
  for (const workspaces of [['products/*'], ['packages/*'], ['other/*']]) {
    const f = fixture(); write(join(f.root, 'package.json'), { private: true, workspaces });
    expect(isPrivateWorkspaceSource(f.product)).toBe(false);
  }
});
test('an unrelated engine package does not prove workspace ownership', () => {
  const f = fixture(); write(join(f.root, 'packages', 'engine', 'package.json'), { name: '@fixture/engine' });
  expect(isPrivateWorkspaceSource(f.product)).toBe(false);
});

test('exact workspace paths and a lockfile marker also prove the source layout', () => {
  const f = fixture(); rmSync(join(f.root, '.git'));
  writeFileSync(join(f.root, 'bun.lock'), '{}');
  write(join(f.root, 'package.json'), { private: true, workspaces: ['packages/engine', 'products/tui'] });
  expect(isPrivateWorkspaceSource(f.product)).toBe(true);
});
test('a package layout without a source marker does not suppress installation', () => {
  const f = fixture(); rmSync(join(f.root, '.git'));
  expect(isPrivateWorkspaceSource(f.product)).toBe(false);
});
test('a non-private root is not the private workspace contract', () => {
  const f = fixture(); write(join(f.root, 'package.json'), { private: false, workspaces: ['packages/*', 'products/*'] });
  expect(isPrivateWorkspaceSource(f.product)).toBe(false);
});
