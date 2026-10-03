/**
 * Registry of temp directories the suite created outside the OS temp sandbox.
 *
 * Why this exists: `bun test` does NOT run `process.on('exit', …)` listeners.
 * Verified directly, an exit listener registered in the test preload never
 * fires under `bun test`, while the same listener does fire under `bun run`,
 * both on normal termination and after an uncaught throw. Every temp-dir
 * cleanup in this suite that was registered that way was therefore dead code,
 * and a fully GREEN run left its directories behind.
 *
 * The replacement is a hook bun does run: a top-level `afterAll` in
 * src/test/helpers/preload.ts, which fires exactly once after the last test
 * file, whether the run passed or failed. Helpers register their directories
 * with the shared registry below; the preload sweeps it.
 *
 * Register at the point of creation. Do NOT register an `afterAll` from inside
 * a helper function, a hook attached lazily during a run does not reliably
 * attach to the enclosing scope.
 */
import { rmSync } from 'node:fs';

export interface TempDirRegistry {
  /** Track `dir` for end-of-run removal and return it unchanged. */
  track(dir: string): string;
  /** Stop tracking `dir` (for a helper that already removed it itself). */
  untrack(dir: string): void;
  /** How many directories are currently tracked. */
  count(): number;
  /**
   * Remove every tracked directory and clear the registry. Returns how many
   * were tracked, so a caller can assert the sweep had something to do.
   */
  sweep(): number;
}

/**
 * A registry instance. The suite shares one (below); tests of the sweep itself
 * build their own so they never wipe directories a live test file is using.
 */
export function createTempDirRegistry(): TempDirRegistry {
  const trackedDirs = new Set<string>();
  return {
    track(dir: string): string {
      trackedDirs.add(dir);
      return dir;
    },
    untrack(dir: string): void {
      trackedDirs.delete(dir);
    },
    count(): number {
      return trackedDirs.size;
    },
    sweep(): number {
      const total = trackedDirs.size;
      for (const dir of trackedDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // A directory already removed by its own test is not an error.
        }
      }
      trackedDirs.clear();
      return total;
    },
  };
}

/** The registry the preload sweeps at end of run. */
const sharedRegistry = createTempDirRegistry();

/** Track `dir` for end-of-run removal and return it unchanged. */
export function trackTempDir(dir: string): string {
  return sharedRegistry.track(dir);
}

/** Stop tracking `dir` (for a helper that already removed it itself). */
export function untrackTempDir(dir: string): void {
  sharedRegistry.untrack(dir);
}

/** Number of directories currently tracked by the shared registry. */
export function trackedTempDirCount(): number {
  return sharedRegistry.count();
}

/** Remove every directory the shared registry tracks. Returns how many. */
export function sweepTrackedTempDirs(): number {
  return sharedRegistry.sweep();
}
