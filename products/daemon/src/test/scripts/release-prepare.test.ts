import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { bumpVersion, parseArgs, prepareRelease, rewriteManifestVersion, scaffoldChangelogText } from '../../../scripts/release-prepare.ts';
import { checkBinaryVersion } from '../../../scripts/check-version.ts';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

const CHANGELOG = '# Changelog\n\nNotes.\n\n## [1.29.0] - 2026-09-30\n\n- previous\n\n---\n\n## [1.28.20] - 2026-08-21\n\n- older\n';
const PATHS = ['package.json', 'src/version.ts', 'README.md', 'CHANGELOG.md'];
function fixture(): string {
  const root = makeOwnedTempDir('daemon-release-prepare');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'package.json'), '{\n  "dependencies": {"version":"8.0.0"},\n  "name":"@goodvibes-jev/daemon", "private":true,\n  "version": "1.29.3"\n}\n');
  writeFileSync(join(root, 'src/version.ts'), "// retain me\nlet _version = '1.29.3';\nexport const VERSION = _version;\n");
  writeFileSync(join(root, 'README.md'), '# Private daemon\n![version](version-1.29.3-blue.svg)\n');
  writeFileSync(join(root, 'CHANGELOG.md'), CHANGELOG);
  return root;
}
function snapshot(root: string): string[] { return PATHS.map((path) => readFileSync(join(root, path), 'utf8')); }

describe('original pinned release preparation assertions', async () => {
  test('inserts before the newest heading, preserving intro, separators and entire old body', async () => {
    const out = scaffoldChangelogText(CHANGELOG, '1.30.0', '2026-10-01');
    expect(out.split('\n').filter((line) => line.startsWith('## '))).toEqual(['## [1.30.0] - 2026-10-01', '## [1.29.0] - 2026-09-30', '## [1.28.20] - 2026-08-21']);
    expect(out.startsWith('# Changelog\n\nNotes.\n\n## [1.30.0]')).toBe(true);
    expect(out.endsWith(CHANGELOG.slice(CHANGELOG.indexOf('## [1.29.0]')))).toBe(true);
  });
  test('existing section is byte-identical and version prefixes are distinct', async () => {
    expect(scaffoldChangelogText(CHANGELOG, '1.29.0', '2026-10-01')).toBe(CHANGELOG);
    expect(scaffoldChangelogText(CHANGELOG, '1.28.2', '2026-10-01')).toContain('## [1.28.2] - 2026-10-01');
  });
  test('no sections appends one scaffold', async () => {
    expect(scaffoldChangelogText('# Changelog\n', '0.1.0', '2026-10-01')).toBe('# Changelog\n\n## [0.1.0] - 2026-10-01\n\n### Changes\n\n- \n\n');
  });
  test('explicit bump kinds reset lower parts and drop prerelease suffixes', async () => {
    expect(bumpVersion('1.29.3', 'patch')).toBe('1.29.4');
    expect(bumpVersion('1.29.3', 'minor')).toBe('1.30.0');
    expect(bumpVersion('1.29.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.29.3-rc.1+build.2', 'patch')).toBe('1.29.4');
    for (const value of ['latest', '1.2.3garbage', '01.2.3', '1.2.3-01', '9007199254740992.0.0']) expect(() => bumpVersion(value, 'patch')).toThrow();
    expect(() => bumpVersion('9007199254740991.0.0', 'major')).toThrow();
  });
});

test('manifest replacement only touches the actual root version, preserving formatting and nested versions', async () => {
  const root = fixture();
  const text = readFileSync(join(root, 'package.json'), 'utf8');
  expect(rewriteManifestVersion(text, '2.0.0')).toBe(text.replace('"version": "1.29.3"', '"version": "2.0.0"'));
  expect(rewriteManifestVersion(text.replace('"version": "1.29.3"', '"ver\\u0073ion": "1.29.3"'), '2.0.0')).toContain('"ver\\u0073ion": "2.0.0"');
  for (const invalid of [text.replace('"version": "1.29.3"', '"version":"1.0.0", "version":"1.29.3"'), text.replace('"private":true', '"private":false'), text.replace('@goodvibes-jev/daemon', '@foreign/daemon')]) {
    expect(() => rewriteManifestVersion(invalid, '2.0.0')).toThrow();
  }
});

test('explicit exact preparation stamps all current surfaces, preserves notes and is repeat-idempotent', async () => {
  const root = fixture();
  const args = ['--version', '1.30.0', '--date', '2026-10-09'];
  expect(await prepareRelease(root, args)).toHaveLength(4);
  expect(() => checkBinaryVersion(root)).not.toThrow();
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('version-1.30.0-blue.svg');
  const before = snapshot(root);
  const times = PATHS.map((path) => statSync(join(root, path)).mtimeMs);
  expect(await prepareRelease(root, args)).toEqual([]);
  expect(snapshot(root)).toEqual(before);
  expect(PATHS.map((path) => statSync(join(root, path)).mtimeMs)).toEqual(times);
});

test('no-bump repairs fallback and badge without changing manifest; no-changelog never reads or creates notes', async () => {
  const root = fixture();
  const manifest = readFileSync(join(root, 'package.json'), 'utf8');
  writeFileSync(join(root, 'src/version.ts'), "let _version = '0.0.0';\n");
  writeFileSync(join(root, 'README.md'), 'version-0.0.0-blue.svg');
  unlinkSync(join(root, 'CHANGELOG.md'));
  expect(await prepareRelease(root, ['--no-bump', '--no-changelog'])).toHaveLength(2);
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
  expect(() => checkBinaryVersion(root)).not.toThrow();
  expect(() => statSync(join(root, 'CHANGELOG.md'))).toThrow();
  expect(await prepareRelease(root, ['--no-bump', '--no-changelog'])).toEqual([]);
});

