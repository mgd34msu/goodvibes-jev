import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { recordTuiCiArtifact, verifyTuiCiArtifact, type TuiArtifactSource } from '../../../scripts/ci-artifact.ts';

const source: TuiArtifactSource = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40) };
async function fixture(run: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'tui-ci-artifact-'));
  mkdirSync(join(root, 'dist/lib/sqlite-vec-linux-x64'), { recursive: true });
  writeFileSync(join(root, 'dist/goodvibes-linux-x64'), 'synthetic executable\n', { mode: 0o755 });
  writeFileSync(join(root, 'dist/lib/sqlite-vec-linux-x64/vec0.so'), 'synthetic native library\n', { mode: 0o644 });
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('a tar round trip preserves the exact source, binary, library and executable modes', () => fixture(async root => {
  await recordTuiCiArtifact(root, source);
  const manifest = JSON.parse(readFileSync(join(root, 'dist/ci-artifact.json'), 'utf8'));
  expect(manifest).toMatchObject({ schema: 1, ...source, target: 'linux-x64' });
  expect(manifest.files.map((file: { path: string; mode: number }) => [file.path, file.mode])).toEqual([
    ['goodvibes-linux-x64', 0o755], ['lib/sqlite-vec-linux-x64/vec0.so', 0o644],
  ]);
  const archive = join(root, 'output.tgz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'dist']);
  const restored = join(root, 'restored');
  mkdirSync(restored);
  execFileSync('tar', ['-xzf', archive, '-C', restored]);
  await expect(verifyTuiCiArtifact(restored, source)).resolves.toBeUndefined();
}));

for (const path of ['goodvibes-linux-x64', 'lib/sqlite-vec-linux-x64/vec0.so']) {
  test(`rejects changed payload bytes: ${path}`, () => fixture(async root => {
    await recordTuiCiArtifact(root, source);
    writeFileSync(join(root, 'dist', path), 'changed');
    await expect(verifyTuiCiArtifact(root, source)).rejects.toThrow('differs');
  }));
  test(`rejects symlink payload: ${path}`, () => fixture(async root => {
    const full = join(root, 'dist', path);
    rmSync(full);
    symlinkSync(join(root, 'elsewhere'), full);
    await expect(recordTuiCiArtifact(root, source)).rejects.toThrow('regular file');
  }));
}

for (const key of ['sourceCommit', 'sourceTree', 'headCommit'] as const) {
  test(`rejects a different ${key}`, () => fixture(async root => {
    await recordTuiCiArtifact(root, source);
    await expect(verifyTuiCiArtifact(root, { ...source, [key]: 'd'.repeat(40) })).rejects.toThrow('differs');
  }));
}

test('rejects lost execute mode, library mode changes, missing payloads and malformed source identity', () => fixture(async root => {
  await recordTuiCiArtifact(root, source);
  chmodSync(join(root, 'dist/goodvibes-linux-x64'), 0o644);
  await expect(verifyTuiCiArtifact(root, source)).rejects.toThrow('executable');
  chmodSync(join(root, 'dist/goodvibes-linux-x64'), 0o755);
  chmodSync(join(root, 'dist/lib/sqlite-vec-linux-x64/vec0.so'), 0o600);
  await expect(verifyTuiCiArtifact(root, source)).rejects.toThrow('differs');
  rmSync(join(root, 'dist/lib/sqlite-vec-linux-x64/vec0.so'));
  await expect(recordTuiCiArtifact(root, source)).rejects.toThrow();
  await expect(recordTuiCiArtifact(root, { ...source, sourceTree: 'HEAD' })).rejects.toThrow('exact Git');
}));

test('the CLI refuses another checkout or modified tracked source before recording provenance', () => fixture(async root => {
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/ci-artifact.ts'), readFileSync(resolve(import.meta.dir, '../../../scripts/ci-artifact.ts')));
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  writeFileSync(join(root, 'source.txt'), 'committed source\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'synthetic fixture');
  const revision = git('rev-parse', 'HEAD');
  const run = (expected: string) => execFileSync(process.execPath, ['scripts/ci-artifact.ts', 'record', expected, revision], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  expect(() => run('d'.repeat(40))).toThrow();
  expect(() => run(revision)).not.toThrow();
  const recorded = readFileSync(join(root, 'dist/ci-artifact.json'), 'utf8');
  expect(JSON.parse(recorded)).toMatchObject({ sourceCommit: revision, sourceTree: git('rev-parse', 'HEAD^{tree}'), headCommit: revision });
  writeFileSync(join(root, 'source.txt'), 'uncommitted replacement\n');
  expect(() => run(revision)).toThrow();
  expect(readFileSync(join(root, 'dist/ci-artifact.json'), 'utf8')).toBe(recorded);
}));

test('the native build foundation artifacts match their committed source before provenance recording', () => fixture(async root => {
  const { syncFoundationArtifacts } = await import('../../../scripts/project-surfaces.ts');
  syncFoundationArtifacts(root);
  const generated = join(root, 'docs/foundation-artifacts');
  const committed = resolve(import.meta.dir, '../../../docs/foundation-artifacts');
  const files = readdirSync(generated).sort();
  expect(files).toEqual(['knowledge-graphql.graphql', 'knowledge-store.sql', 'operator-contract.json', 'peer-contract.json']);
  for (const file of files) {
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    expect({ file, sha256: hash(join(committed, file)) }).toEqual({ file, sha256: hash(join(generated, file)) });
  }
}));

test('CI preserves the existing validation build and mandatorily archives its exact native payload', () => {
  const root = resolve(import.meta.dir, '../../../../..');
  const workflow = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as {
    jobs: { validate: { steps: Array<{ name: string; run?: string; if?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: boolean }> } };
  };
  const steps = workflow.jobs.validate.steps;
  const validate = steps.findIndex(step => step.name === 'Validate workspace');
  expect(steps[validate]!.run).toBe('bun run validate');
  const record = steps[validate + 1]!;
  const upload = steps[validate + 2]!;
  expect(record.name).toBe('Record TUI native artifact provenance');
  expect(record.if).toBe("hashFiles('products/tui/package.json') != ''");
  // The exact uploaded binary must pass the unchanged boot and namespace-read
  // guard before provenance can attest to it. Building alone is not a smoke.
  expect(record.run?.split('\n')[0]).toBe('bun run --cwd products/tui smoke:tui');
  expect(record.run).toContain('ci-artifact.ts record "$GITHUB_SHA" "$TUI_SOURCE_HEAD"');
  expect(record.run).toContain('ci-artifact.ts verify "$GITHUB_SHA" "$TUI_SOURCE_HEAD"');
  expect(record.run).toContain('products/tui/dist/goodvibes-linux-x64');
  expect(record.run).toContain('products/tui/dist/lib/sqlite-vec-linux-x64/vec0.so');
  expect(record.env?.TUI_SOURCE_HEAD).toBe('${{ github.event.pull_request.head.sha || github.sha }}');
  expect(record['continue-on-error']).toBeUndefined();
  expect(upload['continue-on-error']).toBeUndefined();
  expect(upload.if).toBe(record.if);
  expect(upload.uses).toBe('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02');
  expect(upload.with).toEqual({ name: 'tui-native-linux-x64', path: '/tmp/tui-native-linux-x64.tgz', 'retention-days': 7, 'if-no-files-found': 'error' });
});
