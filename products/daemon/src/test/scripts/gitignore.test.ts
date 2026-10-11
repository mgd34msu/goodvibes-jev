import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const repository = resolve(import.meta.dir, '../../../../..');
const product = 'products/daemon/';
const protectedFiles = [
  'node_modules/dependency/index.js', 'dist/cli/index.js', 'native/goodvibes-daemon-linux-x64', 'native/lib/vec0.so',
  '.tmp/build-preparation.lock', 'venv/bin/python', '.venv/bin/python', '__pycache__/file.pyc', 'compiled.pyc',
  '.env', '.env.local', '.env.example', 'nested/.env.production', 'credentials.enc', 'nested/credentials.enc',
  '.goodvibes/state.json', '.goodvibes/secrets/token', '.goodvibes/eval/local-result.json',
  '.goodvibes/skills/example/.env', '.goodvibes/agents/credential.enc',
  '.codex/local.json', '.claude/local.json', 'docs/uat/session.json',
  '.test-tmp/output', '.test-edit-tmp123/output', '.tmp-tests/output', 'test-tmp-hooks/output',
  'test-tmp-session/output', 'tmp/output', '.gvtmp/cache', '.test-tmp-scratch/output', ':memory:',
];
const visibleFiles = [
  '.goodvibes/skills/example/SKILL.md', '.goodvibes/agents/reviewer.md', '.goodvibes/GOODVIBES.md',
  '.goodvibes/.npmignore', '.goodvibes/eval/baseline.json',
  'src/cli/entrypoint.ts', 'src/test/scripts/gitignore.test.ts', 'src/tmp-helper.ts',
  'tmp-source.ts', 'test-tmp-example.ts', 'vendor/source.ts',
  'platform-packages/example/bin/.gitkeep', 'platform-packages/example/src/index.ts',
  'docs/audit/receipt.md', 'docs/getting-started.md', 'scripts/reset-suite.sh',
  '.typecheck-coverage-probe.ts', 'README.md',
];

/** Real Git rule evaluation, isolated from the user's index and global excludes. */
function ignoredFiles(productRules: string, files: readonly string[], workspacePaths: readonly string[] = []): Set<string> {
  const root = makeOwnedTempDir('daemon-gitignore');
  const excludes = join(root, 'empty-excludes'); writeFileSync(excludes, '');
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env = { ...inherited, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: excludes };
  // A fresh fixture has no index and never stages or commits anything.
  const init = spawnSync('git', ['init', '--quiet', root], { env, encoding: 'utf8' });
  expect(init.status, init.stderr).toBe(0);
  writeFileSync(join(root, '.gitignore'), readFileSync(join(repository, '.gitignore')));
  mkdirSync(join(root, product), { recursive: true });
  writeFileSync(join(root, product, '.gitignore'), productRules);
  const paths = [...files.map(file => product + file), ...workspacePaths];
  for (const file of paths) { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'synthetic fixture\n'); }
  const args = ['-c', `core.excludesFile=${excludes}`, 'check-ignore', '--no-index', '-z', '--stdin'];
  const result = spawnSync('git', args, { cwd: root, env, input: paths.join('\0') + '\0', encoding: 'utf8' });
  expect(result.status === 0 || result.status === 1).toBe(true);
  expect(result.stderr).toBe('');
  expect(existsSync(join(root, '.git/index'))).toBe(false);
  return new Set(result.stdout.split('\0').filter(Boolean).map(file => file.startsWith(product) ? file.slice(product.length) : file));
}

test('actual root and daemon ignore rules protect secrets, runtime and local outputs while preserving source exceptions', () => {
  const rules = readFileSync(join(repository, product, '.gitignore'), 'utf8');
  const scratch = 'packages/engine/test/__favorites_tmp__/favorites.json';
  const source = 'packages/engine/test/providers-favorites.test.ts';
  const ignored = ignoredFiles(rules, [...protectedFiles, ...visibleFiles], [scratch, source]);
  expect(ignored.has(scratch)).toBe(true);
  expect(ignored.has(source)).toBe(false);
  for (const file of protectedFiles) expect(ignored.has(file), `must protect ${file}`).toBe(true);
  for (const file of visibleFiles) expect(ignored.has(file), `must retain source visibility: ${file}`).toBe(false);
});

test('the pre-port product rules demonstrably leaked secrets and suppressed intended resource exceptions', () => {
  const ignored = ignoredFiles('/native/\n/.tmp/\n', ['.env', 'credentials.enc', '.goodvibes/skills/example/SKILL.md', '.goodvibes/eval/baseline.json']);
  expect(ignored.has('.env')).toBe(false);
  expect(ignored.has('credentials.enc')).toBe(false);
  expect(ignored.has('.goodvibes/skills/example/SKILL.md')).toBe(true);
  expect(ignored.has('.goodvibes/eval/baseline.json')).toBe(true);
});