test('no-bump can add notes; explicit bump can skip notes; no badge is preserved', async () => {
  const root = fixture();
  writeFileSync(join(root, 'README.md'), '# Private daemon\n');
  expect(await prepareRelease(root, ['--no-bump', '--date', '2026-10-09'])).toEqual([join(root, 'CHANGELOG.md')]);
  const notes = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  await prepareRelease(root, ['--patch', '--no-changelog']);
  expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toBe(notes);
  expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('# Private daemon\n');
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('1.29.4');
  checkBinaryVersion(root);
});

test('unknown, repeated, conflicting and missing flags/date refuse before mutation', async () => {
  const root = fixture(); const before = snapshot(root);
  for (const args of [[], ['--patch'], ['--version'], ['--version', '1.2.3junk', '--no-changelog'], ['--patch', '--minor', '--no-changelog'], ['--no-bump', '--no-bump', '--no-changelog'], ['--no-bump', '--no-changelog', '--no-changelog'], ['--no-bump', '--no-changelog', '--typo'], ['--no-bump', '--date', '2026-02-30'], ['--no-bump', '--date', '2026-10-09', '--no-changelog']]) {
    expect(() => parseArgs(args)).toThrow(); await expect(prepareRelease(root, args)).rejects.toThrow(); expect(snapshot(root)).toEqual(before);
  }
});

test('all surfaces validate before any write, including a missing changelog or malformed fallback', async () => {
  const root = fixture();
  for (const source of ['', "let _version = '1.0.0';\nlet _version = '2.0.0';\n"]) {
    writeFileSync(join(root, 'src/version.ts'), source);
    const before = snapshot(root);
    await expect(prepareRelease(root, ['--major', '--date', '2026-10-09'])).rejects.toThrow('fallback');
    expect(snapshot(root)).toEqual(before);
  }
  writeFileSync(join(root, 'src/version.ts'), "let _version = '1.29.3';\n");
  unlinkSync(join(root, 'CHANGELOG.md'));
  const before = PATHS.slice(0, 3).map((path) => readFileSync(join(root, path), 'utf8'));
  await expect(prepareRelease(root, ['--major', '--date', '2026-10-09'])).rejects.toThrow('Provide a product CHANGELOG.md');
  expect(PATHS.slice(0, 3).map((path) => readFileSync(join(root, path), 'utf8'))).toEqual(before);
});

test('partial write failure restores every attempted surface including the failed file', async () => {
  const root = fixture(); const before = snapshot(root); let calls = 0;
  await expect(prepareRelease(root, ['--major', '--date', '2026-10-09'], (path, text) => {
    if (++calls === 3) { writeFileSync(path, 'partial'); throw new Error('injected disk error'); }
    writeFileSync(path, text);
  })).rejects.toThrow('original files restored');
  expect(snapshot(root)).toEqual(before); checkBinaryVersion(root);
});

test('failed compensation is explicit and retains both causes', async () => {
  const root = fixture(); let calls = 0;
  try {
    await prepareRelease(root, ['--major', '--no-changelog'], (path, text) => {
      calls++;
      if (calls >= 2) throw new Error(`injected ${calls}`);
      writeFileSync(path, text);
    });
    throw new Error('expected preparation failure');
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain('restoration was incomplete');
    expect((error as AggregateError).errors).toHaveLength(3);
  }
});

test('CRLF notes retain line endings and an existing section stays byte-identical', async () => {
  const text = CHANGELOG.replaceAll('\n', '\r\n');
  const out = scaffoldChangelogText(text, '2.0.0', '2026-10-09');
  expect(out.replaceAll('\r\n', '')).not.toContain('\n');
  expect(scaffoldChangelogText(out, '2.0.0', '2026-10-10')).toBe(out);
});

test('actual CLI in a fixture prepares locally and refuses implicit default execution', async () => {
  const root = fixture(); mkdirSync(join(root, 'scripts'));
  const script = join(root, 'scripts/release-prepare.ts');
  copyFileSync(join(import.meta.dir, '../../../scripts/release-prepare.ts'), script);
  copyFileSync(join(import.meta.dir, '../../../scripts/build-preparation-lock.ts'), join(root, 'scripts/build-preparation-lock.ts'));
  const engine = dirname(createRequire(import.meta.url).resolve('@goodvibes-jev/engine/package.json'));
  mkdirSync(join(root, 'node_modules/@goodvibes-jev'), { recursive: true });
  symlinkSync(engine, join(root, 'node_modules/@goodvibes-jev/engine'), 'dir');
  const result = spawnSync(process.execPath, [script, '--version', '1.30.0', '--date', '2026-10-09'], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0); checkBinaryVersion(root);
  const before = snapshot(root);
  const invalid = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  expect(invalid.status).toBe(1); expect(invalid.stderr).toContain('Usage:'); expect(snapshot(root)).toEqual(before);
});

test('no-bump metadata badge stays stampable by the next explicit bump', async () => {
  for (const version of ['1.29.3+build.1', '1.29.3-rc.1+build.1']) {
    const root = fixture();
    const path = join(root, 'package.json');
    writeFileSync(path, rewriteManifestVersion(readFileSync(path, 'utf8'), version));
    await prepareRelease(root, ['--no-bump', '--no-changelog']);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain(`version-${version}-blue.svg`);
    checkBinaryVersion(root);
    await prepareRelease(root, ['--patch', '--no-changelog']);
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('version-1.29.4-blue.svg');
    checkBinaryVersion(root);
  }
});
