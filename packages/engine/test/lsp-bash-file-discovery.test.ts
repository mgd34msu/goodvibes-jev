import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Discovery {
  getFilePaths(options: { globPattern: string; rootPath: string; maxItems: number }): Promise<string[]>;
}
const require = createRequire(import.meta.url);
// Exercise the installed optional dependency used by the actual LSP, not a test copy.
const { getFilePaths } = require('bash-language-server/out/util/fs.js') as Discovery;
let root: string;
const sourceFiles = ['run.sh', 'step1.sh', 'step2.sh', 'step3.sh', 'lib/include.inc', 'lib/env.bash', 'lib/launch.command', 'lib/notes.txt', '.hidden.sh', '.private/secret.sh'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-bash-discovery-'));
  for (const name of sourceFiles) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '# synthetic discovery fixture\n');
  }
  mkdirSync(join(root, 'directory.sh'));
  symlinkSync('run.sh', join(root, 'alias.sh'));
  symlinkSync('missing.sh', join(root, 'broken.sh'));
  symlinkSync('lib', join(root, 'linked'), 'dir');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function discover(pattern: string, maxItems = 100, rootPath = root): Promise<string[]> {
  const paths = await getFilePaths({ globPattern: pattern, rootPath, maxItems });
  expect(paths.every(isAbsolute)).toBe(true);
  expect(new Set(paths).size).toBe(paths.length);
  return paths.map(path => relative(root, path).replaceAll('\\', '/')).sort();
}

describe('bundled Bash LSP file discovery with bounded brace nesting', () => {
  test('retains default extglob, files only, symlink traversal and hidden exclusion', async () => {
    expect(await discover('**/*@(.sh|.inc|.bash|.command)')).toEqual([
      'alias.sh', 'lib/env.bash', 'lib/include.inc', 'lib/launch.command',
      'linked/env.bash', 'linked/include.inc', 'linked/launch.command',
      'run.sh', 'step1.sh', 'step2.sh', 'step3.sh',
    ]);
  });

  test('retains braces, ranges, nested paths and explicit dot patterns', async () => {
    expect(await discover('lib/*.{inc,bash}')).toEqual(['lib/env.bash', 'lib/include.inc']);
    expect(await discover('step{1..2}.sh')).toEqual(['step1.sh', 'step2.sh']);
    expect(await discover('step[12].sh')).toEqual(['step1.sh', 'step2.sh']);
    expect(await discover('.{hidden.sh,private/secret.sh}')).toEqual(['.hidden.sh', '.private/secret.sh']);
    expect(await discover('!**/*.sh')).toEqual([]);
  });

  test('accepts file URLs and an absolute pattern, and tolerates missing roots', async () => {
    expect(await discover('run.sh', 100, pathToFileURL(root).href)).toEqual(['run.sh']);
    expect(await discover(join(root, 'run.sh'))).toEqual(['run.sh']);
    expect(await discover('**/*.sh', 100, join(root, 'absent'))).toEqual([]);
  });

  test('bounds results and cancels the stream when the cap is reached', async () => {
    expect(await discover('**/*', 0)).toEqual([]);
    const capped = await discover('**/*', 2);
    expect(capped).toHaveLength(2);
    // Stream completion must not poison a later scan or leak an unhandled error.
    expect((await discover('**/*')).length).toBeGreaterThan(2);
  });

  test('preserves custom negative extglob and exclusion-only pattern semantics', async () => {
    writeFileSync(join(root, '!file.sh'), 'fixture');
    // Keep the existing micromatch rules, including its negative-extglob
    // handling of hidden names and prefix exclusions.
    expect(await discover('!(run).sh')).toEqual(['!file.sh', '.hidden.sh', 'alias.sh', 'step1.sh', 'step2.sh', 'step3.sh']);
    expect(await discover('!file.sh')).toEqual([]);
  });
});
