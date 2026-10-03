/**
 * Proves the suite's temp-directory lifetime actually works.
 *
 * Background: `bun test` does not run `process.on('exit', …)` listeners, so
 * every cleanup this suite had registered that way was dead code, and a fully
 * GREEN run over the 321 temp-touching test files left 1,649 directories in the
 * OS temp dir plus 60 under <repo>/.test-tmp. The replacement is (a) a
 * per-process temp sandbox that `tmpdir()` resolves into, and (b) a registry
 * swept from a top-level afterAll in the preload. These tests exercise both
 * halves, including cases proving each check can still answer NO.
 *
 * The sweep tests drive their OWN registry instance. Sweeping the shared one
 * mid-run would delete directories live test files are still using.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { outerTempDir, testTempSandbox } from './preload.ts';
import { createTempDirRegistry } from './temp-registry.ts';

describe('per-process temp sandbox', () => {
  test('tmpdir() resolves inside the sandbox, not the temp dir the process inherited', () => {
    const sandbox = testTempSandbox();
    expect(tmpdir()).toBe(sandbox);
    // A real, distinct directory UNDER the inherited temp dir, not the
    // inherited dir itself, which is what "redirected" has to mean.
    expect(existsSync(sandbox)).toBe(true);
    expect(sandbox).not.toBe(outerTempDir());
    expect(sandbox.startsWith(outerTempDir())).toBe(true);
  });

  test('the throwaway daemon home the preload creates is inside the sandbox', () => {
    // The preload creates GOODVIBES_DAEMON_HOME from tmpdir() AFTER redirecting
    // it, so the directory cannot land in the real /tmp. Stray
    // goodvibes-agent-test-daemon-home-* directories in a developer's /tmp come
    // from a checkout that predates the redirect, never from this one.
    const daemonHome = process.env['GOODVIBES_DAEMON_HOME'] ?? '';
    expect(daemonHome).not.toBe('');
    expect(daemonHome.startsWith(testTempSandbox())).toBe(true);
    // NO-proof: the assertion is a real prefix test, not one every string
    // satisfies, the pre-redirect location fails it.
    expect(join(outerTempDir(), 'goodvibes-agent-test-daemon-home-XXXXXX').startsWith(testTempSandbox())).toBe(false);
  });

  test('a directory made the ordinary way lands inside the sandbox', () => {
    const dir = mkdtempSync(join(tmpdir(), 'temp-registry-probe-'));
    try {
      expect(dir.startsWith(testTempSandbox())).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tracked temp directory sweep', () => {
  function makeDir(name: string): string {
    const dir = join(tmpdir(), `sweep-probe-${name}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'x', 'utf8');
    return dir;
  }

  test('sweeping removes every tracked directory and reports how many it had', () => {
    const registry = createTempDirRegistry();
    const a = registry.track(makeDir('a'));
    const b = registry.track(makeDir('b'));
    expect(registry.count()).toBe(2);

    expect(registry.sweep()).toBe(2);

    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    expect(registry.count()).toBe(0);
  });

  test('it removes ONLY tracked directories: an untracked sibling survives', () => {
    // NO-proof: without this, a "sweep" that simply emptied the whole temp dir
    // would satisfy the test above just as well, and "tracked" would mean
    // nothing.
    const registry = createTempDirRegistry();
    const tracked = registry.track(makeDir('tracked'));
    const untracked = makeDir('untracked');
    try {
      registry.sweep();
      expect(existsSync(tracked)).toBe(false);
      expect(existsSync(untracked)).toBe(true);
    } finally {
      rmSync(untracked, { recursive: true, force: true });
    }
  });

  test('a directory removed from the registry is then left alone', () => {
    // NO-proof: untrack genuinely takes the directory out of the sweep's reach
    // rather than being a no-op the sweep result hides.
    const registry = createTempDirRegistry();
    const dir = registry.track(makeDir('untrack'));
    registry.untrack(dir);
    try {
      expect(registry.sweep()).toBe(0);
      expect(existsSync(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sweeping an empty registry reports zero rather than claiming work', () => {
    // NO-proof: the returned count is a real count, so a caller asserting "the
    // sweep had something to do" cannot be satisfied by an empty registry.
    expect(createTempDirRegistry().sweep()).toBe(0);
  });

  test('a directory already removed by its own test does not break the sweep', () => {
    const registry = createTempDirRegistry();
    const dir = registry.track(makeDir('gone'));
    rmSync(dir, { recursive: true, force: true });
    expect(() => registry.sweep()).not.toThrow();
    expect(registry.count()).toBe(0);
  });

  test('the shared registry is a separate instance from a locally built one', () => {
    // NO-proof for the isolation these tests depend on: if createTempDirRegistry
    // returned the shared registry, every sweep above would have deleted
    // directories other test files are still using.
    const one = createTempDirRegistry();
    const two = createTempDirRegistry();
    one.track(join(tmpdir(), 'never-created-a'));
    expect(one.count()).toBe(1);
    expect(two.count()).toBe(0);
  });
});
