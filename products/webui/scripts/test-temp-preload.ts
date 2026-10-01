/**
 * test-temp-preload, the bun test preload entry that performs the temp-directory
 * redirect described in scripts/test-temp-root.ts.
 *
 * This file exists SEPARATELY from test-temp-root.ts so the redirect is a
 * consequence of bunfig.toml preloading it, and of nothing else. When the sweep
 * and the redirect lived at the top of test-temp-root.ts, importing that module
 * (which its own test does) performed them, so the test asserting "os.tmpdir()
 * points inside the repo" passed even with the preload entry removed from
 * bunfig.toml. A guard that its subject cannot escape is not a guard.
 *
 * Runs first in bunfig.toml's [test] preload list, before src/test-setup.ts and
 * before any test module.
 */
import { installTestTempRoot, sweepStaleRunRoots } from './test-temp-root';

// Reap what runs that were killed left behind, then claim this run's own root.
// Order matters: the sweep only ever removes roots whose owning process is gone,
// so it can never touch the root the next line creates.
sweepStaleRunRoots();
installTestTempRoot();
