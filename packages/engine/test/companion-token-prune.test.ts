import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pruneStaleOperatorTokens } from '../sdk/src/platform/pairing/companion-token.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'companion-prune-'));
  roots.push(root);
  const daemonHomeDir = join(root, 'selected');
  const canonical = join(daemonHomeDir, 'operator-tokens.json');
  const candidate = join(root, 'workspace', 'operator-tokens.json');
  fs.mkdirSync(daemonHomeDir);
  fs.mkdirSync(dirname(candidate));
  fs.writeFileSync(canonical, 'synthetic-canonical');
  return { root, canonical, candidate, daemonHomeDir,
    prune: () => pruneStaleOperatorTokens({ daemonHomeDir, candidatePaths: [candidate] }) };
}

test('shared pruning removes only distinct files and skips duplicates, canonical spelling and missing paths', () => {
  const f = fixture();
  fs.writeFileSync(f.candidate, 'synthetic-stale');
  const missing = join(f.root, 'missing');
  const result = pruneStaleOperatorTokens({ daemonHomeDir: f.daemonHomeDir,
    candidatePaths: [f.canonical, f.candidate, f.candidate, missing] });
  expect(result).toEqual({ canonicalPath: f.canonical, prunedPaths: [f.candidate], failedPaths: [],
    skippedPaths: [f.canonical, missing] });
  expect(fs.readFileSync(f.canonical, 'utf8')).toBe('synthetic-canonical');
  expect(fs.existsSync(f.candidate)).toBe(false);
});

test('shared pruning retains a hard-link alias of the canonical inode', () => {
  const f = fixture();
  fs.linkSync(f.canonical, f.candidate);
  expect(f.prune()).toMatchObject({ prunedPaths: [], failedPaths: [], skippedPaths: [f.candidate] });
  expect(fs.statSync(f.candidate).ino).toBe(fs.statSync(f.canonical).ino);
  expect(fs.readFileSync(f.canonical, 'utf8')).toBe('synthetic-canonical');
});

for (const direction of ['canonical', 'candidate'] as const) {
  test(`shared pruning retains a ${direction} file symlink to the same token`, () => {
    const f = fixture();
    if (direction === 'canonical') fs.renameSync(f.canonical, f.candidate);
    fs.symlinkSync(direction === 'canonical' ? f.candidate : f.canonical,
      direction === 'canonical' ? f.canonical : f.candidate, 'file');
    expect(f.prune()).toMatchObject({ prunedPaths: [], failedPaths: [], skippedPaths: [f.candidate] });
    expect(fs.readFileSync(f.canonical, 'utf8')).toBe('synthetic-canonical');
    expect(fs.readFileSync(f.candidate, 'utf8')).toBe('synthetic-canonical');
  });
}

test('missing canonical identity preserves stale files and reports the failed cleanup', () => {
  const f = fixture();
  fs.writeFileSync(f.candidate, 'synthetic-stale');
  fs.unlinkSync(f.canonical);
  expect(f.prune()).toMatchObject({ prunedPaths: [], failedPaths: [f.candidate], skippedPaths: [] });
  expect(fs.readFileSync(f.candidate, 'utf8')).toBe('synthetic-stale');
});

test('unresolvable real identity preserves both files without exposing filesystem errors', () => {
  const f = fixture();
  fs.writeFileSync(f.candidate, 'synthetic-stale');
  const unavailableRealpath = Object.assign(() => { throw new Error('synthetic private lookup detail'); }, { native: fs.realpathSync.native });
  const lookup = spyOn(fs, 'realpathSync').mockImplementation(unavailableRealpath);
  try {
    expect(f.prune()).toMatchObject({ prunedPaths: [], failedPaths: [f.candidate], skippedPaths: [] });
  } finally { lookup.mockRestore(); }
  expect(fs.readFileSync(f.canonical, 'utf8')).toBe('synthetic-canonical');
  expect(fs.readFileSync(f.candidate, 'utf8')).toBe('synthetic-stale');
});

test('unavailable inode identity fails closed even when resolved pathnames differ', () => {
  const f = fixture();
  fs.writeFileSync(f.candidate, 'synthetic-stale');
  const unknown = fs.statSync(f.candidate, { bigint: true });
  Object.defineProperty(unknown, 'ino', { value: 0n });
  const lookup = spyOn(fs, 'statSync').mockReturnValueOnce(unknown);
  try {
    expect(f.prune()).toMatchObject({ prunedPaths: [], failedPaths: [f.candidate], skippedPaths: [] });
  } finally { lookup.mockRestore(); }
  expect(fs.readFileSync(f.canonical, 'utf8')).toBe('synthetic-canonical');
  expect(fs.readFileSync(f.candidate, 'utf8')).toBe('synthetic-stale');
});
