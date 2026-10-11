/**
 * Shared reclaim-on-startup helper for anything that puts its own working
 * directory straight under the real `os.tmpdir()` (a per-run test-tmp root,
 * a release-verify scratch registry, a native build's work directory) and
 * cannot guarantee it always gets to remove that directory itself: a signal
 * kill (Ctrl-C, a CI job timeout, `pkill`) skips `finally` blocks the same
 * way it skips `afterAll` hooks, so the directory is orphaned.
 *
 * The fix used across this repo (first in scripts/test.ts, for the run temp
 * root under `bun scripts/test.ts`) is the same shape every time: give the
 * directory a name that is unique to this run AND recognizable as this
 * tool's own, then have every entry point of that tool sweep for stale
 * siblings, same prefix, older than a threshold generous enough that it
 * never touches a run that is still actually going, before it creates its
 * own. Age-gated and prefix-scoped on purpose: a sibling run of the SAME
 * tool started moments ago, or an unrelated directory sharing the same
 * system temp dir, must never be touched. This is not a blanket `/tmp`
 * sweep, it only ever looks at entries starting with the caller's prefix.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, type Stats } from 'node:fs';
import { join } from 'node:path';

/**
 * Remove entries directly under `root` whose name starts with `prefix` and
 * whose mtime is older than `maxAgeMs`. Best-effort: a directory that
 * vanishes between listing and stat (another run reclaimed it first) or that
 * fails to remove is silently skipped, never thrown.
 * An optional preservation predicate can keep evidence the caller recognizes;
 * an inspection error also preserves that candidate rather than deleting it.
 */
export function sweepStaleTmpDirs(root: string, prefix: string, maxAgeMs: number, options: {
  readonly preserveMarker?: string;
  readonly preserve?: (directory: string) => boolean;
} = {}): void {
  if (!prefix || /[\\/\0]/.test(prefix) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('Invalid bounded sweep');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const now = Date.now();
  const inspect = (path: string): Stats | undefined => {
    try {
      const entry = lstatSync(path);
      if (!entry.isDirectory() || entry.isSymbolicLink() || existsSync(join(path, '.git'))
        || existsSync(join(path, '.retain')) || existsSync(join(path, '.keep-proof-output'))
        || (options.preserveMarker !== undefined && existsSync(join(path, options.preserveMarker)))) return undefined;
      if (prefix === 'goodvibes-sdk-testrun-' || prefix === 'goodvibes-test-heartbeat-') {
        const owner = JSON.parse(readFileSync(join(path, '.goodvibes-test-owner.json'), 'utf8')) as { version?: number; pid?: number; dev?: number; ino?: number };
        if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || owner.dev !== entry.dev || owner.ino !== entry.ino) return undefined;
        try { process.kill(owner.pid!, 0); return undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined; }
      }
      return entry;
    } catch { return undefined; }
  };
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const path = join(root, name);
    const admitted = inspect(path);
    if (!admitted || now - admitted.mtimeMs <= maxAgeMs) continue;
    try {
      if (options.preserve?.(path)) continue;
      // Inspectors may perform work, and another process can replace the path
      // or record retained evidence meanwhile. Never reuse an earlier grant
      // for a different inode or a newly live/retained/refreshed candidate.
      const current = inspect(path);
      if (!current || current.dev !== admitted.dev || current.ino !== admitted.ino
        || now - current.mtimeMs <= maxAgeMs) continue;
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best effort, including an inspector that throws or a vanished path.
    }
  }
}
