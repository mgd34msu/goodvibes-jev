/**
 * The test runner: `bun run test` (every file under src/ except the end-to-end
 * set) and `bun run test:changed` (only what a change since origin/main can
 * affect). CI runs `bun run test` once per push; locally, run the files you
 * touch and `test:changed`, never the whole suite.
 *
 *   bun run scripts/run-tests.ts [<path fragment>] [--changed[=<ref>]] [--timeout <ms>]
 *
 * A positional path fragment keeps only the test files whose path (relative to
 * the repo root) contains it: `bun run test src/test/input`, `bun run test
 * settings-modal`. `--changed=<ref>` hands the file set to Bun's own
 * `--changed` selection, which runs only the files whose import graph touches
 * something changed since <ref> (committed or not); a bare `--changed` uses
 * Bun's default base. The two combine.
 *
 * The end-to-end tests (src/test/e2e) drive the BUILT binary and run from their
 * own CI job after the build (`bun run test:e2e:fast`, `bun run
 * test:e2e:release`), never as part of this source run.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sweepProjectTestTmpRoot, sweepStaleRealTmpDirs } from './stale-tmp-sweep.ts';
import { filterTestFilesByPattern, parseChangedBase, parseTestPattern } from './test-pattern-rule.ts';

const ROOT = process.cwd();
const SEARCH_ROOT = join(ROOT, 'src');
const E2E_ROOT = join(SEARCH_ROOT, 'test', 'e2e');
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;
const TEST_TMP_ROOT = join(ROOT, '.test-suite-tmp');
const argv = process.argv.slice(2);
const PATTERN = parseTestPattern(argv);
const CHANGED_BASE = parseChangedBase(argv);

// Per-test ceiling. Bun's own default is 5 s, an idle machine's number; files
// here boot real stores, sockets and git. A ceiling, not a delay: only a stuck
// test waits it out. A test that needs another budget passes its own.
const TIMEOUT_MS = (() => {
  const flagIdx = argv.indexOf('--timeout');
  const fromFlag = flagIdx !== -1 ? Number(argv[flagIdx + 1]) : Number.NaN;
  const fromEquals = Number(argv.find((arg) => arg.startsWith('--timeout='))?.slice('--timeout='.length));
  const fromEnv = Number(process.env.GOODVIBES_TEST_TIMEOUT_MS);
  for (const value of [fromFlag, fromEquals, fromEnv]) {
    if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  }
  return 60_000;
})();

function collectTests(dir: string, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (fullPath === E2E_ROOT) continue;
      collectTests(fullPath, acc);
      continue;
    }
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      acc.push(fullPath);
    }
  }
}

const allTestFiles: string[] = [];
collectTests(SEARCH_ROOT, allTestFiles);
allTestFiles.sort((a, b) => a.localeCompare(b));
const testFiles = filterTestFilesByPattern(allTestFiles, ROOT, PATTERN);

// Sweep stale entries in .test-tmp (created by makeProjectTempDir in test
// helpers) and this project's own known-prefixed scratch directories in the
// real os.tmpdir() (see scripts/stale-tmp-sweep.ts). Both run before and after
// the suite so a killed run does not accumulate.
function sweepAll(): void {
  sweepProjectTestTmpRoot();
  const { swept, scanned } = sweepStaleRealTmpDirs();
  if (swept.length > 0) {
    console.log(`tmp-sweep: removed ${swept.length} stale director${swept.length === 1 ? 'y' : 'ies'} from os.tmpdir() (scanned ${scanned} entries).`);
  }
}

if (testFiles.length === 0) {
  console.error(PATTERN ? `No test files matched pattern: ${PATTERN}` : 'No test files found under src/');
  process.exit(1);
}

rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
mkdirSync(TEST_TMP_ROOT, { recursive: true });
sweepAll();

const selection = [
  PATTERN ? `pattern: ${PATTERN}` : '',
  CHANGED_BASE !== undefined ? `changed since ${CHANGED_BASE || "Bun's default base"}` : '',
].filter(Boolean).join(', ');
console.log(`Test files: ${testFiles.length}${selection ? ` (${selection})` : ''}`);

const bunArgs = ['bun', 'test', '--max-concurrency=1', `--timeout=${TIMEOUT_MS}`];
if (CHANGED_BASE !== undefined) bunArgs.push(CHANGED_BASE === '' ? '--changed' : `--changed=${CHANGED_BASE}`);
bunArgs.push(...testFiles);

let exitCode = 1;
try {
  const result = Bun.spawnSync(bunArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      TMPDIR: TEST_TMP_ROOT,
      TMP: TEST_TMP_ROOT,
      TEMP: TEST_TMP_ROOT,
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  exitCode = result.exitCode ?? 1;
} finally {
  rmSync(TEST_TMP_ROOT, { recursive: true, force: true });
  sweepAll();
}
process.exit(exitCode);
