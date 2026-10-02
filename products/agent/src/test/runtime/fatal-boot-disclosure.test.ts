/**
 * fatal-boot-disclosure.test.ts, the Agent says why it will not start.
 *
 * ── What happened ─────────────────────────────────────────────────────────
 *
 * A shipped GoodVibes daemon binary died mute on a fatal boot error: exit 1,
 * zero bytes on stdout, zero bytes on stderr, no activity log. It crash-looped
 * 77 times overnight and the only signal the operator had was that everything
 * had stopped.
 *
 * The Agent has its own route to the same silence, by a different mechanism.
 * `src/main.ts` installs a terminal output guard
 * (@goodvibes-jev/engine/terminal-shell's terminal output guard) that REPLACES `process.stdout.write`,
 * `process.stderr.write` and every `console` method so stray output cannot
 * corrupt a rendered screen, an intercepted write is recorded to the activity
 * log and swallowed. `reportFatalStartupError` was handed
 * `(chunk) => process.stderr.write(chunk)` as its sink, so any startup failure
 * raised after that install had its explanation intercepted and never reached a
 * descriptor.
 *
 * ── Why this test compiles ────────────────────────────────────────────────
 *
 * Because a source-level test provably cannot catch this class. Under `bun` the
 * identical source prints loudly; only the artifact that ships goes quiet. So
 * everything below builds a real binary with `bun build --compile`, mirroring
 * the argv the release lane uses (`toolchain.config.json` → `build.appEntrypoint`
 * plus `build:linux-x64` in package.json), runs it against a throwaway HOME
 * forced into a fatal boot, and counts the bytes that reached the descriptor.
 *
 * The three artifacts are compiled and torn down one describe at a time so at
 * most one ~160 MiB binary exists on disk at once.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeLongLivedProjectTempDir, makeProjectTempDir } from '../helpers/project-temp.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const COMPILE_TIMEOUT_MS = 300_000;
const RUN_TIMEOUT_MS = 60_000;

/**
 * A throwaway HOME for ONE test, under `<repo>/.test-tmp` (the repo's own test
 * scratch root, see helpers/project-temp.ts). The global afterEach sweeps it
 * as soon as the test that made it finishes.
 */
function makeHomeDir(label: string): string {
  const home = makeProjectTempDir(`gv-fatal-${label}`);
  mkdirSync(join(home, 'work'), { recursive: true });
  return home;
}

interface CompiledEntry {
  readonly binary: string;
  readonly dir: string;
}

/**
 * Compile one entry the way the release lane does.
 *
 * The compile driver applies the same in-memory compatibility transforms as
 * the production binary build; without it a compiled artifact dies at module
 * init on `css-tree`'s `createRequire` of `../data/patch.json`, long before any
 * code under test runs.
 */
function compileEntry(entry: string, name: string): CompiledEntry {
  // Long-lived on purpose: a binary compiled in beforeAll has to outlive every
  // test in its describe, and the ordinary per-test sweep would delete it after
  // the first one. Each describe still removes its own directory in afterAll.
  const dir = makeLongLivedProjectTempDir(`gv-fatal-${name}`);
  const binary = join(dir, name);
  const built = spawnSync(
    process.execPath,
    ['scripts/compile.ts', entry, '--compile', '--target=bun-linux-x64', '--outfile', binary],
    { cwd: REPO_ROOT, encoding: 'utf-8', timeout: COMPILE_TIMEOUT_MS },
  );
  if (built.status !== 0) {
    throw new Error(`compiling ${entry} failed (${String(built.status)}): ${built.stderr ?? ''}`);
  }
  return { binary, dir };
}

interface AgentRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a compiled entry against a throwaway HOME.
 *
 * The environment is built from nothing, `PATH`, `HOME`, `GOODVIBES_WORKING_DIR`
 * and nothing else, so no ambient `GOODVIBES_*` from a developer's shell can
 * decide the outcome. stdin/stdout are pipes, never a TTY.
 */
