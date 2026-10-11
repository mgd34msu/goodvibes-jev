import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleTmpDirs } from '../toolchain/src/test-runner/stale-tmp-sweep.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(prefix = 'observe-proof-scratch-') {
  const root = mkdtempSync(join(tmpdir(), 'sweep-revalidation-')); roots.push(root);
  const path = join(root, `${prefix}candidate`); mkdirSync(path);
  const marker = () => { const identity = lstatSync(path); writeFileSync(join(path, '.goodvibes-test-owner.json'), JSON.stringify({ version: 1, pid: 2147483647, dev: identity.dev, ino: identity.ino })); };
  const age = () => { const old = new Date(Date.now() - 120_000); utimesSync(path, old, old); };
  if (prefix === 'goodvibes-sdk-testrun-' || prefix === 'goodvibes-test-heartbeat-') marker(); age();
  return { root, path, prefix, marker, age };
}
for (const prefix of ['observe-proof-scratch-', 'goodvibes-sdk-testrun-', 'goodvibes-test-heartbeat-']) {
  test(`replacement directory survives preservation inspection (${prefix})`, () => {
    const f = fixture(prefix); const held = join(f.root, 'held-original');
    sweepStaleTmpDirs(f.root, prefix, 60_000, { preserve(path) {
      renameSync(path, held); mkdirSync(path); writeFileSync(join(path, 'foreign'), 'keep');
      if (prefix === 'goodvibes-sdk-testrun-' || prefix === 'goodvibes-test-heartbeat-') f.marker(); f.age(); return false;
    } });
    expect(readFileSync(join(f.path, 'foreign'), 'utf8')).toBe('keep'); expect(existsSync(held)).toBe(true);
  });
}
test('replacement symlink and its destination survive preservation inspection', () => {
  const f = fixture(); const target = join(f.root, 'foreign'); mkdirSync(target); writeFileSync(join(target, 'keep'), 'evidence');
  sweepStaleTmpDirs(f.root, f.prefix, 60_000, { preserve(path) { renameSync(path, join(f.root, 'held')); symlinkSync(target, path); return false; } });
  expect(lstatSync(f.path).isSymbolicLink()).toBe(true); expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('evidence');
});
for (const marker of ['.git', '.retain', '.keep-proof-output', 'custom-proof-marker']) {
  test(`newly recorded ${marker} evidence survives preservation inspection`, () => {
    const f = fixture();
    sweepStaleTmpDirs(f.root, f.prefix, 60_000, { preserveMarker: 'custom-proof-marker', preserve(path) { writeFileSync(join(path, marker), 'keep'); f.age(); return false; } });
    expect(readFileSync(join(f.path, marker), 'utf8')).toBe('keep');
  });
}
test('a now-live owner is preserved even when the directory identity and old mtime remain', () => {
  const f = fixture('goodvibes-sdk-testrun-');
  sweepStaleTmpDirs(f.root, f.prefix, 60_000, { preserve(path) {
    const identity = lstatSync(path); writeFileSync(join(path, '.goodvibes-test-owner.json'), JSON.stringify({ version: 1, pid: process.pid, dev: identity.dev, ino: identity.ino })); f.age(); return false;
  } });
  expect(existsSync(f.path)).toBe(true);
});
test('a refreshed candidate is no longer stale after preservation inspection', () => {
  const f = fixture();
  sweepStaleTmpDirs(f.root, f.prefix, 60_000, { preserve(path) { const now = new Date(); utimesSync(path, now, now); return false; } });
  expect(existsSync(f.path)).toBe(true);
});
test('unchanged stale candidate remains reclaimable after preservation inspection', () => {
  const f = fixture(); let inspected = 0;
  sweepStaleTmpDirs(f.root, f.prefix, 60_000, { preserve() { inspected++; return false; } });
  expect(inspected).toBe(1); expect(existsSync(f.path)).toBe(false);
});

for (const prefix of ['goodvibes-sdk-testrun-', 'goodvibes-test-heartbeat-']) {
  for (const mutation of ['missing', 'malformed', 'wrong-identity', 'live'] as const) {
    test(`changed ${mutation} ownership survives preservation inspection (${prefix})`, () => {
      const f = fixture(prefix);
      sweepStaleTmpDirs(f.root, prefix, 60_000, { preserve(path) {
        const marker = join(path, '.goodvibes-test-owner.json');
        if (mutation === 'missing') rmSync(marker);
        else if (mutation === 'malformed') writeFileSync(marker, '{');
        else {
          const identity = lstatSync(path);
          writeFileSync(marker, JSON.stringify({ version: 1,
            pid: mutation === 'live' ? process.pid : 2147483647,
            dev: identity.dev, ino: mutation === 'wrong-identity' ? identity.ino + 1 : identity.ino }));
        }
        f.age();
        return false;
      } });
      expect(existsSync(f.path)).toBe(true);
    });
  }
}
test('a throwing preservation inspector fails closed', () => {
  const f = fixture();
  expect(() => sweepStaleTmpDirs(f.root, f.prefix, 60_000, {
    preserve() { throw new Error('Cannot inspect evidence'); },
  })).not.toThrow();
  expect(existsSync(f.path)).toBe(true);
});
