import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const releaseSharedPath = fileURLToPath(new URL('../scripts/release-shared.ts', import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Exercise the actual packStage child capture without running npm or changing the test process's PATH. */
function packFixture(output: string, exitCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'gv-npm-pack-output-'));
  tempDirs.push(dir);
  const stageDir = join(dir, 'stage');
  const destination = join(dir, 'packed');
  mkdirSync(stageDir);
  mkdirSync(destination);
  writeFileSync(join(dir, 'output.json'), output);
  writeFileSync(join(dir, 'npm'), [
    '#!/usr/bin/env node',
    "const { readFileSync, writeFileSync } = require('node:fs');",
    `if (process.cwd() !== ${JSON.stringify(stageDir)}) process.exit(91);`,
    `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['pack', '--json', '--pack-destination', destination]))}) process.exit(92);`,
    `writeFileSync(1, readFileSync(${JSON.stringify(join(dir, 'output.json'))}));`,
    `if (${exitCode}) writeFileSync(2, 'fixture pack failed');`,
    `process.exit(${exitCode});`,
    '',
  ].join('\n'), { mode: 0o755 });
  const script = [
    `import { collectTarballs, packStage } from ${JSON.stringify(releaseSharedPath)};`,
    'try {',
    `  const result = packStage(${JSON.stringify(stageDir)}, ${JSON.stringify(destination)});`,
    `  console.log(JSON.stringify({ filename: result.filename, tarballs: collectTarballs([result], ${JSON.stringify(destination)}) }));`,
    '} catch (error) {',
    '  console.log(JSON.stringify({ message: error.message, status: error.status, code: error.code, stderr: String(error.stderr) }));',
    '  process.exit(1);',
    '}',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--eval', script], {
    cwd: dir,
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  return { child, destination };
}

describe('npm pack child output', () => {
  test('a file listing larger than the default capture buffer retains the final tarball filename', () => {
    const filename = 'goodvibes-jev-engine-2.0.23.tgz';
    const files = Array.from({ length: 10_000 }, (_, index) => ({
      path: `sdk/dist/platform/${'long-package-path/'.repeat(6)}entry-${index}.js`,
      size: index,
      mode: 420,
    }));
    // The filename follows the entire listing, so truncated output cannot pass.
    const output = JSON.stringify([{ files, filename }]);
    expect(Buffer.byteLength(output)).toBeGreaterThan(1024 * 1024);

    const { child, destination } = packFixture(output);
    expect(JSON.parse(child.stdout)).toEqual({ filename, tarballs: [join(destination, filename)] });
    expect(child.status).toBe(0);
  });

  test('a failing pack still throws even when stdout contains a valid tarball result', () => {
    const { child } = packFixture(JSON.stringify([{ filename: 'should-not-be-used.tgz' }]), 42);
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout)).toMatchObject({ status: 42, stderr: 'fixture pack failed' });
  });

  test('malformed pack JSON still throws after the child exits successfully', () => {
    const { child } = packFixture('[{"filename":}]');
    expect(child.status).toBe(1);
    expect(JSON.parse(child.stdout).message).toContain('npm pack --json printed JSON that could not be parsed');
  });
});