function runAgent(binary: string, home: string, args: readonly string[] = []): AgentRun {
  const result = spawnSync(binary, [...args], {
    encoding: 'utf-8',
    timeout: RUN_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: home,
      GOODVIBES_WORKING_DIR: join(home, 'work'),
    },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A throwaway HOME whose Agent settings file is unparseable. */
function homeWithCorruptSettings(label: string): { readonly home: string; readonly settingsPath: string } {
  const home = makeHomeDir(label);
  mkdirSync(join(home, '.goodvibes', 'agent'), { recursive: true });
  const settingsPath = join(home, '.goodvibes', 'agent', 'settings.json');
  writeFileSync(settingsPath, '{ "provider": { "model": "anthropic/claude" ', 'utf-8');
  return { home, settingsPath };
}

// ---------------------------------------------------------------------------
// The artifact that actually ships
// ---------------------------------------------------------------------------

describe('the compiled Agent binary says why it will not start', () => {
  let entry: CompiledEntry;
  beforeAll(() => { entry = compileEntry('src/main.ts', 'agent'); });
  afterAll(() => { rmSync(entry.dir, { recursive: true, force: true }); });

  test('an unparseable settings file names the file and the parse error on stderr', () => {
    const { home, settingsPath } = homeWithCorruptSettings('corrupt-home');
    const run = runAgent(entry.binary, home);
    expect(run.status).toBe(1);
    expect(run.stderr.length).toBeGreaterThan(0);
    expect(run.stderr).toContain('goodvibes-agent failed to launch');
    expect(run.stderr).toContain(settingsPath);
    expect(run.stderr).toContain('JSON Parse error');
  });

  test('the fatal boot failure is reached, not the interactive-terminal refusal', () => {
    // Without this the test would prove nothing: main.ts refuses a non-TTY with
    // its own message and exit 2, and that refusal happens AFTER the config
    // load. If the ordering ever changes, this catches it.
    const { home } = homeWithCorruptSettings('ordering-home');
    const run = runAgent(entry.binary, home);
    expect(run.stderr).not.toContain('requires an interactive terminal');
    expect(run.status).not.toBe(2);
  });

  test('the interactive-terminal refusal itself still reaches the descriptor', () => {
    // The other early exit main.ts makes before any renderer exists; it also
    // writes to fd 2 now, and a readable settings file is what lets it happen.
    const home = makeHomeDir('tty-home');
    const run = runAgent(entry.binary, home);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('requires an interactive terminal');
  });

  test('--version and --help print to stdout and exit 0', () => {
    // Both write through writeExitingStdoutLine and exit immediately, which is
    // the same in-flight-stream race as the fatal path.
    const home = makeHomeDir('help-home');
    const version = runAgent(entry.binary, home, ['--version']);
    expect(version.status).toBe(0);
    expect(version.stdout).toContain('goodvibes-agent ');

    const help = runAgent(entry.binary, home, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The mute path: a fatal failure raised with the output guard installed
// ---------------------------------------------------------------------------

describe('the shape that shipped writes NOTHING once the output guard is on', () => {
  let entry: CompiledEntry;
  beforeAll(() => { entry = compileEntry('src/test/fixtures/fatal-boot-guarded-legacy-entry.ts', 'agent-legacy'); });
  afterAll(() => { rmSync(entry.dir, { recursive: true, force: true }); });

  test('exit 1, zero bytes on stdout, zero bytes on stderr: the baseline', () => {
    // Not an assumption about how a compiled binary flushes. The reporter runs,
    // the logger has a destination and works, and the reason still reaches
    // nobody, because the guard replaced the stream this sink writes to.
    const home = makeHomeDir('legacy-home');
    const run = runAgent(entry.binary, home);
    expect(run.status).toBe(1);
    expect(run.stdout).toHaveLength(0);
    expect(run.stderr).toHaveLength(0);
  });
});

describe('the descriptor sink survives the output guard', () => {
  let entry: CompiledEntry;
  beforeAll(() => { entry = compileEntry('src/test/fixtures/fatal-boot-guarded-entry.ts', 'agent-fixed'); });
  afterAll(() => { rmSync(entry.dir, { recursive: true, force: true }); });

  test('the same failure, the same guard, and the reason reaches stderr', () => {
    const home = makeHomeDir('fixed-home');
    const run = runAgent(entry.binary, home);
    expect(run.status).toBe(1);
    expect(run.stderr.length).toBeGreaterThan(0);
    expect(run.stderr).toContain('goodvibes-agent failed to launch');
    expect(run.stderr).toContain('JSON Parse error');
    expect(run.stderr).toContain(join(home, 'work', 'settings.json'));
  });
});
