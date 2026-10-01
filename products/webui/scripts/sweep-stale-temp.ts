#!/usr/bin/env bun
/**
 * sweep-stale-temp.ts, CLI entry point for scripts/helpers/project-temp.ts's
 * sweepStaleProjectTempDirs. Wired as the `pretest` script (see package.json),
 * so it runs once before every `bun run test`, including the CI "Run tests"
 * step in .github/workflows/ci.yml, the CI "Coverage" step that follows
 * calls `bun test` directly (bypassing the pretest hook), but by then this
 * sweep has already run once for the job.
 *
 * Prints what it removed (if anything) and always exits 0, a sweep that can
 * fail the build is worse than a sweep that occasionally leaves a directory
 * for next time.
 */
import { sweepStaleProjectTempDirs } from './helpers/project-temp';

const removed = sweepStaleProjectTempDirs();
if (removed.length > 0) {
  process.stdout.write(
    `sweep-stale-temp: removed ${removed.length} stale scratch dir(s):\n${removed.map((p) => `  - ${p}`).join('\n')}\n`,
  );
} else {
  process.stdout.write('sweep-stale-temp: nothing stale to remove\n');
}
